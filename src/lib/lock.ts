/**
 * Cross-process file locks: the per-machine lifecycle lock and the data-dir-wide
 * allocation lock.
 *
 * One primitive for both. A lock is a directory holding an append-only log of
 * numbered records, and the **highest number is the lock's state**: a live holder's
 * record means held; a released marker, a dead holder's record, or no record at all
 * means free. Taking the lock is creating record top+1, published with `link()` so only
 * one contender can create it and it never exists half-written. Releasing appends a
 * released marker. Superseded records below the top are garbage-collected.
 *
 * Nothing ever deletes a record another process may still hold. That is the point:
 * a path has no compare-and-delete, so any recovery that deletes a dead holder's lock
 * by path has a window between judging it dead and deleting it, and a successor can be
 * installed in that window and then deleted. Rename-aside-and-compare had that window,
 * and so did a reap guard recovered by age (Codex review of #190, both reproduced).
 * Here, recovering from a dead holder is just claiming the next number.
 *
 * A claim stands only if, once created, nothing higher exists and its predecessor is
 * still there. A contender paused across other claims can wake and create a number
 * that collection made free again, and that check is what turns it away.
 *
 * **A log is never deleted**, so a machine's log lives in `<dataDir>/locks/<name>/`,
 * not in the machine directory `remove()` deletes. If the log went with the machine, a
 * re-created machine would start a new log at record 1, and anyone holding a number
 * from the old log would land in the new one: a release would append into it and
 * collect the new holder's record, and a claim would match by number alone (Codex
 * review of #190). The cost is one small directory per machine name ever used.
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

import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
	/** Append a released marker. Idempotent. */
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

/** The pre-0.5 lock file, in the machine directory. For one release a live holder is honoured, so a machine
 *  locked by an older quickchr is not taken from under it. A dead one is ignored, not
 *  deleted: deleting by path is the race this module exists to avoid, and the older
 *  quickchr recovers its own stale file. */
const LEGACY_MACHINE_LOCK_FILE = ".start-lock";
const POLL_MS = 100;
/** A record that does not parse only counts as abandoned once it is this old. An older
 *  quickchr creates `.start-lock` empty and fills it in with a second syscall. */
const UNREADABLE_GRACE_MS = 500;

function locksDir(): string {
	return join(getDataDir(), "locks");
}

/** A machine's lock log, by name. Outside `machines/<name>/` so it outlives the
 *  machine: see the module comment. */
export function machineLockPath(name: string): string {
	return join(locksDir(), name);
}

/** Where an older quickchr locks a machine. */
export function legacyMachineLockPath(machineDir: string): string {
	return join(machineDir, LEGACY_MACHINE_LOCK_FILE);
}

/** Held across the read → probe → claim window of a machine creation, so two creates
 *  cannot pick the same port block or MAC (#140). The leading dot keeps it from
 *  colliding with a machine name. */
export function allocationLockPath(): string {
	return join(locksDir(), ".allocate");
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
	| { state: "free" }
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
		return ageMs > UNREADABLE_GRACE_MS ? { state: "free" } : { state: "unknown" };
	}
	if (record.released) return { state: "free" };
	return isAlive(record.pid) ? { state: "live", record } : { state: "free" };
}

function generations(lockDir: string): number[] {
	return readdirSync(lockDir).filter((f) => /^\d+$/.test(f)).map(Number);
}

/** Publish `content` at `path` only if nothing is there. Written to a temp file and
 *  `link()`ed into place, so the file never exists half-written. */
function linkNew(path: string, content: string): boolean {
	const tmp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
	writeFileSync(tmp, content);
	try {
		linkSync(tmp, path);
		mutationObserver?.("link", path);
		return true;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
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
		try {
			unlinkSync(join(lockDir, String(gen)));
			mutationObserver?.("unlink", join(lockDir, String(gen)));
		} catch { /* another collector got it */ }
	}
}

function ensureLockDir(lockDir: string): void {
	mkdirSync(lockDir, { recursive: true });
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

/** Try to take the lock as record `gen`, having judged record `gen - 1` free (or the
 *  directory empty, for `gen` 1). Returns the lock, or undefined when another contender
 *  got there first or the judgement turned out to be stale. */
export function claim(lockDir: string, gen: number, op: LockOperation, reserve?: ResourceReservation): HeldLock | undefined {
	const record: LockRecord = {
		pid: process.pid,
		op,
		at: new Date().toISOString(),
		token: crypto.randomUUID(),
		...(reserve ? { reserve } : {}),
	};
	const path = join(lockDir, String(gen));
	if (!linkNew(path, `${JSON.stringify(record)}\n`)) return undefined;

	// The number may be free again only because collection removed it after the log
	// moved on. Then it is not the top.
	const gens = generations(lockDir);
	const isTop = !gens.some((g) => g > gen);
	const followsPredecessor = gen === 1 ? gens.length === 1 : gens.includes(gen - 1);
	if (!isTop || !followsPredecessor) {
		try { unlinkSync(path); } catch { /* collected already */ }
		mutationObserver?.("unlink", path);
		return undefined;
	}
	collect(lockDir, gen);
	return heldLock(lockDir, gen, record);
}

function heldLock(lockDir: string, gen: number, record: LockRecord): HeldLock {
	let released = false;
	return {
		path: lockDir,
		release() {
			if (released) return;
			released = true;
			const marker: LockRecord = { ...record, released: true, at: new Date().toISOString() };
			delete marker.reserve;
			// EEXIST means someone judged this holder dead and took over — nothing of ours
			// is left to release.
			if (linkNew(join(lockDir, String(gen + 1)), `${JSON.stringify(marker)}\n`)) collect(lockDir, gen + 1);
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
		const lock = claim(lockDir, (top?.gen ?? 0) + 1, op, opts.reserve);
		if (!lock) continue;
		const legacy = legacyBlocker(opts.legacyPath);
		if (!legacy) return { lock };
		lock.release();
		return legacy;
	}
}

/** Take a lock or fail now with `MACHINE_LOCKED`. A dead holder's lock is taken over
 *  on sight. Synchronous, for callers whose answer to a live holder is always "no" — a
 *  second `start` of one machine would only boot it twice. */
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
 *  runs out. The lock outlives its machine, so a caller that waited must check the
 *  machine is still the one it meant. */
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
	if (!existsSync(lockPath)) return undefined;
	for (;;) {
		const top = readTop(lockPath);
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
		let holder: LockRecord | undefined;
		try { holder = currentHolder(machineLockPath(name)); } catch { continue; }
		if (holder?.reserve) out.push({ name, ...holder.reserve });
	}
	return out;
}
