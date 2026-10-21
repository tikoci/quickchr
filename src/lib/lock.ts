/**
 * Cross-process file locks: the per-machine lifecycle lock and the data-dir-wide
 * allocation lock.
 *
 * One primitive for both. A lock is a file created with `link()`, which is atomic and
 * fails with EEXIST when the file is already there, and which publishes the file with
 * its whole record in place — there is no instant where the lock exists and is empty.
 * The old `open(wx)` + `write()` pair had that instant, and a concurrent reader that
 * treated an empty file as stale took the lock away from a live holder.
 *
 * A holder records `{ pid, op, at, token }`. The pid decides staleness (a dead holder's
 * lock is reaped), the op and age go into `MACHINE_LOCKED` so the refusal can say what
 * is holding the machine, and the token makes release ownership-checked: a holder only
 * ever deletes its own lock, never a successor's.
 *
 * The lock is deliberately not reentrant. Two async operations in one process are as
 * much in conflict as two processes are — a `stop()` and a `start()` in one
 * `Promise.all` must be ordered — so a lock held by this pid is a lock held by someone
 * else. Code that already holds a machine's lock calls the `*UnderLock` lifecycle
 * helpers in quickchr.ts rather than the public methods.
 */

import { existsSync, linkSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { QuickCHRError } from "./types.ts";
import { getDataDir, getMachinesDir } from "./state.ts";

/** What a lock holder is doing. `foreground` is a start whose QEMU runs attached to
 *  the caller's terminal: it holds the lock until the VM exits, so waiting for it is
 *  never useful. */
export type LockOperation =
	| "add"
	| "start"
	| "foreground"
	| "stop"
	| "clean"
	| "remove"
	| "device-mode"
	| "remove-orphan"
	| "allocate";

/** Resources a machine creation has claimed but not yet persisted in `machine.json`.
 *  Carried in the creator's machine lock, so it lives exactly as long as the create
 *  does and dies with a crashed creator's pid (#140). */
export interface ResourceReservation {
	portBase: number;
	macs: string[];
}

export interface LockRecord {
	pid: number;
	op: LockOperation;
	at: string;
	token: string;
	reserve?: ResourceReservation;
}

export interface HeldLock {
	readonly path: string;
	/** Delete the lock if it is still this holder's. Idempotent, and tolerant of the
	 *  directory having gone — `remove()` deletes the lock along with the machine. */
	release(): void;
}

export interface AcquireLockOptions {
	/** How long to wait for a live holder. 0 (the default) fails immediately. */
	waitMs?: number;
	/** Called once, when the first attempt finds a live holder and waiting begins. */
	onWait?: (holder: LockRecord) => void;
	reserve?: ResourceReservation;
	/** Noun for the refusal message, e.g. `Machine "foo"`. */
	subject?: string;
}

const MACHINE_LOCK_FILE = ".lock";
/** The pre-0.5 name. Honoured, and reaped when stale, for one release so a machine
 *  locked by an older quickchr is not taken from under it. */
const LEGACY_MACHINE_LOCK_FILE = ".start-lock";
const POLL_MS = 100;
/** A record that does not parse is only treated as abandoned once it is this old:
 *  `.start-lock`, written by an older quickchr, is created empty and filled by a second
 *  syscall. */
const UNREADABLE_GRACE_MS = 500;

export function machineLockPath(machineDir: string): string {
	return join(machineDir, MACHINE_LOCK_FILE);
}

/** Held across the read → probe → claim window of a machine creation, so two creates
 *  cannot pick the same port block or MAC (#140). Lives in the data dir root, not in
 *  `machines/`, where it would be listed as a machine. */
export function allocationLockPath(): string {
	return join(getDataDir(), ".allocate.lock");
}

function parseRecord(text: string): LockRecord | undefined {
	const trimmed = text.trim();
	// A legacy `.start-lock` holds a bare pid.
	if (/^\d+$/.test(trimmed)) {
		return { pid: Number.parseInt(trimmed, 10), op: "start", at: "", token: "" };
	}
	try {
		const parsed = JSON.parse(trimmed) as Partial<LockRecord>;
		if (typeof parsed.pid === "number" && parsed.pid > 0 && typeof parsed.op === "string") {
			return parsed as LockRecord;
		}
	} catch { /* fall through */ }
	return undefined;
}

type Inspection =
	| { state: "absent" }
	| { state: "live"; record: LockRecord; raw: string }
	| { state: "stale"; raw: string }
	| { state: "settling" };

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		// EPERM: the process exists but belongs to someone else.
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

function inspect(path: string): Inspection {
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		return { state: "absent" };
	}
	const record = parseRecord(raw);
	if (!record) {
		let ageMs = Number.POSITIVE_INFINITY;
		try { ageMs = Date.now() - statSync(path).mtimeMs; } catch { /* gone */ }
		return ageMs > UNREADABLE_GRACE_MS ? { state: "stale", raw } : { state: "settling" };
	}
	return isAlive(record.pid) ? { state: "live", record, raw } : { state: "stale", raw };
}

