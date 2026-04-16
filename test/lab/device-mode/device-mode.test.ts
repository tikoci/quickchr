/**
 * Lab: /system/device-mode — Full Behavior Documentation
 *
 * Tested: CHR 7.22.1 (x86_64) on Intel Mac, HVF acceleration
 * Date: 2026-04-16
 *
 * RUN: bun test test/lab/device-mode.test.ts  (run ALONE — not with other lab files)
 * Bun's test runner parallelism causes device-mode REST to hang when run
 * alongside package tests that call check-for-updates or enable/disable.
 * This is NOT a quickchr bug — it's a bun test runner + RouterOS interaction.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * KEY FINDINGS
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 1. GET /rest/system/device-mode returns a flat JSON object with ALL
 *    feature flags as string booleans ("true"/"false") plus mode, flagged,
 *    flagging-enabled, attempt-count, allowed-versions, routerboard.
 *
 * 2. POST /rest/system/device-mode/update ALWAYS BLOCKS — even for no-op
 *    updates where nothing actually changes (same mode, same features).
 *    Default block time: 5 minutes. Returns no response until
 *    power-cycle confirms or activation-timeout expires.
 *
 * 3. activation-timeout parameter (min 10s, max 1d):
 *    - With activation-timeout: blocks for that duration, then returns
 *      HTTP 400 {"detail":"update canceled"} and RouterOS resumes.
 *    - Without: blocks for default 5 minutes, same cancel behavior.
 *    - Power-cycle within the window → change applied, attempt-count resets to 0.
 *
 * 4. attempt-count increments on EVERY update attempt (including canceled
 *    ones via activation-timeout). Resets to 0 only on successful
 *    power-cycle confirmation. Tested up to count=12 without hitting
 *    any REST-visible limit — the "3 attempts" limit from docs may only
 *    manifest on CLI/hardware button path, not REST+power-cycle.
 *
 * 5. flagged is set by RouterOS configuration analysis (suspicious code
 *    detection at boot), NOT by attempt-count. Independent mechanism.
 *    Clear with: POST update flagged=no + power-cycle.
 *
 * 6. Error responses are immediate (no blocking):
 *    - Invalid mode: 400 {"detail":"input does not match any value of mode"}
 *    - Unknown param: 400 {"detail":"unknown parameter nonexistent"}
 *    - Bad timeout:  400 {"detail":"value of activation-timeout is out of range (00:00:10 .. 1d00:00:00)"}
 *    - Empty body {} still blocks (treated as no-op update).
 *
 * 7. The /rest/execute path also blocks for device-mode/update commands.
 *    as-string="" doesn't help — the command itself is blocking.
 *
 * 8. SSH path blocks identically (tested via BatchMode=yes).
 *
 * 9. While device-mode/update is blocking, ALL REST endpoints become
 *    unresponsive — not just device-mode. The entire HTTP server stalls.
 *
 * 10. .proplist query parameter works: GET /rest/system/device-mode?.proplist=mode,container
 *     returns only the requested fields.
 *
 * 11. /rest/system/device-mode/print returns 500 Internal Server Error
 *     (singleton resources don't support /print via REST).
 *
 * RECOMMENDED PATTERN FOR QUICKCHR:
 *   POST /rest/system/device-mode/update with activation-timeout=30s
 *   → Sleep 2s → QEMU monitor system_reset (hard power-cycle)
 *   → Wait for boot → Verify change applied
 *   → attempt-count should be 0 on success
 *
 * ═══════════════════════════════════════════════════════════════════════
 * RAW RESPONSE SHAPES
 * ═══════════════════════════════════════════════════════════════════════
 *
 * GET /rest/system/device-mode (fresh CHR 7.22.1):
 * {
 *   "allowed-versions": "7.13+,6.49.8+",
 *   "attempt-count": "0",
 *   "bandwidth-test": "true",
 *   "container": "false",
 *   "email": "true",
 *   "fetch": "true",
 *   "flagged": "false",
 *   "flagging-enabled": "true",
 *   "hotspot": "true",
 *   "install-any-version": "false",
 *   "ipsec": "true",
 *   "l2tp": "true",
 *   "mode": "advanced",
 *   "partitions": "false",
 *   "pptp": "true",
 *   "proxy": "true",
 *   "romon": "true",
 *   "routerboard": "false",
 *   "scheduler": "true",
 *   "smb": "true",
 *   "sniffer": "true",
 *   "socks": "true",
 *   "traffic-gen": "false",
 *   "zerotier": "true"
 * }
 *
 * POST activation-timeout expired (no power-cycle):
 *   HTTP 400 {"detail":"update canceled","error":400,"message":"Bad Request"}
 *
 * POST invalid mode:
 *   HTTP 400 {"detail":"input does not match any value of mode","error":400,"message":"Bad Request"}
 *
 * POST unknown parameter:
 *   HTTP 400 {"detail":"unknown parameter nonexistent","error":400,"message":"Bad Request"}
 *
 * POST bad timeout:
 *   HTTP 400 {"detail":"value of activation-timeout is out of range (00:00:10 .. 1d00:00:00)","error":400,"message":"Bad Request"}
 *
 * Via /rest/execute (as-string=""):
 *   {"ret": "                 mode: advanced     \r\n     allowed-versions: 7.13+,6.49.8+\r\n              flagged: no           \r\n     ..."}
 *
 * Via SSH (/system/device-mode/print):
 *   Plain text key-value pairs, padded with spaces for alignment.
 *
 * ═══════════════════════════════════════════════════════════════════════
 */

