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

import { request as nodeRequest } from "node:http";

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
	const bodyStr = JSON.stringify({ script: command, "as-string": true });

	// node:http with agent:false — creates a fresh TCP connection per call,
	// bypassing Bun's global connection pool to avoid RouterOS returning
	// stale session data from a reused provisioning connection.
	const { status, ct, data } = await new Promise<{ status: number; ct: string; data: string }>((resolve, reject) => {
		const parsed = new URL(url);
		const bodyBuf = Buffer.from(bodyStr, "utf-8");
		const timer = setTimeout(() => req.destroy(new Error(`exec timed out after ${timeout}ms`)), timeout);

		const req = nodeRequest({
			hostname: parsed.hostname,
			port: Number(parsed.port) || 80,
			path: parsed.pathname,
			method: "POST",
			headers: {
				Authorization: auth.header,
				"Content-Type": "application/json",
				"Content-Length": bodyBuf.length,
			},
			agent: false,
		}, (res) => {
			clearTimeout(timer);
			const chunks: Buffer[] = [];
			res.on("data", (c: Buffer) => chunks.push(c));
			res.on("end", () => resolve({
				status: res.statusCode ?? 0,
				ct: (res.headers["content-type"] as string) ?? "",
				data: Buffer.concat(chunks).toString("utf-8"),
			}));
			res.on("error", reject);
		});
		req.on("error", (e) => { clearTimeout(timer); reject(e); });
		req.write(bodyBuf);
		req.end();
	});

	if (status < 200 || status >= 300) {
		throw new QuickCHRError(
			"EXEC_FAILED",
			`exec failed (HTTP ${status}): ${data || "unknown error"}`,
		);
	}

	let output: string;

	if (ct.includes("application/json")) {
		const json = JSON.parse(data);
		output = extractRetValue(json);
	} else {
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
