/**
 * Cross-process coordination between storage admission, cache readers and cache
 * eviction (#199, Codex review of #203).
 *
 * One data-dir-wide lock, held only for the length of a check-and-record or an
 * eviction pass: never across a download or a boot. Under it, an operation records a
 * **lease** — a file naming the cache entries it is about to read (pins) and the bytes
 * it is about to write (reservations, per filesystem). Eviction runs under the same
 * lock and skips pinned entries; admission subtracts other live leases' reservations
 * from measured free space. A pin is recorded before the reader checks the entry
 * exists, so an eviction either sees the pin or has already finished — and then the
 * reader finds the entry gone and fetches it again.
 *
 * A lease lives exactly as long as its operation: released when the operation's
 * writes are done (or its machine.json, which protects the image from then on, is
 * saved), and ignored and deleted once its pid is dead. While an operation is still
 * writing, its reservation and the bytes already written are both counted — a
 * deliberate over-estimate for the length of one create.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { acquireLockNow, type HeldLock } from "./lock.ts";
import { ensureDir, getDataDir } from "./state.ts";
import { renameWithRetry } from "./rename.ts";
import { QuickCHRError } from "./types.ts";

/** Bytes an in-flight operation will write to one filesystem, by `stat().dev`. */
export interface StorageReservation {
	dev: number;
	bytes: number;
}

export interface LeaseRecord {
	pid: number;
	at: string;
	/** What the operation is, for diagnostics. */
	action: string;
	/** Cache entry names (as `cacheInventory` gives them) that must not be evicted. */
	pins: string[];
	reservations: StorageReservation[];
}

export interface StorageLease {
	readonly record: LeaseRecord;
	/** Idempotent. */
	release(): void;
}

const LOCK_WAIT_MS = 30_000;
const LOCK_POLL_MS = 25;

export function storageLockPath(): string {
	return join(getDataDir(), ".storage.lock");
}

function leaseDir(): string {
	return join(getDataDir(), ".storage-leases");
}

export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Run `fn` holding the storage lock. Synchronous: holders keep it for milliseconds
 *  (a check, or one eviction pass), so a short spin is simpler than making every
 *  caller async. The lock is not reentrant: `fn` must not take it again. */
export function withStorageLock<T>(fn: () => T): T {
	ensureDir(getDataDir());
	const deadline = Date.now() + LOCK_WAIT_MS;
	let lock: HeldLock | undefined;
	for (;;) {
		try {
			lock = acquireLockNow(storageLockPath(), "storage", { subject: "The storage lock" });
			break;
		} catch (error) {
			if (!(error instanceof QuickCHRError) || error.code !== "MACHINE_LOCKED" || Date.now() >= deadline) throw error;
			Bun.sleepSync(LOCK_POLL_MS);
		}
	}
	try {
		return fn();
	} finally {
		lock.release();
	}
}

/** Every live lease. Leases of dead processes are deleted. Call under the lock. */
export function liveLeases(): LeaseRecord[] {
	let names: string[];
	try {
		names = readdirSync(leaseDir());
	} catch {
		return [];
	}
	const live: LeaseRecord[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const path = join(leaseDir(), name);
		try {
			const record = JSON.parse(readFileSync(path, "utf8")) as LeaseRecord;
			if (isPidAlive(record.pid)) {
				live.push(record);
				continue;
			}
		} catch { /* unreadable: a writer died mid-write — files are renamed into place */ }
		rmSync(path, { force: true });
	}
	return live;
}

/** Pins of live leases, read without the lock (for `cache list`'s IN-USE column). */
export function pinnedEntries(): Set<string> {
	const pins = new Set<string>();
	try {
		for (const name of readdirSync(leaseDir())) {
			if (!name.endsWith(".json")) continue;
			try {
				const record = JSON.parse(readFileSync(join(leaseDir(), name), "utf8")) as LeaseRecord;
				if (isPidAlive(record.pid)) for (const pin of record.pins) pins.add(pin);
			} catch { /* being written or removed */ }
		}
	} catch { /* no leases */ }
	return pins;
}

/** Record a lease. Call under the lock, after the checks it stands for. */
export function createLease(action: string, pins: string[], reservations: StorageReservation[]): StorageLease {
	const record: LeaseRecord = { pid: process.pid, at: new Date().toISOString(), action, pins, reservations };
	mkdirSync(leaseDir(), { recursive: true });
	const path = join(leaseDir(), `${process.pid}-${crypto.randomUUID()}.json`);
	writeFileSync(`${path}.tmp`, JSON.stringify(record));
	renameWithRetry(`${path}.tmp`, path);
	let released = false;
	return {
		record,
		release() {
			if (released) return;
			released = true;
			rmSync(path, { force: true });
		},
	};
}

/** Pin cache entries for the length of a read that is not otherwise protected (a
 *  running machine installing packages). Release when done. */
export function pinCacheEntries(action: string, pins: string[]): StorageLease {
	return withStorageLock(() => createLease(action, pins, []));
}

/** The filesystem a path is (or will be) written on: `stat().dev` of its nearest
 *  existing ancestor, and that ancestor. */
export function filesystemOf(path: string): { dev: number; statPath: string } {
	let current = path || ".";
	for (;;) {
		try {
			return { dev: statSync(current).dev, statPath: current };
		} catch {
			const parent = dirname(current);
			if (parent === current) return { dev: statSync(".").dev, statPath: "." };
			current = parent;
		}
	}
}
