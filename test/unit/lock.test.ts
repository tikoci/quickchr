import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	_observeLockMutations,
	acquireLock,
	acquireLockNow,
	claim,
	currentHolder,
	type HeldLock,
	listReservations,
	machineLockPath,
} from "../../src/lib/lock.ts";

/**
 * The lock primitive behind the per-machine lifecycle lock (#181) and the allocation
 * lock (#140). No QEMU: holders are this process or an idle Bun child, and a dead
 * holder is a pid that cannot exist.
 *
 * A lock is a directory of numbered records; the highest decides the state. Several
 * tests write records by hand to stage a dead holder, or replay a contender whose
 * judgement went stale, through `claim()`.
 */

const TEST_DIR = join(import.meta.dir, ".tmp-lock");
const MACHINE_DIR = join(TEST_DIR, "machines", "alpha");
const LOCK = machineLockPath(MACHINE_DIR);
const DEAD_PID = 99999999;
const origDataDir = process.env.QUICKCHR_DATA_DIR;

/** A live process to stand in for a holder — Bun itself, so it exists on Windows too. */
function spawnIdle() {
	return Bun.spawn([process.execPath, "-e", "await Bun.sleep(60_000)"], { stdout: "ignore", stderr: "ignore" });
}

function expectErrorCode(e: unknown, code: string) {
	expect(e).toBeInstanceOf(Error);
	expect((e as { code?: string }).code).toBe(code);
}

function backdate(path: string): void {
	const past = new Date(Date.now() - 60_000);
	utimesSync(path, past, past);
}

function deadRecord(): string {
	return JSON.stringify({ pid: DEAD_PID, op: "start", at: new Date().toISOString(), token: "dead" });
}

/** Stage record `gen` by hand. */
function writeRecord(gen: number, content: string): string {
	mkdirSync(LOCK, { recursive: true });
	const path = join(LOCK, String(gen));
	writeFileSync(path, content);
	return path;
}

function records(): number[] {
	return readdirSync(LOCK).filter((f) => /^\d+$/.test(f)).map(Number).sort((a, b) => a - b);
}

/** Interleave `contender` after every change the lock module makes while `fn` runs. */
function interleaving(contender: () => void, fn: () => void): void {
	let inHook = false;
	_observeLockMutations(() => {
		if (inHook) return;
		inHook = true;
		try { contender(); } finally { inHook = false; }
	});
	try { fn(); } finally { _observeLockMutations(undefined); }
}

beforeEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(MACHINE_DIR, { recursive: true });
	process.env.QUICKCHR_DATA_DIR = TEST_DIR;
});

afterEach(() => {
	_observeLockMutations(undefined);
	rmSync(TEST_DIR, { recursive: true, force: true });
	if (origDataDir === undefined) delete process.env.QUICKCHR_DATA_DIR;
	else process.env.QUICKCHR_DATA_DIR = origDataDir;
});

describe("acquireLockNow", () => {
	test("takes a free lock and records who holds it", () => {
		const lock = acquireLockNow(LOCK, "start");
		const holder = currentHolder(LOCK);
		expect(holder?.pid).toBe(process.pid);
		expect(holder?.op).toBe("start");
		expect(typeof holder?.token).toBe("string");
		lock.release();
		expect(currentHolder(LOCK)).toBeUndefined();
	});

	test("a live holder fails it with MACHINE_LOCKED naming the operation and pid", () => {
		const held = acquireLockNow(LOCK, "start");
		try {
			acquireLockNow(LOCK, "start", { subject: 'Machine "alpha"' });
			expect.unreachable("should have thrown");
		} catch (e) {
			expectErrorCode(e, "MACHINE_LOCKED");
			expect((e as Error).message).toContain('Machine "alpha" is locked by `start`');
			expect((e as Error).message).toContain(`pid ${process.pid}`);
		} finally {
			held.release();
		}
	});

	test("the same process is not let back in: two async operations conflict too", () => {
		const held = acquireLockNow(LOCK, "stop");
		expect(() => acquireLockNow(LOCK, "start")).toThrow();
		held.release();
	});

	test("takes over from a dead holder without deleting its record first", () => {
		writeRecord(1, deadRecord());
		const lock = acquireLockNow(LOCK, "start");
		expect(currentHolder(LOCK)?.pid).toBe(process.pid);
		expect(records()).toEqual([2]);
		lock.release();
	});

	test("an unparseable record blocks while it may still be written, and counts as free once old", () => {
		const path = writeRecord(1, "");
		expect(() => acquireLockNow(LOCK, "start")).toThrow();
		backdate(path);
		acquireLockNow(LOCK, "start").release();
	});

	test("a record that exists but cannot be read is a holder, not an absence", () => {
		// EISDIR on read: the shape of another user's record under a restrictive umask
		// (EACCES), without depending on permissions that root ignores.
		mkdirSync(join(LOCK, "1"), { recursive: true });
		try {
			acquireLockNow(LOCK, "start");
			expect.unreachable("should have thrown");
		} catch (e) {
			expectErrorCode(e, "MACHINE_LOCKED");
		}
	});

	test("release appends a marker, and a second release is a no-op", () => {
		const first = acquireLockNow(LOCK, "start");
		first.release();
		const second = acquireLockNow(LOCK, "stop");
		first.release();
		expect(currentHolder(LOCK)?.op).toBe("stop");
		second.release();
		expect(currentHolder(LOCK)).toBeUndefined();
	});

	test("superseded records are collected; the top always remains", () => {
		for (let i = 0; i < 5; i++) acquireLockNow(LOCK, "start").release();
		expect(records()).toHaveLength(1);
	});

	test("release tolerates the directory having gone with remove()", () => {
		const lock = acquireLockNow(LOCK, "remove");
		rmSync(MACHINE_DIR, { recursive: true, force: true });
		expect(() => lock.release()).not.toThrow();
	});

	test("a missing machine directory is MACHINE_NOT_FOUND", () => {
		rmSync(MACHINE_DIR, { recursive: true, force: true });
		try {
			acquireLockNow(LOCK, "stop");
			expect.unreachable("should have thrown");
		} catch (e) {
			expectErrorCode(e, "MACHINE_NOT_FOUND");
		}
	});
});

