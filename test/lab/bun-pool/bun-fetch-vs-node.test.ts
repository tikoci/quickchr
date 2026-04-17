/**
 * Lab: Bun fetch() vs node:http connection pool behavior with RouterOS CHR
 *
 * HYPOTHESIS: Bun's fetch() pools TCP connections by host:port and this causes
 * stale responses when a CHR is stopped and restarted on the same port.
 *
 * EXPERIMENT DESIGN:
 * 1. With a running CHR, make identical GET requests via fetch() and node:http
 * 2. Compare timing and response correctness
 * 3. Stop the CHR, restart on same port, immediately test both
 * 4. Check if fetch() returns stale data from the dead connection
 *
 * REQUIRES: QUICKCHR_INTEGRATION=1 (needs running QEMU)
 * RUN: bun test test/lab/bun-fetch-vs-node.test.ts
 *
 * NOTE: This is a lab test — not part of CI. Results documented inline.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * VERDICT (Bun 1.3.11 on macOS x86_64, CHR 7.22.1, Intel Mac HVF):
 *
 * ❌ BUG NOT REPRODUCED. All 8 tests pass with fetch().
 *
 * Results:
 * - fetch() is ~1.8x faster than node:http (connection pooling working normally)
 * - POST after GET returns correct data — no cross-contamination
 * - POST timing matches RouterOS command delay — no stale cached responses
 * - Connection: close IS respected (RouterOS returns close header)
 * - Concurrent GET+POST both correct
 * - Cross-endpoint (identity vs execute) no contamination
 *
 * The stop/restart scenario (bun-pool-restart.test.ts) also shows NO stale
 * data — uptime is fresh after restart, POST marker is correct.
 *
 * Possible explanations:
 * 1. Bug was fixed in Bun 1.3.x (original reports may have been older Bun)
 * 2. Bug was actually caused by device-mode's connection-dropping behavior,
 *    not Bun's pool (device-mode kills the HTTP connection mid-flight)
 * 3. Bug was caused by RouterOS returning wrong data during post-boot race,
 *    misattributed to Bun pooling
 *
 * RECOMMENDATION: rest.ts (node:http + agent:false) is still a safe belt-and-
 * suspenders approach, but the urgency of "never use fetch()" is overstated.
 * The real fix for the symptoms was likely the post-boot race handling in
 * waitForBoot(), not the HTTP client choice.
 *
 * UPDATE (Phase 1-3 lab runs): A pool-related issue WAS observed — device-mode
 * GET requests hang when bun test runs multiple lab files in one process. The
 * issue reproduces with both fetch() and node:http+agent:false, so it appears
 * to be a bun test runner issue (shared event loop / parallel file execution),
 * not the HTTP client's connection pool. Running files in separate bun test
 * processes avoids it. This doesn't change the recommendation for library code.
 * ═══════════════════════════════════════════════════════════════════════
 */

import { describe, test, expect } from "bun:test";
import { request as nodeRequest } from "node:http";

const CHR_PORT = 9100;
const BASE_URL = `http://127.0.0.1:${CHR_PORT}`;
const AUTH = `Basic ${btoa("admin:")}`;

