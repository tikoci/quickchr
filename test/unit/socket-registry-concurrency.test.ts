/**
 * Concurrency regression for named-socket endpoint claims.
 *
 * `joinNamedSocket()` reads the entry, picks a free slot and writes it back. Without a
 * cross-process lock, two machines joining one link both read `[null, null]`, both take
 * slot 0, and the second write wins — so both QEMUs are handed the same `local.path`,
 * and on a `dgram` link the second silently unlinks the first's socket and takes the
 * link over with nothing logged on either side.
 *
 * `quickchr start a & quickchr start b &` is the shape that hits it, and it is exactly
 * how the field report behind #157/#158 drove its multi-CHR lab. The per-machine
 * `.start-lock` cannot help: the contenders are different machines.
 *
 * Before the fix this lost an endpoint on 12 of 12 rounds. These run real subprocesses
 * because the defect only exists between processes — the in-memory cache hides it
 * inside one.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	_resetSocketCache,
	createNamedSocket,
	getNamedSocket,
	listNamedSockets,
} from "../../src/lib/socket-registry.ts";

/** A short base, not `import.meta.dir`: a `dgram` endpoint path is
 *  `<dir>/networks/<name>.<slot>.sock`, and the whole thing has to fit `sun_path`'s
 *  104 bytes. Under the repo it depends on how deep the checkout is, so these tests
 *  would pass here and fail on a longer path — which is exactly how the limit was
 *  found in the first place. */
const TEST_DIR = mkdtempSync(join(tmpdir(), "qchr-test-"));
const WORKER = join(import.meta.dir, "helpers/join-socket-worker.ts");
const CREATE_WORKER = join(import.meta.dir, "helpers/create-socket-worker.ts");
const origDataDir = process.env.QUICKCHR_DATA_DIR;

/** Run N joiners that all start work at the same instant. */
async function joinConcurrently(socket: string, machines: string[]): Promise<string[]> {
	const startAt = Date.now() + 300;
	return Promise.all(
		machines.map(async (name) => {
			const proc = Bun.spawn(["bun", WORKER, socket, name, String(startAt)], {
				env: { ...process.env, QUICKCHR_DATA_DIR: TEST_DIR },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
			return out.trim();
		}),
	);
}

beforeEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.QUICKCHR_DATA_DIR = TEST_DIR;
	_resetSocketCache();
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	if (origDataDir !== undefined) process.env.QUICKCHR_DATA_DIR = origDataDir;
	else delete process.env.QUICKCHR_DATA_DIR;
	_resetSocketCache();
});

describe("concurrent joins on one named socket", () => {
	test("two machines joining at once get one endpoint each", async () => {
		createNamedSocket("race-link", { mode: "dgram" });

		const results = await joinConcurrently("race-link", ["alpha", "beta"]);
		expect(results.filter((r) => r.startsWith("OK"))).toHaveLength(2);

		_resetSocketCache();
		const held = (getNamedSocket("race-link")?.endpoints ?? []).filter((m) => m !== null);
		expect(held).toHaveLength(2);
		expect(new Set(held).size).toBe(2);
	}, 30_000);

	test("a link nobody created yet is created once, not once per joiner", async () => {
		// `start()` used to test-then-create, which two concurrent starts both pass.
		const results = await joinConcurrently("auto-link", ["alpha", "beta"]);
		expect(results.filter((r) => r.startsWith("OK"))).toHaveLength(2);

		_resetSocketCache();
		const entry = getNamedSocket("auto-link");
		expect(entry?.members.sort()).toEqual(["alpha", "beta"]);
		expect((entry?.endpoints ?? []).filter((m) => m !== null)).toHaveLength(2);
	}, 30_000);

	test("with more joiners than ends, exactly two win and the rest are told why", async () => {
		// The one that exposed the lock's own bug: a waiter could read a lock file the
		// holder had created but not yet written its pid into, judge it stale, delete
		// it, and proceed — so all three "succeeded" while only two held an endpoint.
		const results = await joinConcurrently("crowded", ["alpha", "beta", "gamma", "delta"]);

		const ok = results.filter((r) => r.startsWith("OK"));
		const refused = results.filter((r) => r.startsWith("REFUSED"));
		expect(ok).toHaveLength(2);
		expect(refused).toHaveLength(2);
		for (const r of refused) expect(r).toContain("--mode mcast");

		_resetSocketCache();
		const held = (getNamedSocket("crowded")?.endpoints ?? []).filter((m) => m !== null);
		expect(held).toHaveLength(2);
		// The winners are the ones the registry says hold the ends — no silent drop.
		expect(ok.map((r) => r.replace("OK ", "")).sort()).toEqual([...held].sort());
	}, 30_000);
});

describe("concurrent creation of different links", () => {
	test("three links created at once get three distinct ports", async () => {
		// Automatic allocation is max(existing ports) + 1, which reads *every* entry — so
		// a per-entry lock does not help when the contenders are different names. Three
		// processes creating three mcast links all read an empty registry and all took
		// 4000, silently collapsing three segments into one shared group. 15/15 rounds
		// before the registry-wide lock.
		const startAt = Date.now() + 300;
		await Promise.all(
			["segment-a", "segment-b", "segment-c"].map(async (name) => {
				const proc = Bun.spawn(["bun", CREATE_WORKER, name, String(startAt)], {
					env: { ...process.env, QUICKCHR_DATA_DIR: TEST_DIR },
					stdout: "pipe",
					stderr: "pipe",
				});
				await Promise.all([new Response(proc.stdout).text(), proc.exited]);
			}),
		);

		_resetSocketCache();
		const ports = listNamedSockets().map((e) => e.port);
		expect(ports).toHaveLength(3);
		expect(new Set(ports).size).toBe(3);
	}, 30_000);
});
