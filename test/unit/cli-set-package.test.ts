import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFlags } from "../../src/cli/index.ts";
import type { MachineState, NetworkConfig } from "../../src/lib/types.ts";

/**
 * `quickchr set <name> --package …` — the post-boot route for installing extra
 * packages on a running machine (#24).
 *
 * Packages are additive: installing one cannot rewrite config that drifted since
 * boot, so this step may run against a booted guest like device-mode. It wraps
 * `installPackage()` — SCP upload, reboot to activate, wait for REST — and inherits
 * #176's preconditions: running machine, user-mode NIC, REST reachable, 7.20.8+.
 *
 * Everything here stops short of the guest. The applied-for-real path is
 * `test/integration/set-package.test.ts`.
 */

const TEST_DIR = join(import.meta.dir, ".tmp-cli-set-package-test");
const CLI = join(import.meta.dir, "../../src/cli/index.ts");

function machineState(
	name: string,
	status: MachineState["status"],
	networks: NetworkConfig[] = [{ specifier: "user", id: "net0" }],
	version = "7.24.4",
): MachineState {
	return {
		name,
		version,
		arch: "x86",
		cpu: 1,
		mem: 512,
		networks,
		ports: {
			http: { name: "http", host: 19200, guest: 80, proto: "tcp" },
			ssh: { name: "ssh", host: 19202, guest: 22, proto: "tcp" },
		},
		packages: [],
		portBase: 19200,
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

describe("--package parsing", () => {
	test("repeatable, like --add-package", () => {
		const { flags } = parseFlags(["lab", "--package", "container", "--package", "ups"]);
		expect(flags.package).toEqual(["container", "ups"]);
	});

	test("comma-separated values stay one argument — cmdSet splits them", () => {
		const { flags } = parseFlags(["lab", "--package", "container,ups"]);
		expect(flags.package).toBe("container,ups");
	});

	test("an empty value splits to nothing, which is not a request", async () => {
		// `--package ""` parses as a value (so the arity check passes) but asks for
		// no package — that is "nothing to set", not an install of nothing.
		writeMachine(machineState("lab", "stopped"));
		const { output, exitCode } = await runQuickchr(["set", "lab", "--package", ""]);
		expect(exitCode).toBe(1);
		expect(output).toContain("Nothing to set");
	});
});

describe("quickchr set --package — what it refuses before touching the guest", () => {
	test("no flags lists --package alongside --license and --device-mode", async () => {
		writeMachine(machineState("lab", "stopped"));
		const { output, exitCode } = await runQuickchr(["set", "lab"]);
		expect(exitCode).toBe(1);
		expect(output).toContain("Nothing to set");
		expect(output).toContain("--package");
	});

	test("--package with no value is named as a missing value, not 'nothing to set'", async () => {
		// `--package` parses as a boolean when nothing follows it — so without the
		// arity check the user is told they asked for nothing, which blames them
		// for the wrong thing.
		writeMachine(machineState("lab", "stopped"));
		const { output, exitCode } = await runQuickchr(["set", "lab", "--package"]);
		expect(exitCode).toBe(1);
		expect(output).toContain("missing a value");
		expect(output).toContain("--package <value>");
	});

	test("a stopped machine is told to start it, not left failing inside SCP", async () => {
		// Without the guard the stopped machine reaches the SCP upload and fails
		// with a connection error about a guest that was never going to answer.
		writeMachine(machineState("lab", "stopped"));
		const { output, exitCode } = await runQuickchr(["set", "lab", "--package", "container"]);
		expect(exitCode).toBe(1);
		expect(output).toContain("MACHINE_STOPPED");
		expect(output).toContain("quickchr start lab");
	});

	test("a machine with no user-mode NIC is refused — packages go over localhost SSH and REST", async () => {
		writeMachine(machineState("socketed", "running", [{ specifier: { type: "socket", name: "link" }, id: "net0" }]));
		const { output, exitCode } = await runQuickchr(["set", "socketed", "--package", "container"]);
		expect(exitCode).toBe(1);
		expect(output).toContain("NETWORK_UNAVAILABLE");
		expect(output).toContain("user-mode network interface");
	});

	test("an old RouterOS is refused before anything is announced", async () => {
		writeMachine(machineState("old", "running", undefined, "7.19.0"));
		const { output, exitCode } = await runQuickchr(["set", "old", "--package", "container"]);
		expect(exitCode).toBe(1);
		expect(output).toContain("PROVISIONING_VERSION_UNSUPPORTED");
	});

	test("an unknown machine is reported before any of that", async () => {
		const { output, exitCode } = await runQuickchr(["set", "ghost", "--package", "container"]);
		expect(exitCode).toBe(1);
		expect(output).toContain("ghost");
	});
});

describe("quickchr set --help", () => {
	test("documents --package, the reboot, and the preconditions", async () => {
		const { output } = await runQuickchr(["set", "--help"]);
		expect(output).toContain("--package");
		expect(output).toContain("reboot");
		expect(output).toContain("REST reachable");
	});
});
