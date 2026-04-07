import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, utimesSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
	saveMachine,
	loadMachine,
	loadAllMachines,
	listMachineNames,
	removeMachine,
	getUsedPortBases,
	updateMachineStatus,
	isMachineRunning,
	refreshAllStatuses,
	pruneCache,
	getCacheDir,
	ensureDir,
} from "../../src/lib/state.ts";
import type { MachineState } from "../../src/lib/types.ts";

// Use a temp directory for tests
const TEST_DIR = join(import.meta.dir, ".tmp-state-test");
const origEnv = process.env.HOME;

function makeMachine(name: string, portBase: number = 9100): MachineState {
	return {
		name,
		version: "7.22.1",
		arch: "arm64",
		cpu: 1,
		mem: 512,
		network: "user",
		ports: {},
		packages: [],
		portBase,
		excludePorts: [],
		extraPorts: [],
		createdAt: new Date().toISOString(),
		status: "stopped",
		machineDir: join(TEST_DIR, ".local", "share", "quickchr", "machines", name),
	};
}

beforeEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.HOME = TEST_DIR;
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	process.env.HOME = origEnv;
});

describe("state persistence", () => {
	test("save and load machine", () => {
		const state = makeMachine("test-1");
		saveMachine(state);

		const loaded = loadMachine("test-1");
		expect(loaded).toBeDefined();
		expect(loaded?.name).toBe("test-1");
		expect(loaded?.version).toBe("7.22.1");
		expect(loaded?.arch).toBe("arm64");
	});

	test("loadMachine returns undefined for non-existent", () => {
		expect(loadMachine("nonexistent")).toBeUndefined();
	});

	test("loadAllMachines returns all saved machines", () => {
		saveMachine(makeMachine("vm-1", 9100));
		saveMachine(makeMachine("vm-2", 9110));

		const all = loadAllMachines();
		expect(all.length).toBe(2);
		expect(all.map((m) => m.name).sort()).toEqual(["vm-1", "vm-2"]);
	});

	test("listMachineNames returns names", () => {
		saveMachine(makeMachine("a"));
		saveMachine(makeMachine("b"));
		const names = listMachineNames();
		expect(names.sort()).toEqual(["a", "b"]);
	});

	test("getUsedPortBases returns all bases", () => {
		saveMachine(makeMachine("x", 9100));
		saveMachine(makeMachine("y", 9200));
		expect(getUsedPortBases().sort()).toEqual([9100, 9200]);
	});

	test("removeMachine deletes directory", () => {
		const state = makeMachine("to-delete");
		saveMachine(state);
		expect(loadMachine("to-delete")).toBeDefined();

		removeMachine("to-delete");
		expect(loadMachine("to-delete")).toBeUndefined();
	});

	test("removeMachine throws for non-existent", () => {
		expect(() => removeMachine("nope")).toThrow();
	});
});

describe("updateMachineStatus", () => {
	test("updates status and pid for a saved machine", () => {
		const state = makeMachine("update-test");
		saveMachine(state);

		updateMachineStatus("update-test", "running", 12345);

		const loaded = loadMachine("update-test");
		expect(loaded?.status).toBe("running");
		expect(loaded?.pid).toBe(12345);
	});

	test("sets lastStartedAt when status is running", () => {
		const before = Date.now();
		const state = makeMachine("ts-test");
		saveMachine(state);

		updateMachineStatus("ts-test", "running", 99);

		const loaded = loadMachine("ts-test");
		const ts = new Date(loaded?.lastStartedAt ?? "").getTime();
		expect(ts).toBeGreaterThanOrEqual(before);
	});

	test("clears pid when status is stopped", () => {
		const state = { ...makeMachine("stop-test"), status: "running" as const, pid: 555 };
		saveMachine(state);

		updateMachineStatus("stop-test", "stopped", undefined);

		const loaded = loadMachine("stop-test");
		expect(loaded?.status).toBe("stopped");
		expect(loaded?.pid).toBeUndefined();
	});

	test("throws MACHINE_NOT_FOUND for non-existent name", () => {
		expect(() => updateMachineStatus("no-such-machine", "stopped")).toThrow("no-such-machine");
	});
});

describe("isMachineRunning", () => {
	test("returns false when status is not running", () => {
		const state = makeMachine("stopped-machine");
		expect(isMachineRunning(state)).toBe(false);
	});

	test("returns false when pid is missing", () => {
		const state = { ...makeMachine("no-pid"), status: "running" as const, pid: undefined };
		expect(isMachineRunning(state)).toBe(false);
	});

	test("returns true when pid is our own live process", () => {
		const state = { ...makeMachine("live-pid"), status: "running" as const, pid: process.pid };
		expect(isMachineRunning(state)).toBe(true);
	});

	test("returns false when pid is dead (ESRCH)", () => {
		// PID 999_999_999 is guaranteed not to exist (Linux max is ~4 million)
		const state = { ...makeMachine("dead-pid"), status: "running" as const, pid: 999_999_999 };
		expect(isMachineRunning(state)).toBe(false);
	});
});

describe("refreshAllStatuses", () => {
	test("marks stopped for machines with dead PIDs, leaves live ones running", () => {
		// Machine with a live PID (ourselves) — should stay running
		const live = { ...makeMachine("live-machine", 9100), status: "running" as const, pid: process.pid };
		saveMachine(live);

		// Machine with a dead PID — should become stopped
		const dead = { ...makeMachine("dead-machine", 9110), status: "running" as const, pid: 999_999_999 };
		saveMachine(dead);

		// Stopped machine — should stay stopped
		const stopped = makeMachine("stopped-machine", 9120);
		saveMachine(stopped);

		const statuses = refreshAllStatuses();
		const byName = Object.fromEntries(statuses.map((m) => [m.name, m.status]));

		expect(byName["live-machine"]).toBe("running");
		expect(byName["dead-machine"]).toBe("stopped");
		expect(byName["stopped-machine"]).toBe("stopped");

		// Persisted state should also be updated
		expect(loadMachine("dead-machine")?.status).toBe("stopped");
		expect(loadMachine("dead-machine")?.pid).toBeUndefined();
	});
});

describe("pruneCache", () => {
	test("removes files older than maxAgeDays and returns count", () => {
		const cache = getCacheDir();
		ensureDir(cache);

		const oldPath = join(cache, "chr-7.0.0.img");
		const newPath = join(cache, "chr-7.22.1.img");
		writeFileSync(oldPath, "old");
		writeFileSync(newPath, "new");

		// Set mtime of oldPath to 31 days ago
		const oldTime = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
		utimesSync(oldPath, oldTime, oldTime);

		const removed = pruneCache(30);
		expect(removed).toBe(1);

		// Old file gone, new file remains
		expect(loadMachine("chr-7.0.0.img")).toBeUndefined(); // doesn't exist
		const files = readdirSync(cache);
		expect(files).not.toContain("chr-7.0.0.img");
		expect(files).toContain("chr-7.22.1.img");
	});

	test("returns 0 when cache dir does not exist", () => {
		// HOME set to a fresh empty temp dir — cache dir won't exist
		expect(pruneCache(1)).toBe(0);
	});
});
