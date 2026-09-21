import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deviceModeFromFlags, parseFlags } from "../../src/cli/index.ts";
import type { MachineState, NetworkConfig } from "../../src/lib/types.ts";

/**
 * `quickchr set <name> --device-mode…` — the post-boot route for the one provisioning
 * step that is safe to run against a booted guest (#176).
 *
 * Device-mode is a capability flag: it gates whether a feature *can* run and says
 * nothing about how the guest is configured, so applying it later cannot clobber
 * working config. It needs a power cycle, which is why it lives in quickchr rather
 * than in a tool that reaches a router over the network.
 *
 * Everything here stops short of the guest. The applied-for-real path is
 * `test/integration/device-mode.test.ts`.
 */

const TEST_DIR = join(import.meta.dir, ".tmp-cli-set-device-mode-test");
const CLI = join(import.meta.dir, "../../src/cli/index.ts");

function machineState(
	name: string,
	status: MachineState["status"],
	networks: NetworkConfig[] = [{ specifier: "user", id: "net0" }],
): MachineState {
	return {
		name,
		version: "7.24.4",
		arch: "x86",
		cpu: 1,
		mem: 512,
		networks,
		ports: {
			http: { name: "http", host: 19100, guest: 80, proto: "tcp" },
			ssh: { name: "ssh", host: 19102, guest: 22, proto: "tcp" },
		},
		packages: [],
		portBase: 19100,
		excludePorts: [],
		extraPorts: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		lastStartedAt: "2026-01-01T00:01:00.000Z",
		status,
		// The live machine's pid is this test process, so `isMachineRunning` answers
		// yes without a QEMU to start.
		pid: status === "running" ? process.pid : undefined,
		machineDir: join(TEST_DIR, "machines", name),
	};
}

function writeMachine(state: MachineState): void {
	mkdirSync(state.machineDir, { recursive: true });
	writeFileSync(join(state.machineDir, "machine.json"), `${JSON.stringify(state, null, "\t")}\n`);
}

async function runQuickchr(args: string[]) {
	const proc = Bun.spawn(["bun", CLI, ...args], {
		env: {
			...process.env,
			QUICKCHR_DATA_DIR: TEST_DIR,
			NO_COLOR: "1",
			QUICKCHR_NO_PROMPT: "1",
			HOME: TEST_DIR,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode, output: stdout + stderr };
}

beforeEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("deviceModeFromFlags", () => {
	test("mode, enable and disable come through, comma-split and de-duplicated", () => {
		const { flags } = parseFlags([
			"lab", "--device-mode", "basic",
			"--device-mode-enable", "container,ipsec",
			"--device-mode-enable", "container",
			"--device-mode-disable", "smb",
		]);
		expect(deviceModeFromFlags(flags)).toEqual({
			mode: "basic",
			enable: ["container", "ipsec"],
			disable: ["smb"],
		});
	});

	test("a feature with no mode asks for 'auto' — resolution turns that into rose", () => {
		const { flags } = parseFlags(["lab", "--device-mode-enable", "container"]);
		expect(deviceModeFromFlags(flags)).toEqual({ mode: "auto", enable: ["container"], disable: undefined });
	});

	test("no device-mode flags at all is not a request", () => {
		expect(deviceModeFromFlags(parseFlags(["lab", "--json"]).flags)).toBeUndefined();
	});

	test("--no-device-mode skips, and says so rather than dropping the feature lists", () => {
		// One reader for `add`, `start` and `set`, because the two copies it replaced had
		// already drifted: only `start` honoured `--no-device-mode`, so the same flags on
		// `add` enabled container while `start` skipped device-mode with a warning. Two
		// spellings of one intent producing opposite results is #176 in another costume.
		const { flags } = parseFlags(["lab", "--no-device-mode", "--device-mode-enable", "container"]);
		expect(deviceModeFromFlags(flags)).toBeUndefined();
	});
});

describe("quickchr set — what it refuses before touching the guest", () => {
	test("no flags lists device-mode alongside --license", async () => {
		writeMachine(machineState("lab", "stopped"));
		const { output, exitCode } = await runQuickchr(["set", "lab"]);
		expect(exitCode).toBe(1);
		expect(output).toContain("Nothing to set");
		expect(output).toContain("--device-mode");
	});

	test("--device-mode with no value is named as a missing value, not 'nothing to set'", async () => {
		// `--device-mode` parses as a boolean when nothing follows it, and `flag()` turns
		// that back into undefined — so without the arity check the user is told they
		// asked for nothing, which blames them for the wrong thing.
		writeMachine(machineState("lab", "stopped"));
		const { output, exitCode } = await runQuickchr(["set", "lab", "--device-mode"]);
		expect(exitCode).toBe(1);
		expect(output).toContain("missing a value");
		expect(output).toContain("--device-mode <value>");
	});

	test("--no-device-mode is refused: there is nothing to skip in an imperative set", async () => {
		writeMachine(machineState("lab", "stopped"));
		const { output, exitCode } = await runQuickchr(["set", "lab", "--no-device-mode"]);
		expect(exitCode).toBe(1);
		expect(output).toContain("--no-device-mode is a provisioning flag");
	});

	test("a stopped machine is told to start it, not left waiting on a REST timeout", async () => {
		// applyDeviceMode() polls waitForDeviceModeApi before it does anything, so an
		// unchecked stopped machine spends 60s to report a timeout about a machine that
		// was never going to answer.
		writeMachine(machineState("lab", "stopped"));
		const { output, exitCode } = await runQuickchr(["set", "lab", "--device-mode", "rose"]);
		expect(exitCode).toBe(1);
		expect(output).toContain("MACHINE_STOPPED");
		expect(output).toContain("quickchr start lab");
	});

	test("a machine with no user-mode NIC is refused — device-mode goes over localhost REST", async () => {
		writeMachine(machineState("socketed", "running", [{ specifier: { type: "socket", name: "link" }, id: "net0" }]));
		const { output, exitCode } = await runQuickchr(["set", "socketed", "--device-mode", "rose"]);
		expect(exitCode).toBe(1);
		expect(output).toContain("NETWORK_UNAVAILABLE");
		expect(output).toContain("user-mode network interface");
	});

	test("--device-mode skip resolves to no change, and says so instead of power-cycling", async () => {
		writeMachine(machineState("lab", "running"));
		const { output, exitCode } = await runQuickchr(["set", "lab", "--device-mode", "skip"]);
		expect(exitCode).toBe(1);
		expect(output).toContain("Nothing to set");
	});

	test("an unknown machine is reported before any of that", async () => {
		const { output, exitCode } = await runQuickchr(["set", "ghost", "--device-mode", "rose"]);
		expect(exitCode).toBe(1);
		expect(output).toContain("ghost");
	});
});

describe("quickchr set --help", () => {
	test("documents the power cycle, the preconditions, and what has no set route", async () => {
		const { output } = await runQuickchr(["set", "--help"]);
		expect(output).toContain("--device-mode-enable");
		expect(output).toContain("power cycle");
		expect(output).toContain("user-mode NIC");
		// The exclusions are the half a reader cannot infer from the flag list.
		expect(output).toContain("--add-user");
		expect(output).toContain("quickchr clean");
	});
});
