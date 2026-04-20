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
	if (existsSync(socketPath(name))) {
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
	// Use try/catch instead of existsSync — on Windows, Bun's existsSync can
	// return false for a file that was just written (caching bug). readFileSync
	// is always authoritative and avoids the TOCTOU race.
	try {
		return JSON.parse(readFileSync(socketPath(name), "utf-8")) as SocketEntry;
	} catch {
		return undefined;
	}
}

export function listNamedSockets(): SocketEntry[] {
	const dir = getSocketRegistryDir();
	const entries: SocketEntry[] = [];
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".json")) continue;
		try {
			entries.push(JSON.parse(readFileSync(join(dir, file), "utf-8")) as SocketEntry);
		} catch { /* skip malformed files */ }
	}
	return entries;
}

export function removeNamedSocket(name: string): boolean {
	const path = socketPath(name);
	if (!existsSync(path)) return false;
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
