/**
 * Named socket registry — persistent named L2 links between CHR instances.
 * Socket entries are stored as JSON files in ~/.local/share/quickchr/networks/.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, openSync, closeSync, writeSync, renameSync } from "node:fs";
import { join } from "node:path";
import { QuickCHRError } from "./types.ts";
import { getDataDir } from "./state.ts";
import { assertValidResourceName, assertPathSafeName } from "./names.ts";

/** Transport a named socket uses to carry guest frames.
 *
 *  - `dgram` — a pair of unix datagram sockets (QEMU >= 7.2). No ports, no UDP
 *    syscalls, and **either end may start first**. Two members. POSIX only:
 *    Windows' AF_UNIX has no SOCK_DGRAM.
 *  - `listen-connect` — a TCP pair on loopback. Two members; the first to join takes
 *    the listening slot and keeps it, so that machine starts first thereafter.
 *    The Windows default.
 *  - `mcast` — UDP multicast, the only N-way segment. Broken on macOS and in
 *    sandboxes that block UDP, and it fails *silently* in both (see DESIGN.md).
 */
export type SocketMode = "mcast" | "listen-connect" | "dgram";

export interface SocketEntry {
	name: string;
	mode: SocketMode;
	mcastGroup?: string;
	/** Host port for `listen-connect` and `mcast`. Absent on a `dgram` link, which
	 *  addresses its ends by filesystem path and uses no port at all — carrying a
	 *  number there would be a field that looks meaningful and is not. */
	port?: number;
	createdAt: string;
	/** Machines that currently reference this socket. */
	members: string[];
	/** Slot occupancy for the two-member modes: index is the endpoint, value is the
	 *  machine holding it or `null` when free.
	 *
	 *  Slot 0 is the listener (`listen-connect`) or endpoint A (`dgram`). The role has
	 *  to be *persisted* rather than derived from `members.length`, which is what made
	 *  `listen-connect` a dead link for its whole life: `registerSocketMembers()` runs
	 *  before `resolveAllNetworks()`, so the starting machine had always added itself
	 *  by the time the resolver asked whether it was first, and every member resolved
	 *  to `connect=`. Nobody ever listened. */
	endpoints?: (string | null)[];
	/** Auto-created by `start()` (true) vs explicit user/CLI creation (false). */
	autoCreated: boolean;
}

const DEFAULT_START_PORT = 4000;
const DEFAULT_MCAST_GROUP = "230.0.0.1";

/** `sun_path` is 104 bytes on macOS and 108 on Linux; QEMU rejects a longer path at
 *  spawn with `UNIX socket path '...' is too long`. Checked here so the error names
 *  the data dir instead of arriving as a QEMU spawn failure. */
const SUN_PATH_MAX = 104;

/** The transport a named socket gets when the caller does not name one.
 *
 *  `dgram` everywhere it exists, because it is the only one of the three with no
 *  start-ordering constraint, no host port and no UDP syscall. Windows has no
 *  AF_UNIX datagram socket, so it falls back to the TCP pair. The resolved value is
 *  persisted at creation, never re-derived: a `networks/<name>.json` states the
 *  transport it was made with, so one specifier never silently means two things. */
export function defaultSocketMode(platform: NodeJS.Platform = process.platform): SocketMode {
	return platform === "win32" ? "listen-connect" : "dgram";
}

// In-memory write-through cache — works around Bun Windows FS caching bugs
// where writeFileSync followed by immediate readdirSync/readFileSync returns stale data.
// Uses a Map for well-defined semantics on every Bun platform; the previous plain-
// object + `in`-operator approach silently failed on windows-latest under Bun (CI #1).
const _cache: Map<string, SocketEntry> = new Map();

/** Reset in-memory socket cache. Exported for test cleanup only. */
export function _resetSocketCache(): void {
	_cache.clear();
}

export function getSocketRegistryDir(): string {
	const dir = join(getDataDir(), "networks");
	mkdirSync(dir, { recursive: true });
	return dir;
}

function socketPath(name: string): string {
	// The single place a name becomes a path, so the traversal guard lives here
	// rather than at each caller: `networks sockets remove ../victim` used to delete
	// <dataDir>/victim.json, and a longer prefix reached outside the data dir entirely.
	// createNamedSocket() applies the stricter creation rules on top of this.
	assertPathSafeName(name, "named socket");
	return join(getSocketRegistryDir(), `${name}.json`);
}

