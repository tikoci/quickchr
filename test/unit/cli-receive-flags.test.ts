import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFlags } from "../../src/cli/index.ts";

describe("--receive / --no-receive parsing (#299)", () => {
	test("--receive is a repeatable value flag", () => {
		const { flags, positional } = parseFlags(["lab", "--receive", "tzsp", "--receive", "syslog:5515"]);
		expect(positional).toEqual(["lab"]);
		expect(flags.receive).toEqual(["tzsp", "syslog:5515"]);
	});

	test("--no-receive takes a name instead of negating --receive", () => {
		const { flags, positional } = parseFlags(["lab", "--no-receive", "tzsp"]);
		expect(positional).toEqual(["lab"]);
		expect(flags["no-receive"]).toBe("tzsp");
		expect(flags.receive).toBeUndefined();
	});

	test("other --no-x flags still negate", () => {
		const { flags, positional } = parseFlags(["lab", "--no-winbox"]);
		expect(flags.winbox).toBe(false);
		expect(positional).toEqual(["lab"]);
	});
});

describe("start --dry-run --receive (#303 review)", () => {
	const TEST_DIR = join(import.meta.dir, ".tmp-cli-receive");
	const CLI = join(import.meta.dir, "../../src/cli/index.ts");
	afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

	test("checks the slot like a real start: no user NIC is a non-zero exit", async () => {
		const machineDir = join(TEST_DIR, "machines", "alpha");
		mkdirSync(machineDir, { recursive: true });
		writeFileSync(join(machineDir, "machine.json"), JSON.stringify({
			name: "alpha",
			version: "7.22.1",
			arch: "x86",
			cpu: 1,
			mem: 512,
			networks: [{ specifier: "shared", id: "net0" }],
			ports: {},
			packages: [],
			portBase: 19100,
			excludePorts: [],
			extraPorts: [],
			createdAt: "2026-01-01T00:00:00.000Z",
			status: "stopped",
			machineDir,
		}));
		const proc = Bun.spawn([process.execPath, CLI, "start", "alpha", "--dry-run", "--receive", "tzsp"], {
			env: { ...process.env, QUICKCHR_DATA_DIR: TEST_DIR, HOME: join(TEST_DIR, "home"), NO_COLOR: "1", QUICKCHR_NO_PROMPT: "1" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		expect(exitCode).not.toBe(0);
		expect(stdout + stderr).toContain("no user-mode NIC");
		expect(stdout).not.toContain("Dry run — would start");
	}, 30_000);
});
