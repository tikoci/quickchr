// cspell:ignore nosuchmachine
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { saveMachine } from "../../src/lib/state.ts";
import type { MachineState } from "../../src/lib/types.ts";

/**
 * `set --qemu-arg` / `--clear-qemu-args` (#213 recovery route) against state
 * fixtures — no QEMU: recording boot config needs no guest.
 */

const TEST_DIR = join(import.meta.dir, ".tmp-cli-set-qemu-args");
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

function machine(name: string, overrides: Partial<MachineState> = {}): MachineState {
	return {
		name,
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
		status: "stopped",
		machineDir: join(TEST_DIR, "machines", name),
		...overrides,
	};
}

async function recordedArgs(name: string): Promise<unknown> {
	const result = await runQuickchr(["list", name, "--json"]);
	expect(result.exitCode).toBe(0);
	return (JSON.parse(result.stdout) as Record<string, unknown>)["qemuArgs"];
}

beforeEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.QUICKCHR_DATA_DIR = TEST_DIR;
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	delete process.env.QUICKCHR_DATA_DIR;
});

describe("set --qemu-arg", () => {
	test("records passthrough on a stopped machine", async () => {
		saveMachine(machine("qa"));
		const result = await runQuickchr(["set", "qa", "--qemu-arg", "-M", "--qemu-arg", "pc"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Recorded QEMU args on qa");
		expect(await recordedArgs("qa")).toEqual(["-M", "pc"]);
	});

	test("replaces previously recorded args wholesale", async () => {
		saveMachine(machine("qa", { qemuArgs: ["-M", "pc"] }));
		const result = await runQuickchr(["set", "qa", "--qemu-arg", "-name", "--qemu-arg", "qa"]);
		expect(result.exitCode).toBe(0);
		expect(await recordedArgs("qa")).toEqual(["-name", "qa"]);
	});

	test("--clear-qemu-args drops recorded args", async () => {
		saveMachine(machine("qa", { qemuArgs: ["-M", "pc"] }));
		const result = await runQuickchr(["set", "qa", "--clear-qemu-args"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Cleared recorded QEMU args on qa");
		expect(await recordedArgs("qa")).toEqual([]);
	});

	test("refuses a running machine — boot config applies at boot", async () => {
		saveMachine(machine("qa", { status: "running", pid: process.pid }));
		const result = await runQuickchr(["set", "qa", "--qemu-arg", "-M"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("stop it first");
	});

	test("names a missing machine instead of throwing", async () => {
		const result = await runQuickchr(["set", "nosuchmachine", "--qemu-arg", "-M"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain('Machine "nosuchmachine" not found');
	});

	test("a valueless --qemu-arg names the missing value", async () => {
		saveMachine(machine("qa"));
		const result = await runQuickchr(["set", "qa", "--qemu-arg"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("--qemu-arg <value>");
	});
});