/** Remove a lock judged stale, without removing a fresh one that replaced it in the
 *  meantime. The lock is moved aside first and its contents compared with what was
 *  judged: if another reaper got there and a new holder already took the lock, the
 *  move caught the new holder's file, and it is put back. */
function reap(path: string, judgedRaw: string): void {
	const aside = `${path}.reap.${process.pid}.${crypto.randomUUID()}`;
	try {
		renameSync(path, aside);
	} catch {
		return; // already gone
	}
	let movedRaw: string | undefined;
	try { movedRaw = readFileSync(aside, "utf-8"); } catch { /* unreadable */ }
	if (movedRaw !== undefined && movedRaw !== judgedRaw) {
		try { linkSync(aside, path); } catch { /* someone holds it again; theirs stands */ }
	}
	try { unlinkSync(aside); } catch { /* ignore */ }
}

function tryCreate(path: string, record: LockRecord): boolean {
	const dir = dirname(path);
	if (!existsSync(dir)) {
		throw new QuickCHRError("MACHINE_NOT_FOUND", `${dir} no longer exists — the machine was removed.`);
	}
	const tmp = `${path}.${process.pid}.${record.token}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(record)}\n`);
	try {
		linkSync(tmp, path);
		return true;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
		if ((e as NodeJS.ErrnoException).code === "ENOENT") {
			throw new QuickCHRError("MACHINE_NOT_FOUND", `${dir} no longer exists — the machine was removed.`);
		}
		throw e;
	} finally {
		try { unlinkSync(tmp); } catch { /* ignore */ }
	}
}

function heldLock(path: string, token: string): HeldLock {
	let released = false;
	return {
		path,
		release() {
			if (released) return;
			released = true;
			const current = (() => {
				try { return parseRecord(readFileSync(path, "utf-8")); } catch { return undefined; }
			})();
			if (current?.token !== token) return;
			try { unlinkSync(path); } catch { /* removed with its directory */ }
		},
	};
}

function describeHolder(holder: LockRecord | undefined): string {
	if (!holder) return "another operation (holder still writing its lock)";
	const age = holder.at ? Math.max(0, Math.round((Date.now() - Date.parse(holder.at)) / 1000)) : undefined;
	return `\`${holder.op}\` (pid ${holder.pid}${age !== undefined && !Number.isNaN(age) ? `) since ${age}s` : ")"}`;
}

function lockedError(subject: string, holder: LockRecord | undefined, waitedMs: number): QuickCHRError {
	const waited = waitedMs > 0 ? ` after waiting ${Math.round(waitedMs / 1000)}s` : "";
	const hint = holder?.op === "foreground"
		? " It is running in the foreground: quit it from that console (Ctrl-A X)."
		: "";
	return new QuickCHRError("MACHINE_LOCKED", `${subject} is locked by ${describeHolder(holder)}${waited}.${hint}`);
}

