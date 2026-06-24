/**
 * Minimal repro for: "restPost returns prior restGet body on aarch64"
 *
 * Requires a running CHR with default admin credentials.
 * Usage:
 *   QUICKCHR_INTEGRATION=1 bun test test/lab/arm64-rest-ordering/repro.test.ts
 *
 * The script boots a CHR, then exercises the exact GET→POST sequence that
 * triggers the stale-response bug on arm64. It tries the sequence with and
 * without a delay, and with a socket-close wait, to isolate the root cause.
 *
 * Results are written to test/lab/arm64-rest-ordering/REPORT.md.
 */

import { test, describe, expect, beforeAll, afterAll } from "bun:test";
import { request as nodeRequest } from "node:http";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { QuickCHR } from "../../../src/lib/quickchr.ts";

const SKIP = !process.env.QUICKCHR_INTEGRATION;
const MACHINE = "lab-arm64-rest-ordering";
const REPORT_PATH = join(import.meta.dir, "REPORT.md");

type RawResult = { status: number; body: string; socketDestroyedBeforeEnd: boolean };

/** node:http GET that records socket state at response-end time. */
function rawGet(url: string, auth: string): Promise<RawResult> {
	return new Promise((resolve, reject) => {
		const parsed = new URL(url);
		const req = nodeRequest(
			{
				hostname: parsed.hostname,
				port: parsed.port,
				path: parsed.pathname + parsed.search,
				method: "GET",
				headers: { Authorization: auth, Connection: "close" },
				agent: false,
			},
			(res) => {
				let body = "";
				res.on("data", (c: Buffer) => { body += c.toString(); });
				res.on("end", () => {
					const socketDestroyedBeforeEnd = !!(req.socket?.destroyed);
					resolve({ status: res.statusCode ?? 0, body, socketDestroyedBeforeEnd });
				});
				res.on("error", reject);
			},
		);
		req.on("error", reject);
		req.end();
	});
}

/** node:http GET that waits for socket close before resolving. */
function rawGetWithSocketClose(url: string, auth: string): Promise<RawResult & { msToClose: number }> {
	return new Promise((resolve, reject) => {
		const parsed = new URL(url);
		let endAt = 0;
		const req = nodeRequest(
			{
				hostname: parsed.hostname,
				port: parsed.port,
				path: parsed.pathname + parsed.search,
				method: "GET",
				headers: { Authorization: auth, Connection: "close" },
				agent: false,
			},
			(res) => {
				let body = "";
				res.on("data", (c: Buffer) => { body += c.toString(); });
				res.on("end", () => {
					endAt = Date.now();
					const socketDestroyedBeforeEnd = !!(req.socket?.destroyed);
					const result = { status: res.statusCode ?? 0, body, socketDestroyedBeforeEnd, msToClose: 0 };
					const sock = req.socket;
					if (sock && !sock.destroyed) {
						const cap = setTimeout(() => resolve({ ...result, msToClose: -1 }), 2_000);
						sock.once("close", () => { clearTimeout(cap); resolve({ ...result, msToClose: Date.now() - endAt }); });
					} else {
						resolve(result);
					}
				});
				res.on("error", reject);
			},
		);
		req.on("error", reject);
		req.end();
	});
}

/** node:http POST. */
function rawPost(url: string, auth: string, json: Record<string, unknown>): Promise<RawResult> {
	return new Promise((resolve, reject) => {
		const parsed = new URL(url);
		const buf = Buffer.from(JSON.stringify(json));
		const req = nodeRequest(
			{
				hostname: parsed.hostname,
				port: parsed.port,
				path: parsed.pathname + parsed.search,
				method: "POST",
				headers: {
					Authorization: auth,
					"Content-Type": "application/json",
					"Content-Length": buf.length,
					Connection: "close",
				},
				agent: false,
			},
			(res) => {
				let body = "";
				res.on("data", (c: Buffer) => { body += c.toString(); });
				res.on("end", () => {
					const socketDestroyedBeforeEnd = !!(req.socket?.destroyed);
					resolve({ status: res.statusCode ?? 0, body, socketDestroyedBeforeEnd });
				});
				res.on("error", reject);
			},
		);
		req.on("error", reject);
		req.write(buf);
		req.end();
	});
}

const lines: string[] = [
	"# arm64 REST ordering repro — REPORT",
	"",
	`**Date:** ${new Date().toISOString()}`,
	`**Platform:** ${process.platform}/${process.arch}`,
	`**Bun version:** ${Bun.version}`,
	"",
];

function log(msg: string) {
	console.log(msg);
	lines.push(msg);
}

