import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, } from "node:fs";
import { join } from "node:path";
import {
	saveMachine,
	loadMachine,
	loadAllMachines,
	listMachineNames,
	removeMachine,
	getUsedPortBases,
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
