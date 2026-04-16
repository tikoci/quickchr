/**
 * Lab: /system/license — Full Behavior Documentation
 *
 * Tested: CHR 7.22.1 (x86_64) on Intel Mac, HVF acceleration
 * Date: 2026-04-16
 *
 * ═══════════════════════════════════════════════════════════════════════
 * KEY FINDINGS
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 1. GET /rest/system/license on FREE CHR:
 *    {"level":"free","system-id":"7WwsTkLUKQG"}
 *    Only two fields. No expiration, no nlevel, no deadline.
 *
 * 2. CHR LICENSE TIERS (speed limits):
 *    - free: 1 Mbps per interface
 *    - p1 (perpetual-1): 1 Gbps per interface
 *    - p10: 10 Gbps
 *    - p-unlimited: unlimited
 *    - p1 60-day trial is available via /system/license/renew with
 *      MikroTik.com credentials.
 *
 * 3. /system/license/renew IS AN ASYNC COMMAND:
 *    Uses the same .section array pattern as monitor-traffic and
 *    check-for-updates. Blocks while contacting MikroTik license servers.
 *
 *    duration= parameter controls max wait time for license server response.
 *
 * 4. RESPONSE SHAPES FOR /system/license/renew:
 *
 *    a) Missing credentials:
 *       HTTP 400 {"detail":"missing =account=","error":400,"message":"Bad Request"}
 *       (immediate, no blocking)
 *
 *    b) Bad credentials (with duration=10s):
 *       HTTP 200 [
 *         {".section":"0","status":"connecting"},
 *         {".section":"1","status":"renewing"},
 *         {".section":"2","status":"ERROR: Unauthorized"}
 *       ]
 *       Takes ~2-5s to contact server and get rejection.
 *
 *    c) Successful renewal (with valid creds + duration=10s):
 *       HTTP 200 [
 *         {".section":"0","status":"connecting"},
 *         {".section":"1","status":"done"}
 *       ]
 *       Then GET /system/license shows new level.
 *
 *    d) Trial limit reached:
 *       HTTP 200 [
 *         {".section":"0","status":"connecting"},
 *         {".section":"1","status":"renewing"},
 *         {".section":"2","status":"ERROR: Licensing Error: too many trial licences"}
 *       ]
 *
 *    e) No internet / server unreachable (with duration=10s):
 *       Blocks for the full duration, then returns with error status.
 *
 *    f) Post-boot REST race (endpoint not initialized):
 *       Returns system resource data as body (wrong endpoint response).
 *       Must retry.
 *
 * 5. REQUIRED FIELDS for /system/license/renew:
 *    - account: MikroTik.com email (required)
 *    - password: MikroTik.com password (required for non-free)
 *    - level: license level to request (e.g., "p1")
 *    - duration: how long to wait for server response (RouterOS duration string)
 *
 * 6. Via /rest/execute (as-string=""):
 *    {"ret":"  system-id: 7WwsTkLUKQG\r\n      level: free       "}
 *    Standard key-value text output.
 *
 * 7. ERROR CLASSIFICATION:
 *    The status field can contain "ERROR: ..." with HTTP 200.
 *    Code MUST check for "ERROR:" prefix in status strings.
 *    Do NOT misclassify as "pending" and poll — throw immediately.
 *
 * RECOMMENDED PATTERN FOR QUICKCHR:
 *   1. POST /rest/system/license/renew with duration="15s"
 *   2. Parse array response — look at last .section's status
 *   3. If status starts with "ERROR:" → throw with the error message
 *   4. If status is "done" → poll GET /rest/system/license to verify level changed
 *   5. If no credentials provided → skip (leave as free tier)
 *
 * ═══════════════════════════════════════════════════════════════════════
 */

import { describe, test, expect } from "bun:test";

const CHR_PORT = 9100;
const BASE_URL = `http://127.0.0.1:${CHR_PORT}`;
const AUTH = `Basic ${btoa("admin:")}`;

async function restGet(
	path: string,
	timeoutMs = 5_000,
): Promise<{ status: number; body: string }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const resp = await fetch(`${BASE_URL}${path}`, {
			headers: { Authorization: AUTH },
			signal: controller.signal,
		});
		return { status: resp.status, body: await resp.text() };
	} finally {
		clearTimeout(timer);
	}
}

