/**
 * Named socket registry — persistent named L2 links between CHR instances.
 * Socket entries are stored as JSON files in ~/.local/share/quickchr/networks/.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { QuickCHRError } from "./types.ts";
import { getDataDir } from "./state.ts";

export interface SocketEntry {
	name: string;
	mode: "mcast" | "listen-connect";
	mcastGroup?: string;
	port: number;
	createdAt: string;
	/** Machines that currently reference this socket. */
	members: string[];
	/** Auto-created by `start()` (true) vs explicit user/CLI creation (false). */
	autoCreated: boolean;
}

const DEFAULT_START_PORT = 4000;
const DEFAULT_MCAST_GROUP = "230.0.0.1";

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
	opts?: { mode?: "mcast" | "listen-connect"; port?: number; mcastGroup?: string; autoCreated?: boolean },
): SocketEntry {
	if (_cache.has(name) || existsSync(socketPath(name))) {
		throw new QuickCHRError("STATE_ERROR", `Named socket "${name}" already exists`);
	}

	const mode = opts?.mode ?? "mcast";
	const port = opts?.port ?? allocatePort(listNamedSockets());
	const mcastGroup = mode === "mcast" ? (opts?.mcastGroup ?? DEFAULT_MCAST_GROUP) : undefined;

	const entry: SocketEntry = {
		name,
		mode,
		port,
		mcastGroup,
		createdAt: new Date().toISOString(),
		members: [],
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
	const path = socketPath(name);
	if (!existsSync(path)) return wasCached;
	rmSync(path);
	return true;
}

export function addSocketMember(name: string, machineName: string): void {
	const entry = getNamedSocket(name);
	if (!entry) {
		throw new QuickCHRError("STATE_ERROR", `Named socket "${name}" not found`);
	}
	if (!entry.members.includes(machineName)) {
		entry.members.push(machineName);
		saveEntry(entry);
	}
}

export function removeSocketMember(name: string, machineName: string): void {
	const entry = getNamedSocket(name);
	if (!entry) return;
	entry.members = entry.members.filter((m) => m !== machineName);
	if (entry.members.length === 0 && entry.autoCreated) {
		removeNamedSocket(name);
	} else {
		saveEntry(entry);
	}
}
