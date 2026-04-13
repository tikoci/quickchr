/**
 * Machine state persistence — JSON files in ~/.local/share/quickchr/machines/.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join, } from "node:path";
import type { MachineState, } from "./types.ts";
import { QuickCHRError } from "./types.ts";
import { networkModeToConfigs } from "./network.ts";

/** Get the quickchr data directory root. */
export function getDataDir(): string {
	if (process.platform === "win32") {
		const appData = process.env.LOCALAPPDATA || join(process.env.USERPROFILE || "", "AppData", "Local");
		return join(appData, "quickchr");
	}
	const home = process.env.HOME || process.env.USERPROFILE || "";
	return join(home, ".local", "share", "quickchr");
}

/** Get the machines directory. */
export function getMachinesDir(): string {
	return join(getDataDir(), "machines");
}

/** Get the cache directory. */
export function getCacheDir(): string {
	return join(getDataDir(), "cache");
}

/** Get a specific machine's directory. */
export function getMachineDir(name: string): string {
	return join(getMachinesDir(), name);
}

/** Get the path to a machine's state file. */
function machineJsonPath(name: string): string {
	return join(getMachineDir(name), "machine.json");
}

/** Ensure a directory exists. */
export function ensureDir(dir: string): void {
	mkdirSync(dir, { recursive: true });
}

/** Save machine state to disk. */
export function saveMachine(state: MachineState): void {
	ensureDir(state.machineDir);
	writeFileSync(machineJsonPath(state.name), JSON.stringify(state, null, "\t") + "\n");
}

/** Load machine state from disk. Returns undefined if not found. */
export function loadMachine(name: string): MachineState | undefined {
	const path = machineJsonPath(name);
	if (!existsSync(path)) return undefined;
	const data = readFileSync(path, "utf-8");
	const state = JSON.parse(data) as MachineState;
	// Migrate legacy `network` field → `networks` array
	if (!state.networks && (state as Record<string, unknown>).network) {
		const legacy = (state as Record<string, unknown>).network as MachineState["networks"][0]["specifier"] | "user" | "vmnet-shared" | { type: "vmnet-bridge"; iface: string };
		state.networks = networkModeToConfigs(legacy as Parameters<typeof networkModeToConfigs>[0]);
	} else if (!state.networks) {
		state.networks = [{ specifier: "user", id: "net0" }];
	}
	return state;
}

/** Load all machine states. */
export function loadAllMachines(): MachineState[] {
	const dir = getMachinesDir();
	if (!existsSync(dir)) return [];

	const entries = readdirSync(dir, { withFileTypes: true });
	const machines: MachineState[] = [];

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const state = loadMachine(entry.name);
		if (state) machines.push(state);
	}

	return machines;
}

/** Get all existing machine names. */
export function listMachineNames(): string[] {
	const dir = getMachinesDir();
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => e.name);
}

/** Get all port bases currently in use by existing machines. */
export function getUsedPortBases(): number[] {
	return loadAllMachines().map((m) => m.portBase);
}

/** Delete a machine and all its files. */
export function removeMachine(name: string): void {
	const dir = getMachineDir(name);
	if (!existsSync(dir)) {
		throw new QuickCHRError("MACHINE_NOT_FOUND", `Machine "${name}" not found`);
	}
	rmSync(dir, { recursive: true, force: true });
}

/** Update the status of a machine. */
export function updateMachineStatus(
	name: string,
	status: MachineState["status"],
	pid?: number,
): void {
	const state = loadMachine(name);
	if (!state) {
		throw new QuickCHRError("MACHINE_NOT_FOUND", `Machine "${name}" not found`);
	}
	state.status = status;
	state.pid = pid;
	if (status === "running") {
		state.lastStartedAt = new Date().toISOString();
	}
	saveMachine(state);
}

/** Check if a machine is actually still running (verify PID). */
export function isMachineRunning(state: MachineState): boolean {
	if (state.status !== "running" || !state.pid) return false;
	try {
		process.kill(state.pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Refresh status for all machines (check PIDs). */
export function refreshAllStatuses(): MachineState[] {
	const machines = loadAllMachines();
	for (const m of machines) {
		if (m.status === "running" && !isMachineRunning(m)) {
			m.status = "stopped";
			m.pid = undefined;
			saveMachine(m);
		}
	}
	return machines;
}

/** Prune old cached images older than the given number of days. */
export function pruneCache(maxAgeDays: number = 30): number {
	const cacheDir = getCacheDir();
	if (!existsSync(cacheDir)) return 0;

	const now = Date.now();
	const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
	let removed = 0;

	const entries = readdirSync(cacheDir);
	for (const entry of entries) {
		const fullPath = join(cacheDir, entry);
		try {
			const stat = statSync(fullPath);
			if (now - stat.mtimeMs > maxAgeMs) {
				rmSync(fullPath);
				removed++;
			}
		} catch { /* skip */ }
	}

	return removed;
}
