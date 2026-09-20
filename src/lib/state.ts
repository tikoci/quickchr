/**
 * Machine state persistence — JSON files in ~/.local/share/quickchr/machines/.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join, } from "node:path";
import type { MachineState, } from "./types.ts";
import { QuickCHRError } from "./types.ts";
import { networkModeToConfigs } from "./network.ts";
import { assertPathSafeName, isPathSafeName } from "./names.ts";

/** Get the quickchr data directory root. Override with QUICKCHR_DATA_DIR env var. */
export function getDataDir(): string {
	if (process.env.QUICKCHR_DATA_DIR) return process.env.QUICKCHR_DATA_DIR;
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

/** One line per successful boot, appended to <dataDir>/boot-log.ndjson — local
 *  boot-history for users ("how slow are my boots") and the durable CI metrics
 *  feed (machine dirs are removed by tests, machine.json alone is not enough). */
export interface BootLogEntry {
	ts: string;
	name: string;
	version: string;
	arch: string;
	accel: string;
	bootMs: number;
	/** Host platform, `process.platform` ("linux" | "darwin" | "win32"). */
	host: string;
}

const BOOT_LOG_MAX_LINES = 1000;
const BOOT_LOG_KEEP_LINES = 500;

/** Path to the boot-history log. */
export function bootLogPath(): string {
	return join(getDataDir(), "boot-log.ndjson");
}

/** Append a boot record; rotates to the newest BOOT_LOG_KEEP_LINES when the
 *  log exceeds BOOT_LOG_MAX_LINES.
 *
 *  Append-first (single appendFileSync call, atomic for one-line writes on
 *  every platform we run on) so concurrent boots — parallel bun test workers
 *  each booting a CHR — never clobber each other's entries in the common path.
 *  Only the rare rotation (once per ~500 boots) does a read-rewrite; an append
 *  racing that millisecond window CAN be lost. Accepted: this is a boot-history
 *  metrics log, not a ledger, and a lockfile is not worth the complexity. */
export function appendBootLog(entry: BootLogEntry): void {
	const path = bootLogPath();
	ensureDir(getDataDir());
	appendFileSync(path, `${JSON.stringify(entry)}\n`);
	const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
	if (lines.length > BOOT_LOG_MAX_LINES) {
		writeFileSync(path, `${lines.slice(-BOOT_LOG_KEEP_LINES).join("\n")}\n`);
	}
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

/** Load machine state from disk. Returns undefined if not found.
 *
 *  Throws `STATE_ERROR` when the file is there but unusable. A targeted lookup by name
 *  has to fail: the caller named *this* machine, and answering `undefined` would report
 *  a machine that exists on disk as one that never did. `loadAllMachines()` is the
 *  enumeration and takes the other policy — see `tryLoadMachine()` (#165). */
export function loadMachine(name: string): MachineState | undefined {
	const path = machineJsonPath(name);
	if (!existsSync(path)) return undefined;
	let state: MachineState;
	try {
		state = JSON.parse(readFileSync(path, "utf-8")) as MachineState;
	} catch (e) {
		throw new QuickCHRError(
			"STATE_ERROR",
			`Machine "${name}" has an unreadable machine.json (${e instanceof Error ? e.message : String(e)})`,
			`Inspect ${path}, or clear the machine with 'quickchr remove ${name}'`,
		);
	}
	if (state === null || typeof state !== "object" || Array.isArray(state)) {
		throw new QuickCHRError(
			"STATE_ERROR",
			`Machine "${name}" has an unreadable machine.json (not a JSON object)`,
			`Inspect ${path}, or clear the machine with 'quickchr remove ${name}'`,
		);
	}
	// Migrate legacy `network` field → `networks` array
	if (!state.networks && (state as unknown as Record<string, unknown>).network) {
		const legacy = (state as unknown as Record<string, unknown>).network as MachineState["networks"][0]["specifier"] | "user" | "vmnet-shared" | { type: "vmnet-bridge"; iface: string };
		state.networks = networkModeToConfigs(legacy as Parameters<typeof networkModeToConfigs>[0]);
	} else if (!state.networks) {
		state.networks = [{ specifier: "user", id: "net0" }];
	}
	return state;
}

/** The three things a machine directory can turn out to be.
 *
 *  `loadMachine()` collapses `missing` and `unreadable` into "undefined or throw", which
 *  is the right contract for a lookup and the wrong one for an enumeration. This keeps
 *  them apart so each caller can pick (#165). Internal for now: promoting it to public
 *  API is a rename if #58 lands. */
type MachineLoad =
	| { status: "ok"; state: MachineState }
	| { status: "missing" }
	| { status: "unreadable"; error: string };

/** `loadMachine()` without the throw. */
function tryLoadMachine(name: string): MachineLoad {
	try {
		const state = loadMachine(name);
		return state ? { status: "ok", state } : { status: "missing" };
	} catch (e) {
		return { status: "unreadable", error: e instanceof Error ? e.message : String(e) };
	}
}

/** Load all machine states, skipping directories with no usable `machine.json`.
 *
 *  An enumeration is best-effort across many: one corrupt file used to abort the whole
 *  listing, which loses the state of every healthy machine as well. Nothing is hidden by
 *  the skip — `listUnreadableMachines()` names what was left out, and `quickchr list`
 *  shows it as a row (#165). */
export function loadAllMachines(): MachineState[] {
	const dir = getMachinesDir();
	if (!existsSync(dir)) return [];

	const entries = readdirSync(dir, { withFileTypes: true });
	const machines: MachineState[] = [];

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const loaded = tryLoadMachine(entry.name);
		if (loaded.status === "ok") machines.push(loaded.state);
	}

	return machines;
}

/** Every machine directory whose `machine.json` exists but cannot be read.
 *
 *  Distinct from `listOrphanMachineDirs()`, which also counts a directory with no
 *  `machine.json` at all — a create that never finished. This one is a machine that did
 *  exist and whose state went bad, so it still holds a disk image worth naming. */
export function listUnreadableMachines(): Array<{ name: string; error: string }> {
	const out: Array<{ name: string; error: string }> = [];
	for (const name of listMachineNames()) {
		const loaded = tryLoadMachine(name);
		if (loaded.status === "unreadable") out.push({ name, error: loaded.error });
	}
	return out;
}

/** Get all existing machine names. */
export function listMachineNames(): string[] {
	const dir = getMachinesDir();
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => e.name);
}

