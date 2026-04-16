/**
 * Lab: Bun fetch() stop/restart stale-response test
 *
 * This is the specific scenario claimed to trigger the Bun connection pool bug:
 * 1. Make requests to CHR on port X (warming the pool)
 * 2. Stop the CHR
 * 3. Start a NEW CHR on the SAME port X
 * 4. Make requests via fetch() — does it return stale data from the dead instance?
 *
 * This test uses quickchr's own stop/start to simulate the exact scenario.
 *
 * REQUIRES: QUICKCHR_INTEGRATION=1 and a machine named "lab-pool" already exists
 * RUN: bun test test/lab/bun-pool-restart.test.ts
 */

import { describe, test, expect } from "bun:test";
import { request as nodeRequest } from "node:http";
import { QuickCHR } from "../../src/lib/quickchr.ts";

const CHR_PORT = 9100;
const BASE_URL = `http://127.0.0.1:${CHR_PORT}`;
const AUTH = `Basic ${btoa("admin:")}`;

function nodeGet(
	url: string,
	timeoutMs = 5_000,
): Promise<{ status: number; body: string; timing: number }> {
	const start = performance.now();
	return new Promise((resolve, reject) => {
		const parsed = new URL(url);
		let done = false;
		const timer = setTimeout(() => {
			if (!done) {
				done = true;
				req.destroy();
				reject(new Error(`nodeGet timeout after ${timeoutMs}ms`));
			}
		}, timeoutMs);

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
						clearTimeout(timer);
						resolve({
							status: res.statusCode ?? 0,
							body,
							timing: performance.now() - start,
						});
					}
				});
				res.on("error", (e) => {
					if (!done) {
						done = true;
						clearTimeout(timer);
						reject(e);
					}
				});
			},
		);
		req.on("error", (e) => {
			if (!done) {
				done = true;
				clearTimeout(timer);
				reject(e);
			}
		});
		req.end();
	});
}

async function bunFetchGet(
	url: string,
	timeoutMs = 5_000,
): Promise<{ status: number; body: string; timing: number }> {
	const start = performance.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const resp = await fetch(url, {
			headers: { Authorization: AUTH },
			signal: controller.signal,
		});
		const body = await resp.text();
		return {
			status: resp.status,
			body,
			timing: performance.now() - start,
		};
	} finally {
		clearTimeout(timer);
	}
}

async function bunFetchPost(
	url: string,
	jsonBody: Record<string, unknown>,
	timeoutMs = 5_000,
): Promise<{ status: number; body: string; timing: number }> {
	const start = performance.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const resp = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: AUTH,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(jsonBody),
			signal: controller.signal,
		});
		const body = await resp.text();
		return {
			status: resp.status,
			body,
			timing: performance.now() - start,
		};
	} finally {
		clearTimeout(timer);
	}
}

async function waitForRestReady(timeoutMs = 120_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const result = await nodeGet(
				`${BASE_URL}/rest/system/resource`,
				3_000,
			);
			if (result.status === 200) {
				const data = JSON.parse(result.body);
				if (
					data &&
					typeof data === "object" &&
					!Array.isArray(data) &&
					data.version
				) {
					return;
				}
			}
		} catch {
			// Not ready yet
		}
		await Bun.sleep(1_000);
	}
	throw new Error(`CHR not ready after ${timeoutMs}ms`);
}

