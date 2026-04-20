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
	members: string[];
}

const DEFAULT_START_PORT = 4000;
const DEFAULT_MCAST_GROUP = "230.0.0.1";

// In-memory write-through cache — works around Bun Windows FS caching bugs
// where writeFileSync followed by immediate readdirSync/readFileSync returns stale data.
// Uses a plain object (not Map) to avoid potential Bun Map quirks on Windows.
let _cache: Record<string, SocketEntry> = Object.create(null);

/** Reset in-memory socket cache. Exported for test cleanup only. */
export function _resetSocketCache(): void {
	_cache = Object.create(null);
}

export function getSocketRegistryDir(): string {
	const dir = join(getDataDir(), "networks");
	mkdirSync(dir, { recursive: true });
	return dir;
}

function socketPath(name: string): string {
	return join(getSocketRegistryDir(), `${name}.json`);
}

function saveEntry(entry: SocketEntry): void {
	writeFileSync(socketPath(entry.name), JSON.stringify(entry, null, "\t") + "\n");
	_cache[entry.name] = entry;
}

function allocatePort(existing: SocketEntry[]): number {
	if (existing.length === 0) return DEFAULT_START_PORT;
	const maxPort = Math.max(...existing.map((e) => e.port));
	return maxPort + 1;
}

export function createNamedSocket(
	name: string,
	opts?: { mode?: "mcast" | "listen-connect"; port?: number; mcastGroup?: string },
): SocketEntry {
	if (name in _cache || existsSync(socketPath(name))) {
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
	};

	saveEntry(entry);
	return entry;
}

export function getNamedSocket(name: string): SocketEntry | undefined {
	if (name in _cache) return _cache[name];
	try {
		const entry = JSON.parse(readFileSync(socketPath(name), "utf-8")) as SocketEntry;
		_cache[name] = entry;
		return entry;
	} catch {
		return undefined;
	}
}

export function listNamedSockets(): SocketEntry[] {
	const dir = getSocketRegistryDir();
	const merged: Record<string, SocketEntry> = { ..._cache };
	try {
		for (const file of readdirSync(dir)) {
			if (!file.endsWith(".json")) continue;
			const name = file.replace(/\.json$/, "");
			if (!(name in merged)) {
				try {
					const entry = JSON.parse(readFileSync(join(dir, file), "utf-8")) as SocketEntry;
					merged[name] = entry;
					_cache[name] = entry;
				} catch {}
			}
		}
	} catch {}
	return Object.values(merged);
}

export function removeNamedSocket(name: string): boolean {
	const wasCached = name in _cache;
	delete _cache[name];
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
	if (entry.members.length === 0) {
		removeNamedSocket(name);
	} else {
		saveEntry(entry);
	}
}
