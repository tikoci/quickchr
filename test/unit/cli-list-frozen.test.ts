import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { saveMachine } from "../../src/lib/state.ts";
import type { MachineState } from "../../src/lib/types.ts";

/**
 * Frozen `list` markers (#214 Visibility) without a guest: a fixture whose
 * pid is this test process reads as running, so the table, detail, and JSON
 * views render the frozen marker with no QEMU.
 */

const TEST_DIR = join(import.meta.dir, ".tmp-cli-list-frozen");
const CLI = join(import.meta.dir, "../../src/cli/index.ts");

async function runQuickchr(args: string[]) {
	const proc = Bun.spawn([process.execPath, CLI, ...args], {
		env: {
			...process.env,
			QUICKCHR_DATA_DIR: TEST_DIR,
			HOME: join(TEST_DIR, "home"),
			NO_COLOR: "1",
			QUICKCHR_NO_PROMPT: "1",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

function frozenMachine(): MachineState {
	return {
		name: "frost",
		version: "7.24.5",
		arch: "x86",
		cpu: 1,
		mem: 512,
		networks: [{ specifier: "user", id: "net0" }],
		ports: {},
		packages: [],
		portBase: 9130,
		excludePorts: [],
		extraPorts: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		status: "running",
		pid: process.pid,
		frozen: true,
		machineDir: join(TEST_DIR, "machines", "frost"),
	};
}

beforeEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.QUICKCHR_DATA_DIR = TEST_DIR;
	saveMachine(frozenMachine());
	// The monitor socket is never touched by list, but its absence must not matter.
	writeFileSync(join(TEST_DIR, "machines", "frost", "monitor.sock"), "");
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	delete process.env.QUICKCHR_DATA_DIR;
});

describe("list frozen markers", () => {
	test("table row carries (frozen)", async () => {
		const result = await runQuickchr(["list"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("frost (frozen)");
	});

	test("detail view shows Frozen and GDB lines", async () => {
		const result = await runQuickchr(["list", "frost"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Frozen:     yes — awaiting quickchr continue");
		expect(result.stdout).toContain(join("frost", "gdb.sock"));
		expect(result.stdout).toContain("endpoints answer after 'quickchr continue frost'");
	});

	test("single-machine --json carries frozen and qemuArgs", async () => {
		const result = await runQuickchr(["list", "frost", "--json"]);
		expect(result.exitCode).toBe(0);
		const json = JSON.parse(result.stdout) as Record<string, unknown>;
		expect(json["frozen"]).toBe(true);
		expect(json["qemuArgs"]).toEqual([]);
	});

	test("all-machines --json carries the frozen marker via the state dump", async () => {
		const result = await runQuickchr(["list", "--json"]);
		expect(result.exitCode).toBe(0);
		const json = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
		expect(json.find((m) => m["name"] === "frost")?.["frozen"]).toBe(true);
	});
});