describe.skipIf(!process.env.QUICKCHR_INTEGRATION)(
	"Lab: Bun fetch stop/restart stale-response",
	() => {
		// ===============================================================
		// TEST: The definitive stop/restart stale-response experiment
		// ===============================================================
		test(
			"stop CHR, restart on same port, check fetch for stale data",
			async () => {
				// Step 1: Verify CHR is running and warm up fetch pool
				console.log("[RESTART] Step 1: Warming up connections...");
				const warmupUrl = `${BASE_URL}/rest/system/resource`;

				// Make several requests to establish pooled connections
				for (let i = 0; i < 5; i++) {
					const r = await bunFetchGet(warmupUrl);
					expect(r.status).toBe(200);
				}

				// Record current identity for comparison
				const preIdentity = await bunFetchGet(
					`${BASE_URL}/rest/system/identity`,
				);
				const preIdentityData = JSON.parse(preIdentity.body);
				console.log(
					`[RESTART] Pre-stop identity: ${preIdentityData.name}`,
				);

				// Also do a POST to warm that path
				const preExec = await bunFetchPost(
					`${BASE_URL}/rest/execute`,
					{
						script: ':put "pre-stop-marker"',
						"as-string": true,
					},
				);
				console.log(
					`[RESTART] Pre-stop exec: ${preExec.body.substring(0, 100)}`,
				);

				// Record uptime for stale-data detection
				const preResource = await bunFetchGet(warmupUrl);
				const preResourceData = JSON.parse(preResource.body);
				const preUptime = preResourceData.uptime;
				console.log(`[RESTART] Pre-stop uptime: ${preUptime}`);

				// Step 2: Stop the CHR
				console.log("[RESTART] Step 2: Stopping CHR...");
				const instance = QuickCHR.get("lab-pool");
				if (!instance) throw new Error("lab-pool not found");
				await instance.stop();

				// Brief pause for QEMU to fully exit
				await Bun.sleep(2_000);

				// Verify port is closed
				console.log("[RESTART] Step 2b: Verifying port is closed...");
				let portClosed = false;
				try {
					await bunFetchGet(warmupUrl, 2_000);
				} catch {
					portClosed = true;
				}
				console.log(`[RESTART] Port closed after stop: ${portClosed}`);

				// Step 3: Restart on same port
				console.log("[RESTART] Step 3: Restarting CHR on same port...");
				// Use start directly — it should reuse the same port
				const restarted = await QuickCHR.start({
					name: "lab-pool",
				});

				// Wait for REST to be ready (use node:http — known safe)
				console.log("[RESTART] Step 3b: Waiting for REST ready...");
				await waitForRestReady();

				// Step 4: Test fetch after restart
				console.log(
					"[RESTART] Step 4: Testing fetch after restart...",
				);

				// 4a: GET — is the uptime fresh (near 0)?
				const postResource = await bunFetchGet(warmupUrl);
				const postResourceData = JSON.parse(postResource.body);
				const postUptime = postResourceData.uptime;
				console.log(
					`[RESTART] Post-restart uptime (fetch): ${postUptime}`,
				);
				console.log(
					`[RESTART] Post-restart timing: ${postResource.timing.toFixed(1)}ms`,
				);

				// Also check with node for comparison
				const nodeResource = await nodeGet(warmupUrl);
				const nodeResourceData = JSON.parse(nodeResource.body);
				console.log(
					`[RESTART] Post-restart uptime (node):  ${nodeResourceData.uptime}`,
				);

				// Compare: if fetch returned the pre-stop uptime, that's stale data
				if (postUptime === preUptime) {
					console.log(
						`[RESTART] *** STALE DATA: fetch returned pre-stop uptime "${preUptime}" ***`,
					);
				} else {
					console.log(`[RESTART] Uptime is fresh — no stale data`);
				}

				// 4b: POST — does execute work correctly after restart?
				const postExec = await bunFetchPost(
					`${BASE_URL}/rest/execute`,
					{
						script: ':put "post-restart-marker"',
						"as-string": true,
					},
				);
				console.log(
					`[RESTART] Post-restart exec (fetch): status=${postExec.status}, timing=${postExec.timing.toFixed(1)}ms`,
				);
				console.log(
					`[RESTART] Post-restart exec body: ${postExec.body.substring(0, 200)}`,
				);

				const postExecData = JSON.parse(postExec.body);
				const hasMarker =
					typeof postExecData.ret === "string" &&
					postExecData.ret.includes("post-restart-marker");
				console.log(
					`[RESTART] POST has correct marker: ${hasMarker}`,
				);

				if (!hasMarker) {
					console.log(
						`[RESTART] *** BUG: POST returned wrong data after restart: ${JSON.stringify(postExecData).substring(0, 200)} ***`,
					);
				}

				// 4c: Suspicious timing check
				if (postResource.timing < 1) {
					console.log(
						`[RESTART] *** SUSPICIOUS: GET returned in ${postResource.timing.toFixed(2)}ms — may be cached ***`,
					);
				}
				if (postExec.timing < 1) {
					console.log(
						`[RESTART] *** SUSPICIOUS: POST returned in ${postExec.timing.toFixed(2)}ms — may be cached ***`,
					);
				}

				// Final verdict
				const staleGet = postUptime === preUptime;
				const stalePost = !hasMarker;
				if (staleGet || stalePost) {
					console.log(
						`\n[VERDICT] *** BUN POOL BUG CONFIRMED: staleGet=${staleGet}, stalePost=${stalePost} ***`,
					);
				} else {
					console.log(
						`\n[VERDICT] No stale-response bug detected after stop/restart cycle`,
					);
				}

				expect(hasMarker).toBe(true);
			},
			180_000,
		);
	},
);