/** A live holder under the legacy name, or undefined. A stale one is reaped. */
function legacyHolder(lockPath: string): LockRecord | undefined {
	if (basename(lockPath) !== MACHINE_LOCK_FILE) return undefined;
	const legacy = join(dirname(lockPath), LEGACY_MACHINE_LOCK_FILE);
	const seen = inspect(legacy);
	if (seen.state === "live") return seen.record;
	if (seen.state === "stale") reap(legacy, seen.raw);
	return undefined;
}

/** One attempt: the lock, or the live holder in the way (undefined while a holder is
 *  still writing an unreadable record). Stale and vanished locks are retried here. */
function attempt(lockPath: string, op: LockOperation, reserve: ResourceReservation | undefined): { lock: HeldLock } | { holder: LockRecord | undefined } {
	for (;;) {
		const record: LockRecord = {
			pid: process.pid,
			op,
			at: new Date().toISOString(),
			token: crypto.randomUUID(),
			...(reserve ? { reserve } : {}),
		};
		if (tryCreate(lockPath, record)) {
			const lock = heldLock(lockPath, record.token);
			const legacy = legacyHolder(lockPath);
			if (!legacy) return { lock };
			lock.release();
			return { holder: legacy };
		}
		const seen = inspect(lockPath);
		if (seen.state === "stale") {
			reap(lockPath, seen.raw);
			continue;
		}
		if (seen.state === "absent") continue;
		return { holder: seen.state === "live" ? seen.record : undefined };
	}
}

/** Take a lock or fail now with `MACHINE_LOCKED`. A dead holder's lock is reaped on
 *  sight. Synchronous, for callers whose answer to a live holder is always "no" — a
 *  second `start` of one machine would only boot it twice. */
export function acquireLockNow(lockPath: string, op: LockOperation, opts: Omit<AcquireLockOptions, "waitMs" | "onWait"> = {}): HeldLock {
	const result = attempt(lockPath, op, opts.reserve);
	if ("lock" in result) return result.lock;
	throw lockedError(opts.subject ?? "Machine", result.holder, 0);
}

/** Take a lock, waiting up to `waitMs` for a live holder to release it. A dead holder's
 *  lock is reaped on sight; a `foreground` holder is never waited for, since it keeps
 *  the lock until its VM exits.
 *
 *  Throws `MACHINE_LOCKED` naming the holder's operation, pid and age when the wait
 *  runs out, and `MACHINE_NOT_FOUND` if the lock's directory disappears — a machine
 *  removed while this caller waited. */
export async function acquireLock(lockPath: string, op: LockOperation, opts: AcquireLockOptions = {}): Promise<HeldLock> {
	const waitMs = opts.waitMs ?? 0;
	const started = Date.now();
	let notified = false;
	for (;;) {
		const result = attempt(lockPath, op, opts.reserve);
		if ("lock" in result) return result.lock;
		const { holder } = result;
		const waited = Date.now() - started;
		if (waited >= waitMs || holder?.op === "foreground") {
			throw lockedError(opts.subject ?? "Machine", holder, waited);
		}
		if (!notified && holder) {
			notified = true;
			opts.onWait?.(holder);
		}
		await Bun.sleep(Math.min(POLL_MS, waitMs - waited));
	}
}

/** Machines whose creation is in flight, with the port block and MACs each has
 *  claimed. Read from the creators' live machine locks; a crashed creator's
 *  reservation disappears with its pid. */
export function listReservations(exceptName?: string): Array<{ name: string } & ResourceReservation> {
	const machinesDir = getMachinesDir();
	let names: string[];
	try {
		names = readdirSync(machinesDir);
	} catch {
		return [];
	}
	const out: Array<{ name: string } & ResourceReservation> = [];
	for (const name of names) {
		if (name === exceptName) continue;
		const seen = inspect(machineLockPath(join(machinesDir, name)));
		if (seen.state === "live" && seen.record.reserve) {
			out.push({ name, ...seen.record.reserve });
		}
	}
	return out;
}
