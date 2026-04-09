/**
 * Execute RouterOS CLI commands via the REST /execute endpoint.
 *
 * POST /rest/execute  { "script": "<cli-command>", "as-string": "" }
 *
 * RouterOS 7.1+ exposes this endpoint as a universal command runner.
 * The `as-string` parameter makes execution synchronous — without it,
 * RouterOS runs the command in the background and returns a job ID
 * (e.g. {"ret":"*5"}) instead of actual output.
 *
 * The 60-second server-side timeout applies; callers can set a shorter
 * client-side timeout via AbortSignal.
 */

import type { ExecOptions, ExecResult, ExecTransport } from "./types.ts";
import { QuickCHRError } from "./types.ts";
import type { ResolvedAuth } from "./auth.ts";

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
	const response = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: auth.header,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ script: command, "as-string": "" }),
		signal: AbortSignal.timeout(timeout),
	});

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new QuickCHRError(
			"EXEC_FAILED",
			`exec failed (HTTP ${response.status}): ${body || response.statusText}`,
		);
	}

	const ct = response.headers.get("content-type") || "";
	let output: string;

	if (ct.includes("application/json")) {
		const json = await response.json();
		output = extractRetValue(json);
	} else {
		output = await response.text();
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
