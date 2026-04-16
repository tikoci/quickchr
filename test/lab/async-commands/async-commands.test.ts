/**
 * Lab: Async Command Patterns — RouterOS REST Behavior Documentation
 *
 * Tested: CHR 7.22.1 (x86_64) on Intel Mac, HVF acceleration
 * Date: 2026-04-16
 *
 * ═══════════════════════════════════════════════════════════════════════
 * KEY FINDINGS
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 1. ASYNC PATTERN OVERVIEW:
 *    RouterOS "monitor" commands (and some others) can run indefinitely.
 *    REST always returns JSON, so it needs a way to scope the duration.
 *    Three modes exist:
 *
 *    a) duration="Xs" → Runs for X seconds, returns JSON array with
 *       .section indices (0, 1, 2, ...) — one per sample period.
 *    b) once="" → Runs once, returns single-element JSON array.
 *       Presence-based (like as-string): ANY value enables it.
 *    c) No param → BLOCKS INDEFINITELY until HTTP timeout or client disconnect.
 *
 * 2. RESPONSE SHAPE WITH duration:
 *    [
 *      {".section":"0", "name":"ether1", "rx-bits-per-second":"0", ...},
 *      {".section":"1", "name":"ether1", "rx-bits-per-second":"0", ...},
 *      {".section":"2", "name":"ether1", "rx-bits-per-second":"0", ...}
 *    ]
 *    Section count = duration in seconds (duration=3s → 3 sections).
 *
 * 3. RESPONSE SHAPE WITH once:
 *    [{"name":"ether1", "rx-bits-per-second":"0", ...}]
 *    Single element. NO .section field. Immediate return.
 *
 * 4. TESTED COMMANDS:
 *    - /interface/monitor-traffic: both duration and once work ✅
 *    - /interface/ethernet/monitor: once works ✅, duration likely works
 *    - /system/package/update/check-for-updates: uses same .section pattern
 *    - /system/license/renew: uses same .section pattern
 *    - /system/device-mode/update: does NOT use sections — just blocks then
 *      returns a single object
 *
 * 5. as-string vs once:
 *    - as-string: Forces /rest/execute to return inline output instead of job ID.
 *      Presence-based boolean (any value = true).
 *    - once: Forces monitor-type commands to run one sample and return.
 *      Also presence-based.
 *    - These are DIFFERENT parameters for DIFFERENT purposes, but both are
 *      presence-based booleans.
 *
 * 6. BLOCKING WITHOUT PARAMS:
 *    Both REST direct (/rest/interface/monitor-traffic) and via /rest/execute
 *    block indefinitely without duration/once. Must use client-side timeout.
 *
 * 7. GENERAL RULE:
 *    Any RouterOS command that has a "streaming" mode (monitor, profile,
 *    bandwidth-test, check-for-updates, license/renew) will:
 *    - Block on REST unless duration= or once= is provided
 *    - Return .section arrays when using duration=
 *    - Return a single-element array when using once=
 *
 * ═══════════════════════════════════════════════════════════════════════
 * RAW RESPONSE SHAPES
 * ═══════════════════════════════════════════════════════════════════════
 *
 * POST /rest/interface/monitor-traffic {"interface":"ether1","duration":"3s"}
 * → HTTP 200
 * [
 *   {".section":"0","name":"ether1","rx-bits-per-second":"0",
 *    "rx-packets-per-second":"0","tx-bits-per-second":"0",
 *    "tx-packets-per-second":"0","fp-rx-bits-per-second":"0",
 *    "fp-rx-packets-per-second":"0","fp-tx-bits-per-second":"0",
 *    "fp-tx-packets-per-second":"0"},
 *   {".section":"1", ...same shape...},
 *   {".section":"2", ...same shape...}
 * ]
 *
 * POST /rest/interface/monitor-traffic {"interface":"ether1","once":""}
 * → HTTP 200
 * [{"name":"ether1","rx-bits-per-second":"0",...}]
 * (single element, no .section)
 *
 * POST /rest/interface/ethernet/monitor {"numbers":"ether1","once":""}
 * → HTTP 200
 * [{"name":"ether1","status":"no-link","auto-negotiation":"done",
 *   "rate":"","full-duplex":"false","tx-flow-control":"false",
 *   "rx-flow-control":"false","advertising":"...","link-partner-advertising":""}]
 *
 * POST /rest/interface/monitor-traffic (no duration/once)
 * → BLOCKS INDEFINITELY (until client timeout)
 *
 * ═══════════════════════════════════════════════════════════════════════
 */

