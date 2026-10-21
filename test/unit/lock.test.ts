import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireLock, acquireLockNow, listReservations, machineLockPath } from "../../src/lib/lock.ts";

/**
 * The lock primitive behind the per-machine lifecycle lock (#181) and the allocation
 * lock (#140). No QEMU: holders are this process or a `sleep` child, and a dead holder
 * is a pid that cannot exist.
 */

const TEST_DIR = join(import.meta.dir, ".tmp-lock");
const MACHINE_DIR = join(TEST_DIR, "machines", "alpha");
const DEAD_PID = 99999999;
const origDataDir = process.env.QUICKCHR_DATA_DIR;

/** A live process to stand in for a holder or a QEMU — Bun itself, so it exists on
 *  Windows too. */
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

beforeEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(MACHINE_DIR, { recursive: true });
	process.env.QUICKCHR_DATA_DIR = TEST_DIR;
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	if (origDataDir === undefined) delete process.env.QUICKCHR_DATA_DIR;
	else process.env.QUICKCHR_DATA_DIR = origDataDir;
});

describe("acquireLockNow", () => {
	test("takes a free lock and records who holds it", () => {
		const path = machineLockPath(MACHINE_DIR);
		const lock = acquireLockNow(path, "start");
		const record = JSON.parse(readFileSync(path, "utf-8"));
		expect(record.pid).toBe(process.pid);
		expect(record.op).toBe("start");
		expect(typeof record.token).toBe("string");
		lock.release();
		expect(existsSync(path)).toBe(false);
	});

	test("a live holder fails it with MACHINE_LOCKED naming the operation and pid", () => {
		const path = machineLockPath(MACHINE_DIR);
		const held = acquireLockNow(path, "start");
		try {
			acquireLockNow(path, "start", { subject: 'Machine "alpha"' });
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
		const path = machineLockPath(MACHINE_DIR);
		const held = acquireLockNow(path, "stop");
		expect(() => acquireLockNow(path, "start")).toThrow();
		held.release();
	});

	test("reaps a lock whose holder is dead", () => {
		const path = machineLockPath(MACHINE_DIR);
		writeFileSync(path, JSON.stringify({ pid: DEAD_PID, op: "start", at: new Date().toISOString(), token: "x" }));
		const lock = acquireLockNow(path, "start");
		expect(JSON.parse(readFileSync(path, "utf-8")).pid).toBe(process.pid);
		lock.release();
	});

	test("an unreadable record is reaped once it is old, not while it may still be written", () => {
		const path = machineLockPath(MACHINE_DIR);
		writeFileSync(path, "");
		expect(() => acquireLockNow(path, "start")).toThrow();
		backdate(path);
		acquireLockNow(path, "start").release();
	});

	test("a lock that exists but cannot be read is a holder, not an absence", () => {
		// EEXIST on create, then EISDIR on read — the shape of another user's lock
		// under a restrictive umask (EACCES), without depending on permissions that
		// root ignores. Reading that as "absent" retried the create forever.
		const path = machineLockPath(MACHINE_DIR);
		mkdirSync(path);
		try {
			acquireLockNow(path, "start");
			expect.unreachable("should have thrown");
		} catch (e) {
			expectErrorCode(e, "MACHINE_LOCKED");
		}
		expect(existsSync(path)).toBe(true);
	});

	test("release never deletes a successor's lock", () => {
		const path = machineLockPath(MACHINE_DIR);
		const first = acquireLockNow(path, "start");
		first.release();
		const second = acquireLockNow(path, "stop");
		first.release();
		expect(JSON.parse(readFileSync(path, "utf-8")).op).toBe("stop");
		second.release();
	});

	test("release tolerates the directory having gone with remove()", () => {
		const lock = acquireLockNow(machineLockPath(MACHINE_DIR), "remove");
		rmSync(MACHINE_DIR, { recursive: true, force: true });
		expect(() => lock.release()).not.toThrow();
	});

	test("a missing machine directory is MACHINE_NOT_FOUND", () => {
		rmSync(MACHINE_DIR, { recursive: true, force: true });
		try {
			acquireLockNow(machineLockPath(MACHINE_DIR), "stop");
			expect.unreachable("should have thrown");
		} catch (e) {
			expectErrorCode(e, "MACHINE_NOT_FOUND");
		}
	});
});

describe("legacy .start-lock", () => {
	test("a live holder under the old name still holds the machine", async () => {
		const live = spawnIdle();
		try {
			writeFileSync(join(MACHINE_DIR, ".start-lock"), String(live.pid));
			try {
				acquireLockNow(machineLockPath(MACHINE_DIR), "stop");
				expect.unreachable("should have thrown");
			} catch (e) {
				expectErrorCode(e, "MACHINE_LOCKED");
				expect((e as Error).message).toContain(`pid ${live.pid}`);
			}
			// Refusing must not leave the new-name lock behind.
			expect(existsSync(machineLockPath(MACHINE_DIR))).toBe(false);
		} finally {
			live.kill();
			await live.exited;
		}
	});

	test("a dead holder under the old name is reaped", () => {
		const legacy = join(MACHINE_DIR, ".start-lock");
		writeFileSync(legacy, String(DEAD_PID));
		acquireLockNow(machineLockPath(MACHINE_DIR), "start").release();
		expect(existsSync(legacy)).toBe(false);
	});
});

describe("acquireLock (bounded wait)", () => {
	test("waits for a holder to release, then takes the lock", async () => {
		const path = machineLockPath(MACHINE_DIR);
		const held = acquireLockNow(path, "start");
		const seen: string[] = [];
		setTimeout(() => held.release(), 300);
		const started = Date.now();
		const lock = await acquireLock(path, "stop", { waitMs: 5_000, onWait: (h) => seen.push(h.op) });
		expect(Date.now() - started).toBeGreaterThanOrEqual(250);
		expect(seen).toEqual(["start"]);
		expect(JSON.parse(readFileSync(path, "utf-8")).op).toBe("stop");
		lock.release();
	});

	test("gives up after waitMs and says how long it waited", async () => {
		const path = machineLockPath(MACHINE_DIR);
		const held = acquireLockNow(path, "start");
		try {
			await acquireLock(path, "stop", { waitMs: 300 });
			expect.unreachable("should have thrown");
		} catch (e) {
			expectErrorCode(e, "MACHINE_LOCKED");
			expect((e as Error).message).toContain("after waiting");
		} finally {
			held.release();
		}
	});

	test("does not wait for a foreground holder", async () => {
		const path = machineLockPath(MACHINE_DIR);
		const held = acquireLockNow(path, "foreground");
		const started = Date.now();
		try {
			await acquireLock(path, "stop", { waitMs: 10_000 });
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
		const path = machineLockPath(MACHINE_DIR);
		acquireLockNow(path, "remove");
		setTimeout(() => rmSync(MACHINE_DIR, { recursive: true, force: true }), 200);
		try {
			await acquireLock(path, "stop", { waitMs: 5_000 });
			expect.unreachable("should have thrown");
		} catch (e) {
			expectErrorCode(e, "MACHINE_NOT_FOUND");
		}
	});
});

describe("listReservations", () => {
	test("reads a live creator's claim and skips the named machine", () => {
		const lock = acquireLockNow(machineLockPath(MACHINE_DIR), "start", {
			reserve: { portBase: 9140, macs: ["02:00:00:00:00:01"] },
		});
		expect(listReservations()).toEqual([{ name: "alpha", portBase: 9140, macs: ["02:00:00:00:00:01"] }]);
		expect(listReservations("alpha")).toEqual([]);
		lock.release();
		expect(listReservations()).toEqual([]);
	});

	test("a crashed creator's claim is not a reservation", () => {
		writeFileSync(machineLockPath(MACHINE_DIR), JSON.stringify({
			pid: DEAD_PID, op: "start", at: new Date().toISOString(), token: "x",
			reserve: { portBase: 9140, macs: [] },
		}));
		expect(listReservations()).toEqual([]);
	});
});
