/**
 * Cross-process file locks: the per-machine lifecycle lock and the data-dir-wide
 * allocation lock.
 *
 * One primitive for both. A lock is a directory holding an append-only log of
 * numbered records, and the **highest number is the lock's state**: a live holder's
 * record means held; a released marker, a dead holder's record, or no record at all
 * means free. Taking the lock is creating record top+1, published with `link()` so only
 * one contender can create it and it never exists half-written. Releasing appends a
 * released marker. Superseded records below the top are collected.
 *
 * No recovery deletes a record another process may hold. A path has no
 * compare-and-delete, so deleting a dead holder's lock by path leaves a window between
 * judging it dead and deleting it, and a successor installed in that window is
 * deleted too. Rename-aside-and-compare had that window, and so did a reap guard
 * recovered by age (Codex review of #190, both reproduced). Here, recovering from a
 * dead holder is just claiming the next number.
 *
 * **A claim is checked against the exact record it judged free**, not just that
 * record's number. Every record carries a unique token, so once created, a claim
 * stands only if nothing higher exists and its predecessor is still byte-for-byte
 * what was judged. That turns away a contender that slept through other claims, or
 * through the log being deleted and started again. A number can recur; a record
 * cannot.
 *
 * **Only a holder deletes a lock directory**: `remove()` takes the machine's
 * directory with its lock inside, and a failed create discards what it made. So a
 * machine's lock lives and dies with `machines/<name>/`, and nothing is kept after a
 * machine is gone. Release appends only after the holder's own record. A holder that
 * deleted its directory finds that record gone, and its release does nothing, rather
 * than appending into whatever log a new machine of the same name has started. That
 * check and the append cannot race a deletion, because the only process that could
 * delete the log is the holder itself.
 *
 * A holder records `{ pid, op, at, token }`. The pid decides liveness, the op and age
 * go into `MACHINE_LOCKED` so the refusal can say what is holding the machine, and a
 * creation carries its port/MAC reservation (#140).
 *
 * The lock is deliberately not reentrant. Two async operations in one process are as
 * much in conflict as two processes are — a `stop()` and a `start()` in one
 * `Promise.all` must be ordered — so a lock held by this pid is a lock held by someone
 * else. Code that already holds a machine's lock calls the `*UnderLock` lifecycle
 * helpers in quickchr.ts rather than the public methods.
 */

import { linkSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
	/** A released marker: the holder before it let go. */
	released?: true;
}

export interface HeldLock {
	readonly path: string;
	/** Append a released marker after this holder's record. Idempotent, and a no-op
	 *  once the holder has deleted the lock's directory. */
	release(): void;
}

export interface AcquireLockOptions {
	/** How long to wait for a live holder. 0 (the default) fails immediately. */
	waitMs?: number;
	/** A pre-0.5 `.start-lock` to honour alongside this lock. */
	legacyPath?: string;
	/** Called once, when the first attempt finds a live holder and waiting begins. */
	onWait?: (holder: LockRecord) => void;
	reserve?: ResourceReservation;
	/** Noun for the refusal message, e.g. `Machine "foo"`. */
	subject?: string;
}

/** The pre-0.5 lock file, in the machine directory. For one release a live holder is
 *  honoured, so a machine locked by an older quickchr is not taken from under it. A
 *  dead one is ignored, not deleted: the older quickchr recovers its own stale file. */
const LEGACY_MACHINE_LOCK_FILE = ".start-lock";
const POLL_MS = 100;
/** A record that does not parse only counts as abandoned once it is this old. An older
 *  quickchr creates `.start-lock` empty and fills it in with a second syscall. */
const UNREADABLE_GRACE_MS = 500;

/** A machine's lock, inside its directory so it goes when the machine does. */
export function machineLockPath(machineDir: string): string {
	return join(machineDir, ".lock");
}

/** Where an older quickchr locks a machine. */
export function legacyMachineLockPath(machineDir: string): string {
	return join(machineDir, LEGACY_MACHINE_LOCK_FILE);
}

/** Held across the read → probe → claim window of a machine creation, so two creates
 *  cannot pick the same port block or MAC (#140). Lives in the data dir root, not in
 *  `machines/`, where it would be listed as a machine. One fixed directory: its log
 *  collects down to a single record. */
export function allocationLockPath(): string {
	return join(getDataDir(), ".allocate.lock");
}

/** Test seam: called after each change this module makes inside a lock directory, so
 *  a test can interleave another contender at exactly that point. */