/** Normalize an entry loaded from disk: defaults missing fields for backward compat. */
function normalizeEntry(raw: Partial<SocketEntry> & { name: string; mode: SocketEntry["mode"]; createdAt: string }): SocketEntry {
	return {
		name: raw.name,
		mode: raw.mode,
		mcastGroup: raw.mcastGroup,
		port: raw.port,
		createdAt: raw.createdAt,
		members: Array.isArray(raw.members) ? [...raw.members] : [],
		// Entries written before slots existed have no `endpoints`. `mcast` never has
		// them; a pair link needs them, or every member resolves to "holds no endpoint"
		// and the link cannot start at all. `listen-connect` was reachable from the
		// library API before the CLI could spell it, so such entries can exist. Seeded
		// empty rather than from `members`, which is live membership and can be stale
		// after a crash — the machines reclaim their ends on the next start.
		endpoints: Array.isArray(raw.endpoints)
			? [...raw.endpoints]
			: raw.mode === "mcast" ? undefined : [null, null],
		autoCreated: typeof raw.autoCreated === "boolean" ? raw.autoCreated : false,
	};
}

/** Write the entry so a concurrent reader never sees a half-written file.
 *
 *  `writeFileSync` truncates and then fills, so another process reading in that window
 *  gets invalid JSON and `getNamedSocket()` reports the socket as missing. Two starts
 *  racing to join one link hit it — observed on 3 of 12 rounds of a two-process
 *  repro. Write-then-rename makes the swap atomic. */