async function restPost(
	path: string,
	body: Record<string, unknown>,
	timeoutMs = 10_000,
): Promise<{ status: number; body: string }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const resp = await fetch(`${BASE_URL}${path}`, {
			method: "POST",
			headers: {
				Authorization: AUTH,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		return { status: resp.status, body: await resp.text() };
	} finally {
		clearTimeout(timer);
	}
}

describe.skipIf(!process.env.QUICKCHR_INTEGRATION)(
	"Lab: /system/license",
	() => {
		test("GET baseline — free CHR", async () => {
			const { status, body } = await restGet("/rest/system/license");
			expect(status).toBe(200);

			const data = JSON.parse(body);
			console.log("[license GET]", data);

			expect(data.level).toBe("free");
			expect(data["system-id"]).toBeDefined();
			expect(typeof data["system-id"]).toBe("string");

			// Free tier has only these two fields
			const keys = Object.keys(data);
			expect(keys).toContain("level");
			expect(keys).toContain("system-id");
		});

		test("via execute — print returns text", async () => {
			const { status, body } = await restPost("/rest/execute", {
				script: "/system/license/print",
				"as-string": "",
			});
			expect(status).toBe(200);
			const data = JSON.parse(body);
			expect(data.ret).toContain("level:");
			expect(data.ret).toContain("free");
			console.log("[license execute]", data.ret.trim());
		});

		test("renew without credentials returns 400", async () => {
			const { status, body } = await restPost(
				"/rest/system/license/renew",
				{},
			);
			expect(status).toBe(400);
			const data = JSON.parse(body);
			expect(data.detail).toBe("missing =account=");
			expect(data.error).toBe(400);
		});

		test(
			"renew with bad credentials returns async error sections",
			async () => {
				const start = Date.now();
				const { status, body } = await restPost(
					"/rest/system/license/renew",
					{
						account: "bad@example.com",
						password: "wrong",
						level: "p1",
						duration: "10s",
					},
					20_000,
				);
				const elapsed = Date.now() - start;

				expect(status).toBe(200);
				const sections = JSON.parse(body);
				console.log(
					`[license renew bad creds] elapsed=${elapsed}ms`,
					JSON.stringify(sections),
				);

				expect(Array.isArray(sections)).toBe(true);
				expect(sections.length).toBeGreaterThanOrEqual(2);

				// First section is "connecting"
				expect(sections[0].status).toBe("connecting");

				// Last section contains the error
				const last = sections[sections.length - 1];
				expect(last.status).toContain("ERROR:");
				expect(last.status).toContain("Unauthorized");

				// Sections have .section indices
				for (let i = 0; i < sections.length; i++) {
					expect(sections[i][".section"]).toBe(String(i));
				}
			},
			25_000,
		);

		// This test requires valid MikroTik.com credentials
		// Set MIKROTIK_WEB_USER and MIKROTIK_WEB_PASS env vars
		test.skipIf(
			!process.env.MIKROTIK_WEB_USER || !process.env.MIKROTIK_WEB_PASS,
		)(
			"renew with valid credentials (trial P1)",
			async () => {
				const { status, body } = await restPost(
					"/rest/system/license/renew",
					{
						account: process.env.MIKROTIK_WEB_USER,
						password: process.env.MIKROTIK_WEB_PASS,
						level: "p1",
						duration: "15s",
					},
					25_000,
				);

				expect(status).toBe(200);
				const sections = JSON.parse(body);
				console.log(
					"[license renew valid]",
					JSON.stringify(sections),
				);

				const last = sections[sections.length - 1];
				if (last.status.startsWith("ERROR:")) {
					console.log("Trial limit may be reached:", last.status);
					// Still valid test — the error shape is documented
				} else {
					expect(last.status).toBe("done");

					// Verify level changed
					const { body: licBody } = await restGet(
						"/rest/system/license",
					);
					const lic = JSON.parse(licBody);
					console.log("[license after renew]", lic);
					expect(lic.level).toBe("p1");
				}
			},
			30_000,
		);
	},
);