describe("exclusion survives contenders whose judgement went stale (Codex review of #190)", () => {
	// A judged record 1 dead and paused. B judged the same, claimed 2 and holds it.
	// A wakes and acts on its old judgement; at every change A makes, C tries too.
	// Neither may get in while B holds.
	test("a paused contender cannot claim past a live holder that overtook it", () => {
		writeRecord(1, deadRecord());
		const b = acquireLockNow(LOCK, "start");
		const intruders: HeldLock[] = [];
		let a: HeldLock | undefined;
		interleaving(
			() => { try { intruders.push(acquireLockNow(LOCK, "clean")); } catch { /* refused: correct */ } },
			() => { a = claim(LOCK, 2, "stop"); },
		);
		expect(a).toBeUndefined();
		expect(intruders).toHaveLength(0);
		expect(currentHolder(LOCK)?.op).toBe("start");
		b.release();
	});

	test("a paused contender that wakes after the log moved on is turned away", () => {
		// B claims 2 and releases (marker 3, records below collected); C claims 4.
		// Record 2 is free again as a file name, and A's create of it succeeds — the
		// top check is what turns it away.
		writeRecord(1, deadRecord());
		acquireLockNow(LOCK, "start").release();
		const c = acquireLockNow(LOCK, "clean");
		expect(claim(LOCK, 2, "stop")).toBeUndefined();
		expect(currentHolder(LOCK)?.op).toBe("clean");
		expect(records()).toEqual([4]);
		c.release();
	});

	test("a contender paused across remove and re-create does not land in the new lock", () => {
		writeRecord(1, deadRecord());
		writeRecord(5, deadRecord());
		rmSync(MACHINE_DIR, { recursive: true, force: true });
		mkdirSync(MACHINE_DIR, { recursive: true });
		const x = acquireLockNow(LOCK, "start");
		expect(claim(LOCK, 6, "stop")).toBeUndefined();
		expect(currentHolder(LOCK)?.op).toBe("start");
		x.release();
	});

	test("two contenders recovering the same dead holder: exactly one wins", () => {
		writeRecord(1, deadRecord());
		const results = [claim(LOCK, 2, "start"), claim(LOCK, 2, "clean")];
		expect(results.filter(Boolean)).toHaveLength(1);
		for (const r of results) r?.release();
	});

	test("contenders interleaved with a takeover from a dead holder never overlap", () => {
		writeRecord(1, deadRecord());
		const intruders: HeldLock[] = [];
		let b: HeldLock | undefined;
		interleaving(
			() => { try { intruders.push(acquireLockNow(LOCK, "clean")); } catch { /* refused */ } },
			() => { try { b = acquireLockNow(LOCK, "start"); } catch { /* lost to an intruder */ } },
		);
		const winners = [b, ...intruders].filter(Boolean);
		expect(winners).toHaveLength(1);
		for (const w of winners) w?.release();
	});
});