import { describe, test, expect } from "bun:test";

const CHR_PORT = 9100;
const AUTH = `Basic ${btoa("admin:")}`;

/**
 * Use node:http + agent:false for device-mode tests.
 * FINDING: Bun's fetch() pool causes device-mode GET to hang when run
 * after package tests in the same bun test process. This is a real
 * manifestation of the connection pool bug — the pool apparently holds
 * connections that interfere with the long-running device-mode endpoint.
 * curl and node:http with agent:false work fine in the same scenario.
 */
import { request as nodeRequest } from "node:http";

function nodeGet(
	path: string,
	timeoutMs = 5_000,
): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		let done = false;
		const parsed = new URL(`http://127.0.0.1:${CHR_PORT}${path}`);
		const req = nodeRequest(
			{
				hostname: parsed.hostname,
				port: parsed.port,
				path: parsed.pathname + parsed.search,
				method: "GET",
				headers: { Authorization: AUTH },
				agent: false,
			},
			(res) => {
				let body = "";
				res.on("data", (chunk: Buffer) => {
					body += chunk.toString();
				});
				res.on("end", () => {
					if (!done) {
						done = true;
						resolve({ status: res.statusCode ?? 0, body });
					}
				});
				res.on("error", (e) => {
					if (!done) {
						done = true;
						reject(e);
					}
				});
			},
		);
		const timer = setTimeout(() => {
			if (!done) {
				done = true;
				req.destroy();
				reject(new Error("timeout"));
			}
		}, timeoutMs);
		req.on("error", (e) => {
			clearTimeout(timer);
			if (!done) {
				done = true;
				reject(e);
			}
		});
		req.on("close", () => clearTimeout(timer));
		req.end();
	});
}

function nodePost(
	path: string,
	body: Record<string, unknown>,
	timeoutMs = 5_000,
): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		let done = false;
		const payload = JSON.stringify(body);
		const req = nodeRequest(
			{
				hostname: "127.0.0.1",
				port: CHR_PORT,
				path,
				method: "POST",
				headers: {
					Authorization: AUTH,
					"Content-Type": "application/json",
					"Content-Length": Buffer.byteLength(payload),
				},
				agent: false,
			},
			(res) => {
				let respBody = "";
				res.on("data", (chunk: Buffer) => {
					respBody += chunk.toString();
				});
				res.on("end", () => {
					if (!done) {
						done = true;
						resolve({ status: res.statusCode ?? 0, body: respBody });
					}
				});
				res.on("error", (e) => {
					if (!done) {
						done = true;
						reject(e);
					}
				});
			},
		);
		const timer = setTimeout(() => {
			if (!done) {
				done = true;
				req.destroy();
				reject(new Error("timeout"));
			}
		}, timeoutMs);
		req.on("error", (e) => {
			clearTimeout(timer);
			if (!done) {
				done = true;
				reject(e);
			}
		});
		req.on("close", () => clearTimeout(timer));
		req.write(payload);
		req.end();
	});
}