let mutationObserver: ((op: "link" | "unlink", path: string) => void) | undefined;
export function _observeLockMutations(fn: typeof mutationObserver): void {
	mutationObserver = fn;
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
	| { state: "live"; record: LockRecord }
	| { state: "free"; raw: string }
	| { state: "unknown" };

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		// EPERM: the process exists but belongs to someone else.
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

function readRaw(path: string): string | undefined {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return undefined;
	}
}

/** One record file. `unknown` is a file whose holder cannot be checked: unreadable
 *  (EACCES from another user's lock, EISDIR, I/O), or unparseable and new enough that
 *  its writer may not have finished. */
function inspect(path: string): Inspection {
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "ENOENT" ? { state: "absent" } : { state: "unknown" };
	}
	const record = parseRecord(raw);
	if (!record) {
		let ageMs = Number.POSITIVE_INFINITY;
		try { ageMs = Date.now() - statSync(path).mtimeMs; } catch { /* gone */ }
		return ageMs > UNREADABLE_GRACE_MS ? { state: "free", raw } : { state: "unknown" };
	}
	if (record.released) return { state: "free", raw };
	return isAlive(record.pid) ? { state: "live", record } : { state: "free", raw };
}

function missing(lockDir: string): QuickCHRError {
	return new QuickCHRError("MACHINE_NOT_FOUND", `${dirname(lockDir)} no longer exists — the machine was removed.`);
}

/** The record numbers in a lock. A lock whose parent directory has gone belongs to a
 *  machine that was removed. */
function generations(lockDir: string): number[] {
	try {
		return readdirSync(lockDir).filter((f) => /^\d+$/.test(f)).map(Number);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") throw missing(lockDir);
		throw e;
	}
}

/** The lock directory, created if its parent exists. Never the parent: a waiter must
 *  not bring a removed machine's directory back as an empty orphan. */
function ensureLockDir(lockDir: string): void {
	try {
		mkdirSync(lockDir);
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === "ENOENT") throw missing(lockDir);
		if (code !== "EEXIST") throw e;
	}
}

/** Publish `content` at `path` only if nothing is there. Written to a temp file and
 *  `link()`ed into place, so the file never exists half-written. */
function linkNew(path: string, content: string): boolean {
	const tmp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		writeFileSync(tmp, content);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") throw missing(dirname(path));
		throw e;
	}
	try {
		linkSync(tmp, path);
		mutationObserver?.("link", path);
		return true;
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === "EEXIST") return false;
		if (code === "ENOENT") throw missing(dirname(path));
		throw e;
	} finally {
		try { unlinkSync(tmp); } catch { /* ignore */ }
	}
}

/** Delete superseded records below `keepFrom`. Never the top: every caller has just
 *  created a record at or above `keepFrom`. */
function collect(lockDir: string, keepFrom: number): void {
	let gens: number[];
	try { gens = generations(lockDir); } catch { return; }
	for (const gen of gens) {
		if (gen >= keepFrom) continue;
		const path = join(lockDir, String(gen));
		try {
			unlinkSync(path);
			mutationObserver?.("unlink", path);
		} catch { /* another collector got it */ }
	}
}

type Top = { gen: number; seen: Inspection } | undefined;

/** The top record, or `"vanished"` when it went between listing and reading — a
 *  release collected it — and the caller should look again. */
function readTop(lockDir: string): Top | "vanished" {
	const gens = generations(lockDir);
	if (gens.length === 0) return undefined;
	const gen = Math.max(...gens);
	const seen = inspect(join(lockDir, String(gen)));
	return seen.state === "absent" ? "vanished" : { gen, seen };
}

/** Try to take the lock as record `gen`, having judged record `gen - 1` free with
 *  contents `judgedRaw` (or the lock empty, for `gen` 1 with no `judgedRaw`). Returns
 *  the lock, or undefined when another contender got there first or the judgement
 *  turned out to be stale. */
export function claim(
	lockDir: string,
	gen: number,
	op: LockOperation,
	judgedRaw?: string,
	reserve?: ResourceReservation,
): HeldLock | undefined {
	const record: LockRecord = {
		pid: process.pid,
		op,
		at: new Date().toISOString(),
		token: crypto.randomUUID(),
		...(reserve ? { reserve } : {}),
	};
	const raw = `${JSON.stringify(record)}\n`;
	const path = join(lockDir, String(gen));
	if (!linkNew(path, raw)) return undefined;

	const gens = generations(lockDir);
	const isTop = !gens.some((g) => g > gen);
	const followsJudged = judgedRaw === undefined
		? gen === 1 && gens.length === 1
		: readRaw(join(lockDir, String(gen - 1))) === judgedRaw;
	if (!isTop || !followsJudged) {
		try { unlinkSync(path); } catch { /* collected already */ }
		mutationObserver?.("unlink", path);
		return undefined;
	}
	collect(lockDir, gen);
	return heldLock(lockDir, gen, record, raw);
}