/** True when `name` has a machine directory but no readable `machine.json` — a create
 *  that did not finish. `list` cannot show it and `start` cannot boot it, but
 *  `listMachineNames()` (directory-based) still counts it, so it blocks re-add (#155). */
export function isOrphanMachineDir(name: string): boolean {
	// A traversal name resolves to a directory that exists and holds no machine.json —
	// the data dir itself, for ".." — so the path check has to come first or the
	// predicate answers "orphan" about something that is not a machine directory.
	if (!isPathSafeName(name)) return false;
	const dir = getMachineDir(name);
	if (!existsSync(dir)) return false;
	return !isReadableMachine(name);
}

/** Every machine directory with no readable `machine.json`. */
export function listOrphanMachineDirs(): string[] {
	return listMachineNames().filter((name) => !isReadableMachine(name));
}

/** A truncated or corrupt `machine.json` is as unusable as a missing one, and both make
 *  the directory an orphan. */
function isReadableMachine(name: string): boolean {
	return tryLoadMachine(name).status === "ok";
}

/** Get all port bases currently in use by existing machines. */
export function getUsedPortBases(): number[] {
	return loadAllMachines().map((m) => m.portBase);
}

/** Every NIC MAC currently assigned across all machines.
 *  Passed to `assignMacs()` so a new machine cannot be handed an address another
 *  machine already presents on a shared L2 segment (#154). */
export function getUsedMacs(): Set<string> {
	const macs = new Set<string>();
	for (const m of loadAllMachines()) {
		for (const n of m.networks ?? []) {
			if (n.mac) macs.add(n.mac);
		}
	}
	return macs;
}

/** Delete a machine and all its files. */
export function removeMachine(name: string): void {
	// This is an `rmSync(..., { recursive: true })`; the name must never be able to
	// point outside machines/<name>/.
	assertPathSafeName(name, "machine");
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