describe.skipIf(!process.env.QUICKCHR_INTEGRATION)(
	"Lab: /system/device-mode",
	() => {
		test("GET baseline — all attributes present", async () => {
			const { status, body } = await nodeGet("/rest/system/device-mode");
			expect(status).toBe(200);

			const data = JSON.parse(body);
			console.log("[device-mode GET]", JSON.stringify(data, null, 2));

			// Verify all expected keys
			const expectedKeys = [
				"mode",
				"allowed-versions",
				"flagged",
				"flagging-enabled",
				"attempt-count",
				"scheduler",
				"socks",
				"fetch",
				"pptp",
				"l2tp",
				"bandwidth-test",
				"traffic-gen",
				"sniffer",
				"ipsec",
				"romon",
				"proxy",
				"hotspot",
				"smb",
				"email",
				"zerotier",
				"container",
				"install-any-version",
				"partitions",
				"routerboard",
			];
			for (const key of expectedKeys) {
				expect(data).toHaveProperty(key);
			}

			// All feature flags are string "true" or "false"
			const boolKeys = expectedKeys.filter(
				(k) =>
					!["mode", "allowed-versions", "attempt-count"].includes(k),
			);
			for (const key of boolKeys) {
				expect(["true", "false"]).toContain(data[key]);
			}

			expect(data.mode).toBe("advanced"); // default CHR mode
			expect(typeof data["attempt-count"]).toBe("string");
		});

		test("proplist filter works", async () => {
			const { status, body } = await nodeGet(
				"/rest/system/device-mode?.proplist=mode,container",
			);
			expect(status).toBe(200);
			const data = JSON.parse(body);
			console.log("[device-mode proplist]", data);

			// Should only have the requested fields
			expect(Object.keys(data).sort()).toEqual(
				["container", "mode"].sort(),
			);
		});

		test("/print suffix returns 500 on singleton", async () => {
			const { status } = await nodeGet(
				"/rest/system/device-mode/print",
			);
			expect(status).toBe(500);
		});

		test("invalid mode returns 400 immediately", async () => {
			const { status, body } = await nodePost(
				"/rest/system/device-mode/update",
				{ mode: "invalid" },
			);
			expect(status).toBe(400);
			const data = JSON.parse(body);
			expect(data.detail).toContain(
				"input does not match any value of mode",
			);
		});

		test("unknown parameter returns 400 immediately", async () => {
			const { status, body } = await nodePost(
				"/rest/system/device-mode/update",
				{ nonexistent: "yes" },
			);
			expect(status).toBe(400);
			const data = JSON.parse(body);
			expect(data.detail).toContain("unknown parameter");
		});

		test("activation-timeout below 10s returns 400", async () => {
			const { status, body } = await nodePost(
				"/rest/system/device-mode/update",
				{ container: "yes", "activation-timeout": "1s" },
			);
			expect(status).toBe(400);
			const data = JSON.parse(body);
			expect(data.detail).toContain("out of range");
			expect(data.detail).toContain("00:00:10");
		});

		// SKIP by default: this test blocks ALL REST for 10s, breaking subsequent tests.
		// Validated via raw curl — see header comments for evidence.
		// Run alone with: QUICKCHR_INTEGRATION=1 bun test test/lab/device-mode.test.ts -t "activation"
		test.skip(
			"activation-timeout=10s blocks then returns 'update canceled'",
			async () => {
				const start = Date.now();
				const { status, body } = await nodePost(
					"/rest/system/device-mode/update",
					{
						container: "yes",
						"activation-timeout": "10s",
					},
					15_000,
				);
				const elapsed = Date.now() - start;

				console.log(
					`[device-mode timeout] elapsed=${elapsed}ms status=${status} body=${body}`,
				);

				expect(status).toBe(400);
				const data = JSON.parse(body);
				expect(data.detail).toBe("update canceled");
				// Should take approximately 10s
				expect(elapsed).toBeGreaterThan(9_000);
				expect(elapsed).toBeLessThan(13_000);

				// attempt-count should have incremented
				const stateResp = await nodeGet(
					"/rest/system/device-mode?.proplist=attempt-count",
				);
				const state = JSON.parse(stateResp.body);
				expect(Number(state["attempt-count"])).toBeGreaterThan(0);
			},
			20_000,
		);

		test(
			"via /rest/execute — print works",
			async () => {
				const { status, body } = await nodePost(
					"/rest/execute",
					{
						script: "/system/device-mode/print",
						"as-string": "",
					},
					10_000,
				);
				expect(status).toBe(200);
				const data = JSON.parse(body);
				expect(data.ret).toContain("mode:");
				expect(data.ret).toContain("attempt-count:");
				console.log(
					"[device-mode execute]",
					data.ret.substring(0, 200),
				);
			},
			15_000,
		);
	},
);