let baseUrl = "";
let auth = "";

// Stop + remove any leftover machine. QuickCHR has no static remove(); the
// instance handle is the removal surface (matches test/integration/*.test.ts).
async function cleanupMachine(name: string): Promise<void> {
	const existing = QuickCHR.get(name);
	if (!existing) return;
	try { await existing.stop(); } catch { /* ignore */ }
	try { await existing.remove(); } catch { /* ignore */ }
}

describe.skipIf(SKIP)("arm64 REST ordering repro", () => {
	beforeAll(async () => {
		await cleanupMachine(MACHINE);
		const instance = await QuickCHR.start({ name: MACHINE, channel: "stable" });
		baseUrl = `http://127.0.0.1:${instance.ports.http}`;
		auth = `Basic ${btoa("admin:")}`;
		log(`\nCHR booted at ${baseUrl}`);
	}, 300_000);

	afterAll(async () => {
		writeFileSync(REPORT_PATH, lines.join("\n") + "\n");
		console.log(`\nReport written to ${REPORT_PATH}`);
		await cleanupMachine(MACHINE);
	});

	test("Baseline: POST alone returns correct body", async () => {
		const post = await rawPost(`${baseUrl}/rest/execute`, auth, { ".command": ":put standalone-post-ok" });
		log(`\n## Baseline POST alone\nStatus: ${post.status}\nBody: ${post.body.trim()}`);
		expect(post.body.trim()).toContain("standalone-post-ok");
	}, 30_000);

	test("Scenario A: GET immediately followed by POST (no wait)", async () => {
		const get = await rawGet(`${baseUrl}/rest/user/ssh-keys`, auth);
		const post = await rawPost(`${baseUrl}/rest/execute`, auth, { ".command": ":put scenario-a-ok" });

		const postHasSentinel = post.body.includes("scenario-a-ok");
		const postIsStaleGetBody = post.body === get.body;

		log(`\n## Scenario A: GET→POST (no wait)`);
		log(`GET body prefix: ${get.body.slice(0, 80)}`);
		log(`GET socket destroyed at end: ${get.socketDestroyedBeforeEnd}`);
		log(`POST body: ${post.body.trim()}`);
		log(`POST status: ${post.status}`);
		log(`POST has sentinel: ${postHasSentinel}`);
		log(`POST body === GET body (BUG): ${postIsStaleGetBody}`);

		// On x86 this passes; on arm64 with the bug, postHasSentinel is false
		expect(postHasSentinel).toBe(true);
	}, 30_000);

	test("Scenario B: GET + 100 ms delay + POST", async () => {
		await rawGet(`${baseUrl}/rest/user/ssh-keys`, auth);
		await Bun.sleep(100);
		const post = await rawPost(`${baseUrl}/rest/execute`, auth, { ".command": ":put scenario-b-ok" });

		const postHasSentinel = post.body.includes("scenario-b-ok");
		log(`\n## Scenario B: GET + 100ms delay + POST`);
		log(`POST body: ${post.body.trim()}`);
		log(`POST has sentinel: ${postHasSentinel}`);

		expect(postHasSentinel).toBe(true);
	}, 30_000);

	test("Scenario C: GET with socket-close wait + POST", async () => {
		const get = await rawGetWithSocketClose(`${baseUrl}/rest/user/ssh-keys`, auth);
		const post = await rawPost(`${baseUrl}/rest/execute`, auth, { ".command": ":put scenario-c-ok" });

		const postHasSentinel = post.body.includes("scenario-c-ok");
		log(`\n## Scenario C: GET (socket-close wait) + POST`);
		log(`GET ms to socket close: ${get.msToClose}`);
		log(`POST body: ${post.body.trim()}`);
		log(`POST has sentinel: ${postHasSentinel}`);

		expect(postHasSentinel).toBe(true);
	}, 30_000);

	test("Scenario D: repeated GET→POST pairs (10×, no wait)", async () => {
		let bugCount = 0;
		for (let i = 0; i < 10; i++) {
			const get = await rawGet(`${baseUrl}/rest/user/ssh-keys`, auth);
			const post = await rawPost(`${baseUrl}/rest/execute`, auth, { ".command": `:put scenario-d-${i}` });
			if (post.body === get.body) bugCount++;
		}
		log(`\n## Scenario D: 10× GET→POST (no wait)`);
		log(`Bug reproduced ${bugCount}/10 times`);
		// On x86 expect 0; on buggy arm64 expect > 0
		expect(bugCount).toBe(0);
	}, 60_000);
});