function saveEntry(entry: SocketEntry): void {
	const target = socketPath(entry.name);
	const tmp = `${target}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(entry, null, "\t") + "\n");
	renameSync(tmp, target);
	_cache.set(entry.name, entry);
}

/** How long to wait for another process to finish its read-modify-write. The critical
 *  section is one small file write, so this is many orders of magnitude of headroom;
 *  it exists so a crashed holder cannot wedge a start forever. */
const LOCK_TIMEOUT_MS = 5_000;

/** Serialize a read-modify-write of one registry entry across processes.
 *
 *  `addSocketMember()` reads the entry, picks a free slot and writes it back. Two
 *  machines joining one link concurrently both read `[null, null]`, both take slot 0,
 *  and the second write wins — so both QEMUs are handed the same `local.path`, and on
 *  a `dgram` link the second silently unlinks the first's socket and steals the link.
 *  A two-process repro lost an endpoint on 12 of 12 rounds.
 *
 *  `quickchr start a & quickchr start b &` is the shape that hits this, and it is
 *  exactly how the field report drove its multi-CHR lab. The per-machine
 *  `.start-lock` cannot help: the two contenders are different machines. */
const _heldLocks = new Set<string>();

/** How long a lock file may be unreadable before it counts as abandoned.
 *
 *  A holder creates the file and writes its pid in two syscalls, so there is a window
 *  where the file exists and is empty. Deleting on first sight of an empty file takes
 *  the lock away from a live holder, and then two processes both believe they hold it
 *  — which is how three concurrent joiners all reported success while only two held an
 *  endpoint. The window is microseconds; a crashed holder is still reclaimed. */
const LOCK_STALE_GRACE_MS = 500;

function withEntryLock<T>(name: string, fn: () => T): T {
	const lockPath = `${socketPath(name)}.lock`;
	// Reentrant within a process: removeSocketMember() deletes an exhausted
	// auto-created link through removeNamedSocket(), which takes the same lock.
	if (_heldLocks.has(lockPath)) return fn();

	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	let unreadableSince: number | undefined;
	let held = false;

	while (!held) {
		// Checked here, not only on the live-owner path: a lock another process keeps
		// recreating would otherwise reset the grace timer forever and never time out.
		if (Date.now() > deadline) {
			throw new QuickCHRError(
				"STATE_ERROR",
				`Timed out after ${LOCK_TIMEOUT_MS}ms waiting for the registry lock on named socket "${name}".`,
			);
		}
		try {
			const fd = openSync(lockPath, "wx"); // O_CREAT | O_EXCL — atomic
			writeSync(fd, String(process.pid));
			closeSync(fd);
			held = true;
			_heldLocks.add(lockPath);
			break;
		} catch { /* someone else holds it */ }

		// A holder that died mid-write would otherwise wedge every later start.
		let ownerPid = Number.NaN;
		try { ownerPid = Number.parseInt(readFileSync(lockPath, "utf-8").trim(), 10); } catch { /* unreadable */ }

		if (!Number.isFinite(ownerPid) || ownerPid <= 0) {
			// Empty or gone: either the holder has not written its pid yet, or it
			// released between our open and our read. Give it the grace period before
			// concluding anything, rather than deleting a lock someone else holds.
			unreadableSince ??= Date.now();
			if (Date.now() - unreadableSince > LOCK_STALE_GRACE_MS) {
				try { rmSync(lockPath, { force: true }); } catch { /* another waiter got there first */ }
				unreadableSince = undefined;
			}
			Bun.sleepSync(5);
			continue;
		}
		unreadableSince = undefined;

		let ownerAlive = true;
		try { process.kill(ownerPid, 0); } catch { ownerAlive = false; }
		if (!ownerAlive) {
			try { rmSync(lockPath, { force: true }); } catch { /* another waiter got there first */ }
			continue;
		}

		Bun.sleepSync(10);
	}

	try {
		return fn();
	} finally {
		_heldLocks.delete(lockPath);
		try { rmSync(lockPath, { force: true }); } catch { /* best effort */ }
	}
}

/** Lock name for the registry-wide lock. Deliberately not a legal socket name:
 *  `assertPathSafeName` accepts it as a path segment, while `assertValidResourceName`
 *  rejects a leading dot for a real socket, so it can never collide with one. Its lock
 *  file does not end in `.json`, so `listNamedSockets()` never sees it either. */
const REGISTRY_LOCK_NAME = ".registry";

/** Serialize work that reads or writes the registry as a whole, rather than one entry.
 *
 *  Automatic port allocation is `max(existing ports) + 1`, which reads every entry —
 *  so the per-entry lock does not help when the contenders are *different* names. Three
 *  processes creating three `mcast` links at once all read an empty registry and all
 *  take 4000, silently collapsing three segments into one shared group. A repro hit
 *  that on 15 of 15 rounds.
 *
 *  Always taken *inside* `withEntryLock()`, never the other way round, so the lock
 *  order is fixed and two holders cannot deadlock. */
function withRegistryLock<T>(fn: () => T): T {
	return withEntryLock(REGISTRY_LOCK_NAME, fn);
}

/** Read an entry straight from disk, bypassing the in-memory cache.
 *
 *  The cache is a write-through workaround for Bun's Windows FS caching, and it is
 *  correct within one process — but under `withEntryLock()` the file may have been
 *  changed by *another* process since we last read it, so a cached copy is exactly
 *  the wrong thing to modify. */
function reloadEntry(name: string): SocketEntry | undefined {
	try {
		const entry = normalizeEntry(JSON.parse(readFileSync(socketPath(name), "utf-8")));
		_cache.set(name, entry);
		return entry;
	} catch {
		_cache.delete(name);
		return undefined;
	}
}

function allocatePort(existing: SocketEntry[]): number {
	const used = existing.map((e) => e.port).filter((p): p is number => typeof p === "number");
	if (used.length === 0) return DEFAULT_START_PORT;
	return Math.max(...used) + 1;
}

export function createNamedSocket(
	name: string,
	opts?: { mode?: SocketMode; port?: number; mcastGroup?: string; autoCreated?: boolean },
): SocketEntry {
	return withEntryLock(name, () => {
		if (reloadEntry(name)) {
			throw new QuickCHRError("STATE_ERROR", `Named socket "${name}" already exists`);
		}
		return createEntry(name, opts);
	});
}

/** Build and persist a new entry. Caller holds the entry lock and has already
 *  established that the name is free. */
function createEntry(
	name: string,
	opts?: { mode?: SocketMode; port?: number; mcastGroup?: string; autoCreated?: boolean },
): SocketEntry {
	// The name becomes a filename under networks/ and is echoed back in every
	// `--add-network socket::<name>`, so it is validated before anything is written —
	// `networks sockets create --help` used to persist a socket called "--help" (#156).
	assertValidResourceName(name, "named socket");

	const mode = opts?.mode ?? defaultSocketMode();
	// Silently dropping an option the caller passed is the class of bug this whole
	// area is about, so a group that cannot apply is an error rather than a no-op.
	if (opts?.mcastGroup !== undefined && mode !== "mcast") {
		throw new QuickCHRError(
			"INVALID_NETWORK",
			`mcastGroup only applies to mode "mcast" — named socket "${name}" is ${mode}.`,
		);
	}
	// The CLI rejects this; the library has to as well, or it can persist an entry whose
	// port is meaningless and which nothing ever reports.
	if (opts?.port !== undefined && mode === "dgram") {
		throw new QuickCHRError(
			"INVALID_NETWORK",
			`port does not apply to mode "dgram" — named socket "${name}" is a unix datagram pair and uses no port.`,
		);
	}

	const mcastGroup = mode === "mcast" ? (opts?.mcastGroup ?? DEFAULT_MCAST_GROUP) : undefined;

	// Fail at create, not at spawn: a path over sun_path only surfaces as a QEMU
	// startup error that names a path the caller never chose.
	if (mode === "dgram") assertEndpointPathsFit(name);

	const build = (port: number | undefined): SocketEntry => {
		const entry: SocketEntry = {
			name,
			mode,
			port,
			mcastGroup,
			createdAt: new Date().toISOString(),
			members: [],
			endpoints: mode === "mcast" ? undefined : [null, null],
			autoCreated: opts?.autoCreated ?? false,
		};
		saveEntry(entry);
		return entry;
	};

	// A dgram link needs no port, and an explicit one is the caller's to pick — neither
	// reads the rest of the registry, so neither needs the registry-wide lock.
	if (mode === "dgram") return build(undefined);
	if (opts?.port !== undefined) return build(opts.port);

	// Allocating reads every entry, so the read and the write that follows it have to be
	// one critical section against every other name.
	return withRegistryLock(() => build(allocatePort(listNamedSockets())));
}

export function getNamedSocket(name: string): SocketEntry | undefined {
	const cached = _cache.get(name);
	if (cached) return cached;
	try {
		const raw = JSON.parse(readFileSync(socketPath(name), "utf-8"));
		const entry = normalizeEntry(raw);
		_cache.set(name, entry);
		return entry;
	} catch {
		return undefined;
	}
}

export function listNamedSockets(): SocketEntry[] {
	const dir = getSocketRegistryDir();
	const merged = new Map(_cache);
	try {
		for (const file of readdirSync(dir)) {
			if (!file.endsWith(".json")) continue;
			const name = file.replace(/\.json$/, "");
			if (!merged.has(name)) {
				try {
					const raw = JSON.parse(readFileSync(join(dir, file), "utf-8"));
					const entry = normalizeEntry(raw);
					merged.set(name, entry);
					_cache.set(name, entry);
				} catch {}
			}
		}
	} catch {}
	return Array.from(merged.values());
}

export function removeNamedSocket(name: string): boolean {
	return withEntryLock(name, () => {
		// Removing the entry also unlinks the endpoint sockets, and a peer's
		// `remote.path` then names nothing — so removing a link out from under running
		// machines breaks it immediately and silently. Members are dropped on
		// stop/remove/clean, so this only refuses a link that is genuinely in use.
		const entry = reloadEntry(name);
		if (entry && entry.members.length > 0) {
			throw new QuickCHRError(
				"STATE_ERROR",
				`Named socket "${name}" is in use by ${entry.members.join(" and ")} — ` +
				`stop ${entry.members.length > 1 ? "those machines" : "that machine"} first.`,
			);
		}
		return removeEntry(name);
	});
}

function removeEntry(name: string): boolean {
	const wasCached = _cache.has(name);
	_cache.delete(name);
	// QEMU does not unlink its unix sockets on exit — it rebinds over a stale one, so
	// they are harmless while the link exists, but removing the link should not leave
	// them behind in the registry directory.
	for (const slot of [0, 1]) {
		try { rmSync(socketEndpointPath(name, slot)); } catch { /* absent, or never a dgram link */ }
	}
	const path = socketPath(name);
	if (!existsSync(path)) return wasCached;
	rmSync(path);
	return true;
}

/** Unix datagram socket path for one endpoint of a `dgram` link.
 *
 *  Keyed by slot, not by machine name: the first machine to start has to name its
 *  peer's path before that peer exists, and a slot is the only thing both ends can
 *  agree on in advance. (QEMU is happy for `remote.path` to be missing at spawn —
 *  verified in either start order.) */
export function socketEndpointPath(name: string, slot: number): string {
	assertPathSafeName(name, "named socket");
	return join(getSocketRegistryDir(), `${name}.${slot}.sock`);
}

function assertEndpointPathsFit(name: string): void {
	for (const slot of [0, 1]) {
		const path = socketEndpointPath(name, slot);
		if (Buffer.byteLength(path) > SUN_PATH_MAX) {
			throw new QuickCHRError(
				"INVALID_NETWORK",
				`Unix socket path for "${name}" is ${Buffer.byteLength(path)} bytes, over the ${SUN_PATH_MAX}-byte limit: ${path}. ` +
				`Use a shorter QUICKCHR_DATA_DIR or socket name, or create the socket with --mode listen-connect.`,
			);
		}
	}
}

/** Slot this machine holds on a two-member socket, or `undefined` for `mcast`. */
export function getSocketSlot(entry: SocketEntry, machineName: string): number | undefined {
	if (!entry.endpoints) return undefined;
	const slot = entry.endpoints.indexOf(machineName);
	return slot === -1 ? undefined : slot;
}

export function addSocketMember(name: string, machineName: string): void {
	withEntryLock(name, () => {
		const entry = reloadEntry(name);
		if (!entry) {
			throw new QuickCHRError("STATE_ERROR", `Named socket "${name}" not found`);
		}
		claimEndpoint(entry, machineName);
	});
}

/** Create the link if it does not exist, then join it — under one lock.
 *
 *  `start()` used to test-then-create, which two concurrent starts both pass, so both
 *  create the entry and one silently overwrites the other's slot claim. */
export function joinNamedSocket(name: string, machineName: string, opts?: { autoCreated?: boolean }): SocketEntry {
	return withEntryLock(name, () => {
		const entry = reloadEntry(name) ?? createEntry(name, { autoCreated: opts?.autoCreated ?? false });
		claimEndpoint(entry, machineName);
		return entry;
	});
}

/** Give `machineName` an endpoint and persist. Caller holds the entry lock. */
function claimEndpoint(entry: SocketEntry, machineName: string): void {
	let changed = false;
	// `mcast` has no endpoints and no cap; the slot array *is* the capacity.
	if (entry.endpoints && !entry.endpoints.includes(machineName)) {
		const free = entry.endpoints.indexOf(null);
		if (free === -1) {
			const held = entry.endpoints.filter((m): m is string => m !== null);
			throw new QuickCHRError(
				"NETWORK_UNAVAILABLE",
				`Named socket "${entry.name}" is a ${entry.mode} link and carries ${entry.endpoints.length} machines; ` +
				`${held.join(" and ")} already hold both ends. ` +
				`Stop one of them, or create an N-way segment with 'quickchr networks sockets create <name> --mode mcast'.`,
			);
		}
		entry.endpoints[free] = machineName;
		changed = true;
	}
	if (!entry.members.includes(machineName)) {
		entry.members.push(machineName);
		changed = true;
	}
	if (changed) saveEntry(entry);
}

export function removeSocketMember(name: string, machineName: string): void {
	withEntryLock(name, () => {
		const entry = reloadEntry(name);
		if (!entry) return;
		entry.members = entry.members.filter((m) => m !== machineName);
		if (entry.endpoints) {
			entry.endpoints = entry.endpoints.map((m) => (m === machineName ? null : m));
		}
		if (entry.members.length === 0 && entry.autoCreated) {
			// removeEntry, not removeNamedSocket: the in-use guard there re-reads from
			// disk, which still shows the member we just dropped in memory.
			removeEntry(name);
		} else {
			saveEntry(entry);
		}
	});
}