import { describe, test, expect } from "bun:test";

const CHR_PORT = 9100;
const BASE_URL = `http://127.0.0.1:${CHR_PORT}`;
const AUTH = `Basic ${btoa("admin:")}`;

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
	"Lab: Async Command Patterns",
	() => {
		test(
			"monitor-traffic with duration=3s returns 3 sections",
			async () => {
				const start = Date.now();
				const { status, body } = await restPost(
					"/rest/interface/monitor-traffic",
					{ interface: "ether1", duration: "3s" },
				);
				const elapsed = Date.now() - start;

				expect(status).toBe(200);
				const data = JSON.parse(body);
				expect(Array.isArray(data)).toBe(true);

				console.log(
					`[monitor-traffic duration=3s] elapsed=${elapsed}ms sections=${data.length}`,
				);
				console.log("[first section]", JSON.stringify(data[0]));

				// Should have ~3 sections (one per second)
				expect(data.length).toBe(3);

				// Each section has .section index
				for (let i = 0; i < data.length; i++) {
					expect(data[i][".section"]).toBe(String(i));
				}

				// Should take approximately 3 seconds
				expect(elapsed).toBeGreaterThan(2_500);
				expect(elapsed).toBeLessThan(5_000);
			},
			10_000,
		);

		test("monitor-traffic with once returns single element", async () => {
			const start = Date.now();
			const { status, body } = await restPost(
				"/rest/interface/monitor-traffic",
				{ interface: "ether1", once: "" },
			);
			const elapsed = Date.now() - start;

			expect(status).toBe(200);
			const data = JSON.parse(body);
			expect(Array.isArray(data)).toBe(true);

			console.log(
				`[monitor-traffic once] elapsed=${elapsed}ms`,
				JSON.stringify(data),
			);

			// Single element, no .section
			expect(data.length).toBe(1);
			expect(data[0]).not.toHaveProperty(".section");
			expect(data[0]).toHaveProperty("name");

			// Should be fast (< 2s)
			expect(elapsed).toBeLessThan(2_000);
		});

		test("ethernet/monitor with once returns link status", async () => {
			const { status, body } = await restPost(
				"/rest/interface/ethernet/monitor",
				{ numbers: "ether1", once: "" },
			);
			expect(status).toBe(200);
			const data = JSON.parse(body);
			expect(Array.isArray(data)).toBe(true);
			expect(data.length).toBe(1);

			console.log("[ethernet/monitor once]", JSON.stringify(data[0]));

			// Has link-status related fields (exact fields vary by NIC type)
			expect(data[0]).toHaveProperty("status");
		});

		test(
			"monitor-traffic without duration/once blocks (verify via timeout)",
			async () => {
				const start = Date.now();
				try {
					// Should block — we set a 3s timeout to prove it
					await restPost(
						"/rest/interface/monitor-traffic",
						{ interface: "ether1" },
						3_000,
					);
					// If we get here, it didn't block (unexpected)
					throw new Error("Expected to be aborted by timeout");
				} catch (e: unknown) {
					const elapsed = Date.now() - start;
					console.log(
						`[monitor-traffic no-duration] aborted after ${elapsed}ms`,
					);

					// Should have hit our 3s timeout
					expect(elapsed).toBeGreaterThan(2_500);
					expect((e as Error).name).toBe("AbortError");
				}
			},
			10_000,
		);

		test(
			"once='false' may NOT enable once (unlike as-string)",
			async () => {
				// FINDING: unlike as-string, "false" may actually disable once mode
				// and cause the request to block. Test with timeout to detect.
				const start = Date.now();
				try {
					await restPost(
						"/rest/interface/monitor-traffic",
						{ interface: "ether1", once: "false" },
						3_000,
					);
					// If it returns, once was treated as "present" (enabled)
					console.log("[once=false] returned immediately — presence-based");
				} catch {
					const elapsed = Date.now() - start;
					// If it blocked, once="false" is value-based (not presence-based)
					console.log(
						`[once=false] blocked for ${elapsed}ms — value-based, not presence-based`,
					);
					expect(elapsed).toBeGreaterThan(2_500);
				}
			},
			10_000,
		);
	},
);
