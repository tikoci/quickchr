import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { saveMachine } from "../../src/lib/state.ts";
import type { MachineState } from "../../src/lib/types.ts";

// Pins issue #80's wiring: the snapshot ops pass explicit, operation-sized
// monitor budgets instead of inheriting the 5 s fast-query default, while
// fast queries keep that default. The monitor is stubbed — no QEMU needed.
//
// The mock constants carry distinctive values so these tests prove the
// budgets flow from the named constants (a hardcoded literal or a regressed
// `undefined` in quickchr.ts fails here). The constants' real magnitudes are
// pinned against the unmocked module in channels.test.ts — the two files are
// the two halves of one contract.

// Recorded (command, timeout) pairs seen by the stubbed monitor.
const calls: Array<{ command: string; timeoutMs: number | undefined }> = [];

// Canned `info snapshots` listing containing the snapshot save() reads back.
const LISTING = "1       snap1             113 MiB 2026-04-14 00:47:19  00:01:17.163";

const notStubbed = (name: string) => (..._args: unknown[]): never => {
	throw new Error(`channels mock: ${name} is not stubbed`);
};

mock.module("../../src/lib/channels.ts", () => ({
	// Distinctive stand-ins for the real MONITOR_*_TIMEOUT_MS constants.
	MONITOR_FAST_QUERY_TIMEOUT_MS: 111_000,
	MONITOR_SAVEVM_TIMEOUT_MS: 111_001,
	MONITOR_LOADVM_TIMEOUT_MS: 111_002,
	MONITOR_DELVM_TIMEOUT_MS: 111_003,
	monitorCommand: async (machineDir: string, command: string, timeoutMs?: number) => {
		void machineDir;
		calls.push({ command, timeoutMs });
		if (command === "info snapshots") return LISTING;
		return "";
	},
	channelPath: notStubbed("channelPath"),
	channelEndpoint: notStubbed("channelEndpoint"),
	channelFileExists: notStubbed("channelFileExists"),
	cleanMonitorResponse: notStubbed("cleanMonitorResponse"),
	serialStreams: notStubbed("serialStreams"),
	qgaCommand: notStubbed("qgaCommand"),
	isQgaReady: notStubbed("isQgaReady"),
}));

// Dynamic imports: mock.module() only applies to modules first loaded after it.
const { QuickCHR } = await import("../../src/lib/quickchr.ts");
const {
	MONITOR_SAVEVM_TIMEOUT_MS,
	MONITOR_LOADVM_TIMEOUT_MS,
	MONITOR_DELVM_TIMEOUT_MS,
} = await import("../../src/lib/channels.ts");

const TEST_DIR = join(import.meta.dir, ".tmp-snapshot-budgets-test");
const origDataDir = process.env.QUICKCHR_DATA_DIR;

function makeRunningMachine(): MachineState {
	return {
		name: "budget-probe",
		version: "7.25",
		arch: "x86",
		cpu: 1,
		mem: 512,
		networks: [{ specifier: "user", id: "net0" }],
		ports: {},
		packages: [],
		portBase: 9100,
		excludePorts: [],
		extraPorts: [],
		createdAt: new Date().toISOString(),
		status: "running",
		pid: process.pid, // alive, so get() keeps the fabricated "running" status
		bootDiskFormat: "qcow2",
		machineDir: join(TEST_DIR, "machines", "budget-probe"),
	};
}

beforeEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.QUICKCHR_DATA_DIR = TEST_DIR;
	calls.length = 0;
	saveMachine(makeRunningMachine());
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	if (origDataDir === undefined) {
		delete process.env.QUICKCHR_DATA_DIR;
	} else {
		process.env.QUICKCHR_DATA_DIR = origDataDir;
	}
});

describe("snapshot monitor budgets (issue #80)", () => {
	test("save() passes the savevm budget, not the fast-query default", async () => {
		const instance = QuickCHR.get("budget-probe");
		if (instance === null) throw new Error("expected fabricated machine to load");
		const snap = await instance.snapshot.save("snap1");
		expect(snap.name).toBe("snap1");
		expect(calls.find((c) => c.command === "savevm snap1")?.timeoutMs).toBe(MONITOR_SAVEVM_TIMEOUT_MS);
	});

	test("load()/delete() pass their own budgets; list() keeps the default", async () => {
		const instance = QuickCHR.get("budget-probe");
		if (instance === null) throw new Error("expected fabricated machine to load");
		await instance.snapshot.load("snap1");
		await instance.snapshot.delete("snap1");
		await instance.snapshot.list();
		expect(calls.find((c) => c.command === "loadvm snap1")?.timeoutMs).toBe(MONITOR_LOADVM_TIMEOUT_MS);
		expect(calls.find((c) => c.command === "delvm snap1")?.timeoutMs).toBe(MONITOR_DELVM_TIMEOUT_MS);
		// list() passes undefined and inherits the fast-query default.
		expect(calls.find((c) => c.command === "info snapshots")?.timeoutMs).toBeUndefined();
	});
});