function heldLock(lockDir: string, gen: number, record: LockRecord, raw: string): HeldLock {
	let released = false;
	return {
		path: lockDir,
		release() {
			if (released) return;
			released = true;
			// Gone means this holder deleted the directory — remove(), or a failed create
			// discarding what it made. A same-named machine may have started a new log
			// there since, and a marker would land in it.
			if (readRaw(join(lockDir, String(gen))) !== raw) return;
			const marker: LockRecord = { ...record, released: true, at: new Date().toISOString() };
			delete marker.reserve;
			try {
				// EEXIST means someone judged this holder dead and took over — nothing of
				// ours is left to release.
				if (linkNew(join(lockDir, String(gen + 1)), `${JSON.stringify(marker)}\n`)) collect(lockDir, gen + 1);
			} catch { /* deleted after all */ }
		},
	};
}

function describeHolder(holder: LockRecord | undefined): string {
	if (!holder) return "another operation (its lock record is unreadable or still being written)";
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

/** Whether a legacy `.start-lock` stands in the way, and its holder when that can be
 *  read. One that is unreadable, or so new its holder may still be writing it, blocks:
 *  going ahead in that window would run alongside an older quickchr. */
function legacyBlocker(legacyPath: string | undefined): { holder: LockRecord | undefined } | undefined {
	if (!legacyPath) return undefined;
	const seen = inspect(legacyPath);
	if (seen.state === "live") return { holder: seen.record };
	if (seen.state === "unknown") return { holder: undefined };
	return undefined;
}

/** One attempt: the lock, or the holder in the way (undefined when its record cannot
 *  be read). */
function attempt(lockDir: string, op: LockOperation, opts: AcquireLockOptions): { lock: HeldLock } | { holder: LockRecord | undefined } {
	ensureLockDir(lockDir);
	for (;;) {
		const top = readTop(lockDir);
		if (top === "vanished") continue;
		if (top?.seen.state === "live") return { holder: top.seen.record };
		if (top?.seen.state === "unknown") return { holder: undefined };
		const judged = top?.seen.state === "free" ? top.seen.raw : undefined;
		const lock = claim(lockDir, (top?.gen ?? 0) + 1, op, judged, opts.reserve);
		if (!lock) continue;
		const legacy = legacyBlocker(opts.legacyPath);
		if (!legacy) return { lock };
		lock.release();
		return legacy;
	}
}

/** Take a lock or fail now with `MACHINE_LOCKED`. A dead holder's lock is taken over
 *  on sight. Synchronous, for callers whose answer to a live holder is always "no" — a
 *  second `start` of one machine would only boot it twice. Throws `MACHINE_NOT_FOUND`
 *  if the lock's machine directory does not exist. */
export function acquireLockNow(lockPath: string, op: LockOperation, opts: Omit<AcquireLockOptions, "waitMs" | "onWait"> = {}): HeldLock {
	const result = attempt(lockPath, op, opts);
	if ("lock" in result) return result.lock;
	throw lockedError(opts.subject ?? "Machine", result.holder, 0);
}

/** Take a lock, waiting up to `waitMs` for a live holder to release it. A dead holder's
 *  lock is taken over on sight; a `foreground` holder is never waited for, since it
 *  keeps the lock until its VM exits.
 *
 *  Throws `MACHINE_LOCKED` naming the holder's operation, pid and age when the wait
 *  runs out, and `MACHINE_NOT_FOUND` if the machine is removed while this caller
 *  waits. */
export async function acquireLock(lockPath: string, op: LockOperation, opts: AcquireLockOptions = {}): Promise<HeldLock> {
	const waitMs = opts.waitMs ?? 0;
	const started = Date.now();
	let notified = false;
	for (;;) {
		const result = attempt(lockPath, op, opts);
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

/** The live holder of a lock, if any. */
export function currentHolder(lockPath: string): LockRecord | undefined {
	for (;;) {
		let top: Top | "vanished";
		try {
			top = readTop(lockPath);
		} catch {
			return undefined; // no lock directory, so no holder
		}
		if (top === "vanished") continue;
		return top?.seen.state === "live" ? top.seen.record : undefined;
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
		const holder = currentHolder(machineLockPath(join(machinesDir, name)));
		if (holder?.reserve) out.push({ name, ...holder.reserve });
	}
	return out;
}
