import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { MachineState } from "../../src/lib/types.ts";

const TEST_DIR = join(import.meta.dir, ".tmp-cli-list-unreadable");
const CLI = join(import.meta.dir, "../../src/cli/index.ts");

async function runQuickchr(args: string[]) {
	const proc = Bun.spawn(["bun", CLI, ...args], {
		env: {
			...process.env,
			QUICKCHR_DATA_DIR: TEST_DIR,
			NO_COLOR: "1",
			QUICKCHR_NO_PROMPT: "1",
			QUICKCHR_NO_TIPS: "1",
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

function healthyMachine(name: string, portBase: number): void {
	const state: MachineState = {
		name,
		version: "7.24.4",
		arch: "x86",
		cpu: 1,
		mem: 512,
		networks: [{ specifier: "user", id: "net0" }],
		ports: { http: { name: "http", host: portBase, guest: 80, proto: "tcp" } },
		packages: [],
		portBase,
		excludePorts: [],
		extraPorts: [],
		createdAt: new Date().toISOString(),
		status: "stopped",
		machineDir: join(TEST_DIR, "machines", name),
	};
	mkdirSync(state.machineDir, { recursive: true });
	writeFileSync(join(state.machineDir, "machine.json"), JSON.stringify(state, null, "\t"));
}

/** A `saveMachine()` that died mid-write — disk full, power loss — is the realistic way
 *  to get here, and a truncated object is what it leaves behind. */
function truncatedMachine(name: string): void {
	const dir = join(TEST_DIR, "machines", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "machine.json"), '{"name":"' + name + '","version":"7.24.4","po');
}

beforeEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("one corrupt machine.json does not cost the whole listing (#165)", () => {
	test("list completes, exit 0, with the healthy machines intact", async () => {
		healthyMachine("lab1", 9100);
		healthyMachine("lab2", 9110);
		truncatedMachine("lab3");

		const result = await runQuickchr(["list"]);
		// Exit 0 on purpose: the listing succeeded. A non-zero exit would punish the
		// working machines for the broken one and break every script piping `list`.
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("lab1");
		expect(result.stdout).toContain("lab2");
		expect(result.stdout).toContain("7.24.4");
		expect(result.stdout).not.toContain("JSON Parse error");
	});

	test("the unreadable machine is a row, named, with the remedy attached", async () => {
		healthyMachine("lab1", 9100);
		truncatedMachine("lab3");

		const result = await runQuickchr(["list"]);
		expect(result.stdout).toContain("lab3");
		expect(result.stdout).toContain("unreadable");
		// Not only a count: the row says which machine, and this says what to do about
		// it, so neither takes a second command to learn.
		expect(result.stdout).toContain("quickchr remove lab3");
	});

	test("a machine that is only unreadable is still not 'no instances'", async () => {
		truncatedMachine("lab3");

		const result = await runQuickchr(["list"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).not.toContain("No instances");
		expect(result.stdout).toContain("lab3");
	});

	test("--json carries it as its own shape, not a half-filled machine", async () => {
		healthyMachine("lab1", 9100);
		truncatedMachine("lab3");

		const result = await runQuickchr(["list", "--json"]);
		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
		expect(parsed).toHaveLength(2);
		const broken = parsed.find((m) => m.name === "lab3");
		expect(broken?.status).toBe("unreadable");
		expect(typeof broken?.error).toBe("string");
		// A consumer reading `version` must get nothing rather than a plausible lie.
		expect(broken?.version).toBeUndefined();
	});

	test("a targeted lookup still fails — and says which file and what to run", async () => {
		// `get(name)` is not an enumeration: you named *this* machine, it is corrupt, and
		// answering "no such machine" about a directory that exists would be a lie.
		truncatedMachine("lab3");

		const result = await runQuickchr(["list", "lab3"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("STATE_ERROR");
		expect(result.stderr).toContain("machine.json");
		expect(result.stderr).toContain("quickchr remove lab3");
	});

	test("remove clears it, and the listing goes back to clean", async () => {
		healthyMachine("lab1", 9100);
		truncatedMachine("lab3");

		const removed = await runQuickchr(["remove", "lab3"]);
		expect(removed.exitCode).toBe(0);

		const after = await runQuickchr(["list"]);
		expect(after.stdout).not.toContain("lab3");
		expect(after.stdout).toContain("lab1");
	});
});

describe("state.ts: enumeration and lookup take different policies (#165)", () => {
	const origDataDir = process.env.QUICKCHR_DATA_DIR;

	beforeEach(() => {
		process.env.QUICKCHR_DATA_DIR = TEST_DIR;
	});

	afterEach(() => {
		if (origDataDir === undefined) delete process.env.QUICKCHR_DATA_DIR;
		else process.env.QUICKCHR_DATA_DIR = origDataDir;
	});

	test("loadAllMachines skips the unreadable entry; listUnreadableMachines names it", async () => {
		const { loadAllMachines, listUnreadableMachines, loadMachine } = await import("../../src/lib/state.ts");
		healthyMachine("lab1", 9100);
		truncatedMachine("lab3");

		expect(loadAllMachines().map((m) => m.name)).toEqual(["lab1"]);
		expect(listUnreadableMachines().map((u) => u.name)).toEqual(["lab3"]);
		expect(listUnreadableMachines()[0]?.error).toContain("lab3");
		expect(() => loadMachine("lab3")).toThrow(/unreadable machine.json/);
	});

	test("a machine.json holding valid JSON that is not an object is unreadable too", async () => {
		// `JSON.parse("null")` succeeds, so a parse guard alone would hand every caller a
		// MachineState-typed null and move the crash somewhere less informative.
		const { listUnreadableMachines } = await import("../../src/lib/state.ts");
		const dir = join(TEST_DIR, "machines", "nulled");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "machine.json"), "null");

		expect(listUnreadableMachines().map((u) => u.name)).toEqual(["nulled"]);
	});

	test("a directory with no machine.json is an orphan, not an unreadable machine", async () => {
		// Different states with different remedies: one never finished being created
		// (#155), the other was a working machine whose state went bad. `list` shows the
		// second because it still holds a disk image under a name someone chose.
		const { listUnreadableMachines, listOrphanMachineDirs } = await import("../../src/lib/state.ts");
		mkdirSync(join(TEST_DIR, "machines", "half-made"), { recursive: true });
		truncatedMachine("lab3");

		expect(listUnreadableMachines().map((u) => u.name)).toEqual(["lab3"]);
		expect(listOrphanMachineDirs().sort()).toEqual(["half-made", "lab3"]);
	});
});