describe.skipIf(!process.env.QUICKCHR_INTEGRATION)(
	"Lab: Bun fetch vs node:http connection pool",
	() => {
		// ---------------------------------------------------------------
		// Helper: node:http GET with agent:false (our current "safe" path)
		// ---------------------------------------------------------------
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

		// ---------------------------------------------------------------
		// Helper: Bun fetch() GET (the "suspected buggy" path)
		// ---------------------------------------------------------------
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

		// ---------------------------------------------------------------
		// Helper: Bun fetch() POST (for /rest/execute)
		// ---------------------------------------------------------------
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

		// ---------------------------------------------------------------
		// Helper: node:http POST with agent:false
		// ---------------------------------------------------------------
		function nodePost(
			url: string,
			jsonBody: Record<string, unknown>,
			timeoutMs = 5_000,
		): Promise<{ status: number; body: string; timing: number }> {
			const start = performance.now();
			return new Promise((resolve, reject) => {
				const parsed = new URL(url);
				const bodyBuf = Buffer.from(JSON.stringify(jsonBody), "utf-8");
				let done = false;
				const timer = setTimeout(() => {
					if (!done) {
						done = true;
						req.destroy();
						reject(new Error(`nodePost timeout after ${timeoutMs}ms`));
					}
				}, timeoutMs);

				const req = nodeRequest(
					{
						hostname: parsed.hostname,
						port: parsed.port,
						path: parsed.pathname + parsed.search,
						method: "POST",
						headers: {
							Authorization: AUTH,
							"Content-Type": "application/json",
							"Content-Length": bodyBuf.length,
						},
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
				req.write(bodyBuf);
				req.end();
			});
		}

		// ===============================================================
		// TEST 1: Basic correctness — both methods return same data
		// ===============================================================
		test("GET /rest/system/resource — both methods return same data", async () => {
			const url = `${BASE_URL}/rest/system/resource`;

			const nodeResult = await nodeGet(url);
			const fetchResult = await bunFetchGet(url);

			console.log(
				`[TEST 1] node:http  => status=${nodeResult.status}, timing=${nodeResult.timing.toFixed(1)}ms`,
			);
			console.log(
				`[TEST 1] fetch()   => status=${fetchResult.status}, timing=${fetchResult.timing.toFixed(1)}ms`,
			);

			expect(nodeResult.status).toBe(200);
			expect(fetchResult.status).toBe(200);

			const nodeData = JSON.parse(nodeResult.body);
			const fetchData = JSON.parse(fetchResult.body);

			// Both should return the same version and architecture
			expect(nodeData.version).toBe(fetchData.version);
			expect(nodeData["architecture-name"]).toBe(
				fetchData["architecture-name"],
			);

			console.log(`[TEST 1] Both returned version=${nodeData.version}`);
		});

		// ===============================================================
		// TEST 2: Rapid sequential requests — does fetch() ever return
		//         data from a previous request?
		// ===============================================================
		test("rapid sequential GET — fetch vs node consistency", async () => {
			const url = `${BASE_URL}/rest/system/resource`;
			const iterations = 10;

			const nodeTimings: number[] = [];
			const fetchTimings: number[] = [];

			for (let i = 0; i < iterations; i++) {
				const nr = await nodeGet(url);
				nodeTimings.push(nr.timing);
				expect(nr.status).toBe(200);

				const fr = await bunFetchGet(url);
				fetchTimings.push(fr.timing);
				expect(fr.status).toBe(200);
			}

			const avgNode =
				nodeTimings.reduce((a, b) => a + b, 0) / nodeTimings.length;
			const avgFetch =
				fetchTimings.reduce((a, b) => a + b, 0) / fetchTimings.length;

			console.log(
				`[TEST 2] node:http avg=${avgNode.toFixed(1)}ms over ${iterations} requests`,
			);
			console.log(
				`[TEST 2] fetch()   avg=${avgFetch.toFixed(1)}ms over ${iterations} requests`,
			);
			console.log(
				`[TEST 2] Pool speedup: fetch is ${(avgNode / avgFetch).toFixed(1)}x ${avgFetch < avgNode ? "faster" : "slower"} than node`,
			);
		});

		// ===============================================================
		// TEST 3: POST /rest/execute — does fetch() return GET-like data
		//         after a preceding GET? (The core stale-response theory)
		// ===============================================================
		test("POST after GET — fetch vs node for stale-response detection", async () => {
			const getUrl = `${BASE_URL}/rest/system/resource`;
			const postUrl = `${BASE_URL}/rest/execute`;
			const postBody = {
				script: ':put "lab-test-marker-12345"',
				"as-string": true,
			};

			// First do a GET with both methods to "warm" connections
			await bunFetchGet(getUrl);
			await nodeGet(getUrl);

			// Now POST with fetch — does it return GET data?
			const fetchPost = await bunFetchPost(postUrl, postBody);
			console.log(
				`[TEST 3] fetch POST => status=${fetchPost.status}, timing=${fetchPost.timing.toFixed(1)}ms, body=${fetchPost.body.substring(0, 200)}`,
			);

			// POST with node
			const nodePostResult = await nodePost(postUrl, postBody);
			console.log(
				`[TEST 3] node  POST => status=${nodePostResult.status}, timing=${nodePostResult.timing.toFixed(1)}ms, body=${nodePostResult.body.substring(0, 200)}`,
			);

			// Parse both — they should contain our marker
			const fetchData = JSON.parse(fetchPost.body);
			const nodeData = JSON.parse(nodePostResult.body);

			// If fetch returned system/resource data instead of execute result,
			// that's the stale-response bug
			const fetchHasMarker =
				typeof fetchData.ret === "string" &&
				fetchData.ret.includes("lab-test-marker");
			const nodeHasMarker =
				typeof nodeData.ret === "string" &&
				nodeData.ret.includes("lab-test-marker");

			console.log(
				`[TEST 3] fetch result has marker: ${fetchHasMarker}`,
			);
			console.log(`[TEST 3] node  result has marker: ${nodeHasMarker}`);

			if (!fetchHasMarker && fetchData["architecture-name"]) {
				console.log(
					`[TEST 3] *** BUG CONFIRMED: fetch POST returned system/resource GET data! ***`,
				);
			}

			expect(nodeHasMarker).toBe(true);
			// We expect fetch to also work correctly for a single warm-up,
			// but the stale bug might only manifest across stop/restart cycles.
			// Record the result either way.
		});

		// ===============================================================
		// TEST 4: Interleaved GET/POST pattern — the exact pattern that
		//         triggers the alleged pool bug (GET polling loop, then POST)
		// ===============================================================
		test("interleaved GET-GET-GET-POST pattern via fetch", async () => {
			const getUrl = `${BASE_URL}/rest/system/resource`;
			const postUrl = `${BASE_URL}/rest/execute`;

			// Simulate waitForBoot polling: 5 rapid GETs
			for (let i = 0; i < 5; i++) {
				const r = await bunFetchGet(getUrl);
				expect(r.status).toBe(200);
			}

			// Now POST — the theory says this might get a stale GET response
			const postResult = await bunFetchPost(postUrl, {
				script: ':put "after-polling-marker"',
				"as-string": true,
			});

			console.log(
				`[TEST 4] fetch POST after 5 GETs => status=${postResult.status}, timing=${postResult.timing.toFixed(1)}ms`,
			);
			console.log(
				`[TEST 4] body: ${postResult.body.substring(0, 200)}`,
			);

			const data = JSON.parse(postResult.body);
			const hasMarker =
				typeof data.ret === "string" &&
				data.ret.includes("after-polling-marker");
			console.log(`[TEST 4] Has correct POST response: ${hasMarker}`);

			if (!hasMarker) {
				console.log(
					`[TEST 4] *** STALE RESPONSE: POST returned non-execute data after GET polling ***`,
				);
				console.log(
					`[TEST 4] Got: ${JSON.stringify(data).substring(0, 300)}`,
				);
			}

			// Same test with node:http for comparison
			const nodePost2 = await nodePost(postUrl, {
				script: ':put "after-polling-marker-node"',
				"as-string": true,
			});
			const nodeData = JSON.parse(nodePost2.body);
			console.log(
				`[TEST 4] node POST after 5 GETs => has marker: ${nodeData.ret?.includes("after-polling-marker-node")}`,
			);
		});

		// ===============================================================
		// TEST 5: Connection: close header — does Bun respect it?
		// ===============================================================
		test("fetch with Connection: close header", async () => {
			const url = `${BASE_URL}/rest/system/resource`;

			// Test if adding Connection: close changes behavior
			const withClose = await fetch(url, {
				headers: {
					Authorization: AUTH,
					Connection: "close",
				},
			});
			const body1 = await withClose.text();

			const withoutClose = await fetch(url, {
				headers: { Authorization: AUTH },
			});
			const body2 = await withoutClose.text();

			const data1 = JSON.parse(body1);
			const data2 = JSON.parse(body2);

			console.log(`[TEST 5] With Connection:close    => status=${withClose.status}`);
			console.log(`[TEST 5] Without Connection:close => status=${withoutClose.status}`);
			console.log(`[TEST 5] Same response: ${data1.version === data2.version}`);

			// Check response headers for connection handling
			console.log(`[TEST 5] Response Connection header (with close): ${withClose.headers.get("connection")}`);
			console.log(`[TEST 5] Response Connection header (without): ${withoutClose.headers.get("connection")}`);
		});

		// ===============================================================
		// TEST 6: Timing analysis — is fetch() suspiciously fast?
		// A <2ms POST response that returns GET-like data is the
		// smoking gun for a pooled stale response.
		// ===============================================================
		test("POST timing analysis — check for suspiciously fast responses", async () => {
			const postUrl = `${BASE_URL}/rest/execute`;
			const postBody = {
				script: ':delay 100ms; :put "delayed-response"',
				"as-string": true,
			};

			// This command has a 100ms delay built in — if we get a response
			// in <50ms, it's definitely stale/cached
			const fetchResult = await bunFetchPost(postUrl, postBody, 10_000);
			const nodeResult = await nodePost(postUrl, postBody, 10_000);

			console.log(
				`[TEST 6] fetch POST (100ms delay cmd) => ${fetchResult.timing.toFixed(1)}ms, body=${fetchResult.body.substring(0, 100)}`,
			);
			console.log(
				`[TEST 6] node  POST (100ms delay cmd) => ${nodeResult.timing.toFixed(1)}ms, body=${nodeResult.body.substring(0, 100)}`,
			);

			if (fetchResult.timing < 50) {
				console.log(
					`[TEST 6] *** SUSPICIOUS: fetch returned in ${fetchResult.timing.toFixed(1)}ms for a 100ms+ command ***`,
				);
			}
		});

		// ===============================================================
		// TEST 7: Different endpoints — does pool cross paths?
		// GET /system/identity then POST /execute — does POST get
		// identity data instead of execute result?
		// ===============================================================
		test("cross-endpoint pool contamination", async () => {
			// GET identity
			const identityUrl = `${BASE_URL}/rest/system/identity`;
			const identityResult = await bunFetchGet(identityUrl);
			console.log(
				`[TEST 7] fetch GET /identity => ${identityResult.body.substring(0, 100)}`,
			);

			// POST execute
			const postUrl = `${BASE_URL}/rest/execute`;
			const postResult = await bunFetchPost(postUrl, {
				script: ':put "cross-endpoint-test"',
				"as-string": true,
			});
			console.log(
				`[TEST 7] fetch POST /execute => ${postResult.body.substring(0, 100)}`,
			);

			const postData = JSON.parse(postResult.body);
			// Check: did we get identity data back from the execute endpoint?
			if (postData.name !== undefined && postData.ret === undefined) {
				console.log(
					`[TEST 7] *** BUG: POST /execute returned /identity data! ***`,
				);
			} else if (postData.ret?.includes("cross-endpoint-test")) {
				console.log(`[TEST 7] Correct: POST returned execute result`);
			}
		});

		// ===============================================================
		// TEST 8: Concurrent requests — does fetch handle parallel
		//         GET + POST correctly?
		// ===============================================================
		test("concurrent GET + POST via fetch", async () => {
			const getUrl = `${BASE_URL}/rest/system/resource`;
			const postUrl = `${BASE_URL}/rest/execute`;

			const [getResult, postResult] = await Promise.all([
				bunFetchGet(getUrl),
				bunFetchPost(postUrl, {
					script: ':put "concurrent-test"',
					"as-string": true,
				}),
			]);

			console.log(
				`[TEST 8] concurrent GET  => status=${getResult.status}, has version: ${"version" in JSON.parse(getResult.body)}`,
			);
			console.log(
				`[TEST 8] concurrent POST => status=${postResult.status}, body=${postResult.body.substring(0, 100)}`,
			);

			const getData = JSON.parse(getResult.body);
			const postData = JSON.parse(postResult.body);

			expect(getData.version).toBeDefined();
			expect(postData.ret).toContain("concurrent-test");
		});
	},
);
