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
		throw new QuickCHRError(
			"EXEC_FAILED",
			`exec timed out or failed: ${e instanceof Error ? e.message : String(e)}`,
		);
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
