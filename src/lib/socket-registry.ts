/**
 * Named socket registry — persistent named L2 links between CHR instances.
 * Socket entries are stored as JSON files in ~/.local/share/quickchr/networks/.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { QuickCHRError } from "./types.ts";
import { getDataDir } from "./state.ts";
import { assertValidResourceName, assertPathSafeName } from "./names.ts";

/** Transport a named socket uses to carry guest frames.
 *
 *  - `dgram` — a pair of unix datagram sockets (QEMU >= 7.2). No ports, no UDP
 *    syscalls, and **either end may start first**. Two members. POSIX only:
 *    Windows' AF_UNIX has no SOCK_DGRAM.
 *  - `listen-connect` — a TCP pair on loopback. Two members; whichever starts
 *    first takes the listening slot. The Windows default.
 *  - `mcast` — UDP multicast, the only N-way segment. Broken on macOS and in
 *    sandboxes that block UDP, and it fails *silently* in both (see DESIGN.md).
 */
export type SocketMode = "mcast" | "listen-connect" | "dgram";

export interface SocketEntry {
	name: string;
	mode: SocketMode;
	mcastGroup?: string;
	port: number;
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
function normalizeEntry(raw: Partial<SocketEntry> & { name: string; mode: SocketEntry["mode"]; port: number; createdAt: string }): SocketEntry {
	return {
		name: raw.name,
		mode: raw.mode,
		mcastGroup: raw.mcastGroup,
		port: raw.port,
		createdAt: raw.createdAt,
		members: Array.isArray(raw.members) ? [...raw.members] : [],
		// Entries written before slots existed were all `mcast`, which has no slots.
		endpoints: Array.isArray(raw.endpoints) ? [...raw.endpoints] : undefined,
		autoCreated: typeof raw.autoCreated === "boolean" ? raw.autoCreated : false,
	};
}

function saveEntry(entry: SocketEntry): void {
	writeFileSync(socketPath(entry.name), JSON.stringify(entry, null, "\t") + "\n");
	_cache.set(entry.name, entry);
}

function allocatePort(existing: SocketEntry[]): number {
	if (existing.length === 0) return DEFAULT_START_PORT;
	const maxPort = Math.max(...existing.map((e) => e.port));
	return maxPort + 1;
}

export function createNamedSocket(
	name: string,
	opts?: { mode?: SocketMode; port?: number; mcastGroup?: string; autoCreated?: boolean },
): SocketEntry {
	// The name becomes a filename under networks/ and is echoed back in every
	// `--add-network socket::<name>`, so it is validated before anything is written —
	// `networks sockets create --help` used to persist a socket called "--help" (#156).
	assertValidResourceName(name, "named socket");
	if (_cache.has(name) || existsSync(socketPath(name))) {
		throw new QuickCHRError("STATE_ERROR", `Named socket "${name}" already exists`);
	}

	const mode = opts?.mode ?? defaultSocketMode();
	// Silently dropping an option the caller passed is the class of bug this whole
	// area is about, so a group that cannot apply is an error rather than a no-op.
	if (opts?.mcastGroup !== undefined && mode !== "mcast") {
		throw new QuickCHRError(
			"INVALID_NETWORK",
			`mcastGroup only applies to mode "mcast" — named socket "${name}" is ${mode}.`,
		);
	}
	const port = opts?.port ?? allocatePort(listNamedSockets());
	const mcastGroup = mode === "mcast" ? (opts?.mcastGroup ?? DEFAULT_MCAST_GROUP) : undefined;

	// Fail at create, not at spawn: a path over sun_path only surfaces as a QEMU
	// startup error that names a path the caller never chose.
	if (mode === "dgram") assertEndpointPathsFit(name);

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
	const entry = getNamedSocket(name);
	if (!entry) {
		throw new QuickCHRError("STATE_ERROR", `Named socket "${name}" not found`);
	}
	let changed = false;
	// `mcast` has no endpoints and no cap; the slot array *is* the capacity.
	if (entry.endpoints && !entry.endpoints.includes(machineName)) {
		const free = entry.endpoints.indexOf(null);
		if (free === -1) {
			const held = entry.endpoints.filter((m): m is string => m !== null);
			throw new QuickCHRError(
				"NETWORK_UNAVAILABLE",
				`Named socket "${name}" is a ${entry.mode} link and carries ${entry.endpoints.length} machines; ` +
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
	const entry = getNamedSocket(name);
	if (!entry) return;
	entry.members = entry.members.filter((m) => m !== machineName);
	if (entry.endpoints) {
		entry.endpoints = entry.endpoints.map((m) => (m === machineName ? null : m));
	}
	if (entry.members.length === 0 && entry.autoCreated) {
		removeNamedSocket(name);
	} else {
		saveEntry(entry);
	}
}