describe("legacy .start-lock", () => {
	test("a live holder under the old name still holds the machine", async () => {
		const live = spawnIdle();
		try {
			writeFileSync(join(MACHINE_DIR, ".start-lock"), String(live.pid));
			try {
				acquireLockNow(LOCK, "stop");
				expect.unreachable("should have thrown");
			} catch (e) {
				expectErrorCode(e, "MACHINE_LOCKED");
				expect((e as Error).message).toContain(`pid ${live.pid}`);
			}
			// Refusing must not leave a new-style holder behind.
			expect(currentHolder(LOCK)).toBeUndefined();
		} finally {
			live.kill();
			await live.exited;
		}
	});

	test("a legacy lock still being written blocks, and is ignored once it is old", () => {
		// An older quickchr creates `.start-lock` empty and writes its pid in a second
		// syscall. Taking the machine in that window would run alongside it.
		const legacy = join(MACHINE_DIR, ".start-lock");
		writeFileSync(legacy, "");
		expect(() => acquireLockNow(LOCK, "clean")).toThrow();
		expect(currentHolder(LOCK)).toBeUndefined();
		backdate(legacy);
		acquireLockNow(LOCK, "clean").release();
	});

	test("an unreadable legacy lock blocks", () => {
		mkdirSync(join(MACHINE_DIR, ".start-lock"));
		try {
			acquireLockNow(LOCK, "clean");
			expect.unreachable("should have thrown");
		} catch (e) {
			expectErrorCode(e, "MACHINE_LOCKED");
		}
		expect(currentHolder(LOCK)).toBeUndefined();
	});

	test("a dead holder under the old name is ignored, not deleted", () => {
		const legacy = join(MACHINE_DIR, ".start-lock");
		writeFileSync(legacy, String(DEAD_PID));
		acquireLockNow(LOCK, "start").release();
		expect(existsSync(legacy)).toBe(true);
	});
});

describe("acquireLock (bounded wait)", () => {
	test("waits for a holder to release, then takes the lock", async () => {
		const held = acquireLockNow(LOCK, "start");
		const seen: string[] = [];
		setTimeout(() => held.release(), 300);
		const started = Date.now();
		const lock = await acquireLock(LOCK, "stop", { waitMs: 5_000, onWait: (h) => seen.push(h.op) });
		expect(Date.now() - started).toBeGreaterThanOrEqual(250);
		expect(seen).toEqual(["start"]);
		expect(currentHolder(LOCK)?.op).toBe("stop");
		lock.release();
	});

	test("gives up after waitMs and says how long it waited", async () => {
		const held = acquireLockNow(LOCK, "start");
		try {
			await acquireLock(LOCK, "stop", { waitMs: 300 });
			expect.unreachable("should have thrown");
		} catch (e) {
			expectErrorCode(e, "MACHINE_LOCKED");
			expect((e as Error).message).toContain("after waiting");
		} finally {
			held.release();
		}
	});

	test("does not wait for a foreground holder", async () => {
		const held = acquireLockNow(LOCK, "foreground");
		const started = Date.now();
		try {
			await acquireLock(LOCK, "stop", { waitMs: 10_000 });
			expect.unreachable("should have thrown");
		} catch (e) {
			expectErrorCode(e, "MACHINE_LOCKED");
			expect((e as Error).message).toContain("foreground");
			expect(Date.now() - started).toBeLessThan(1_000);
		} finally {
			held.release();
		}
	});

	test("a machine removed while waiting is MACHINE_NOT_FOUND", async () => {
		acquireLockNow(LOCK, "remove");
		setTimeout(() => rmSync(MACHINE_DIR, { recursive: true, force: true }), 200);
		try {
			await acquireLock(LOCK, "stop", { waitMs: 5_000 });
			expect.unreachable("should have thrown");
		} catch (e) {
			expectErrorCode(e, "MACHINE_NOT_FOUND");
		}
	});
});

describe("listReservations", () => {
	test("reads a live creator's claim and skips the named machine", () => {
		const lock = acquireLockNow(LOCK, "start", {
			reserve: { portBase: 9140, macs: ["02:00:00:00:00:01"] },
		});
		expect(listReservations()).toEqual([{ name: "alpha", portBase: 9140, macs: ["02:00:00:00:00:01"] }]);
		expect(listReservations("alpha")).toEqual([]);
		lock.release();
		expect(listReservations()).toEqual([]);
	});

	test("a crashed creator's claim is not a reservation", () => {
		writeRecord(1, JSON.stringify({
			pid: DEAD_PID, op: "start", at: new Date().toISOString(), token: "x",
			reserve: { portBase: 9140, macs: [] },
		}));
		expect(listReservations()).toEqual([]);
	});
});
