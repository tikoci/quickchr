/**
 * Execute RouterOS CLI commands via the REST /execute endpoint.
 *
 * POST /rest/execute  { "script": "<cli-command>", "as-string": true }
 *
 * RouterOS 7.1+ exposes this endpoint as a universal command runner.
 * `as-string` controls fg/bg mode: the **presence** of the key (with any
 * value — true, false, "", "false") makes it synchronous (fg) and returns
 * {"ret":"<output>"}. When the key is absent entirely, RouterOS runs the
 * script in the background and returns a job ID (e.g. {"ret":"*B70A"}).
 *
 * The 60-second server-side timeout applies; callers can set a shorter
 * client-side timeout via AbortSignal.
 *
 * Uses node:http with agent:false (no connection pooling). Bun's fetch
 * pools TCP connections by host:port; RouterOS may return stale session
 * data on a reused connection immediately after provisioning (SSH key
 * install leaves state on the connection the verification loop used).
 */

import type { ExecOptions, ExecResult, ExecTransport } from "./types.ts";
import { QuickCHRError } from "./types.ts";
import type { ResolvedAuth } from "./auth.ts";
import { restPost } from "./rest.ts";

/** Default client-side timeout for exec requests (ms). */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Execute a RouterOS CLI command via POST /rest/execute.
 *
 * The command is passed through as-is — no wrapping or transformation.
 * If you need structured JSON output, wrap the command yourself:
 *   `:put [:serialize to=json [/system/resource/print]]`
 *
 * @param restUrl  Base URL of the CHR REST API, e.g. "http://127.0.0.1:9100"
 * @param auth     Resolved credentials (from resolveAuth).
 * @param command  RouterOS CLI command string, e.g. "/system/resource/print"
 * @param opts     Optional exec settings (timeout).
 * @returns        ExecResult with output text and transport used.
 */
export async function restExecute(
	restUrl: string,
	auth: ResolvedAuth,
	command: string,
	opts?: Pick<ExecOptions, "timeout">,
): Promise<ExecResult> {
	const timeout = opts?.timeout ?? DEFAULT_TIMEOUT_MS;
	const url = `${restUrl}/rest/execute`;

	let status: number;
	let data: string;
	try {
		const resp = await restPost(url, auth.header, { script: command, "as-string": true }, timeout);
		status = resp.status;
		data = resp.body;
	} catch (e) {
		const err = new QuickCHRError(
			"EXEC_FAILED",
			`exec timed out or failed: ${e instanceof Error ? e.message : String(e)}`,
		);
		// Preserve the transport failure for callers that ride out resets (the
		// auto transport). HTTP errors below never carry a cause: a response —
		// even a 401 or 500 — is an answer, not a transient.
		err.cause = e;
		throw err;
	}

	if (status < 200 || status >= 300) {
		throw new QuickCHRError(
			"EXEC_FAILED",
			`exec failed (HTTP ${status}): ${data || "unknown error"}`,
		);
	}

	let output: string;
	try {
		const json = JSON.parse(data);
		output = extractRetValue(json);
	} catch {
		// Non-JSON response — return raw text
		output = data;
	}

	return { output, via: "rest" as ExecTransport };
}

/**
 * True when an exec failure was a connection-level transport failure — the
 * request got no HTTP response at all (reset, refused, timeout) — rather than
 * an HTTP error or command failure. Only transport failures are ever retried
 * or fall back to another transport.
 */
export function isExecTransportFailure(e: unknown): boolean {
	return e instanceof QuickCHRError && e.code === "EXEC_FAILED" && e.cause instanceof Error;
}

function isTransportReset(e: unknown): boolean {
	return (
		isExecTransportFailure(e) &&
		((e as QuickCHRError).cause as { code?: unknown }).code === "ECONNRESET"
	);
}

/**
 * Execute via REST, riding out the brief post-boot window in which RouterOS
 * resets connections that arrive before www is fully settled — the same
 * transient `ChrInstance.rest()` already retries (3 attempts, 2 s backoff),
 * and the shape behind #135's first-exec-after-boot failure and #69's
 * first-request resets on linux-arm64.
 *
 * Only connection resets are retried, and only when no HTTP response was
 * received. HTTP errors, auth failures, and timeouts throw immediately: a
 * response is an answer, and a timeout means the server may still be running
 * the script, so replaying it could double-execute a non-idempotent command.
 *
 * This is the auto transport's REST attempt, not a general policy:
 * `via: "rest"` still sends exactly once (guest shutdown depends on
 * no-replay), and the auto path falls back to console when REST stays
 * unreachable after the retries.
 */
export async function restExecuteWithRetry(
	restUrl: string,
	auth: ResolvedAuth,
	command: string,
	opts?: Pick<ExecOptions, "timeout"> & { retries?: number; retryDelayMs?: number },
): Promise<ExecResult> {
	const maxRetries = opts?.retries ?? 3;
	const delayMs = opts?.retryDelayMs ?? 2000;
	for (let attempt = 0; ; attempt++) {
		try {
			return await restExecute(restUrl, auth, command, opts);
		} catch (e) {
			if (attempt >= maxRetries || !isTransportReset(e)) throw e;
			console.warn(`exec: ECONNRESET on REST attempt ${attempt + 1}, retrying...`);
			await Bun.sleep(delayMs);
		}
	}
}

/**
 * Extract the output string from an /execute response.
 *
 * With `as-string`, RouterOS always returns { "ret": "<output>" } for
 * commands that produce output, or [] for void commands (e.g. /log/info).
 */
function extractRetValue(json: unknown): string {
	if (Array.isArray(json)) {
		if (json.length === 0) return "";
		return JSON.stringify(json);
	}
	if (typeof json === "object" && json !== null) {
		const obj = json as Record<string, unknown>;
		if ("ret" in obj) return String(obj.ret);
		if ("message" in obj) return String(obj.message);
		return JSON.stringify(obj);
	}
	return String(json);
}
