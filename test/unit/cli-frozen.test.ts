// cspell:ignore nosuchmachine
import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseFlags, secureLoginSettingApplies } from "../../src/cli/index.ts";
import { ADD_FLAGS, START_FLAGS, VALUE_FLAGS } from "../../src/cli/flags.ts";

/**
 * `start --frozen` and `quickchr continue` (#214). The CLI is run as a
 * subprocess against an empty data dir; every case here is refused, usage, or
 * help, so none of them reaches QEMU. The live resume path is covered by
 * test/integration/frozen-continue.test.ts.
 */

const TEST_DIR = join(import.meta.dir, ".tmp-cli-frozen");
const CLI = join(import.meta.dir, "../../src/cli/index.ts");

async function runQuickchr(args: string[], env: Record<string, string> = {}) {
	const proc = Bun.spawn([process.execPath, CLI, ...args], {
		env: {
			...process.env,
			QUICKCHR_DATA_DIR: TEST_DIR,
			HOME: join(TEST_DIR, "home"),
			NO_COLOR: "1",
			QUICKCHR_NO_PROMPT: "1",
			...env,
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

beforeEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));
afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe("flag resolution", () => {
	test("--frozen is a known boolean start-only flag", () => {
		expect(parseFlags(["--frozen", "lab"])).toEqual({ flags: { frozen: true }, positional: ["lab"] });
		expect(START_FLAGS).toContain("frozen");
		expect(ADD_FLAGS).not.toContain("frozen");
		expect(VALUE_FLAGS.has("frozen")).toBe(false);
	});

	test("the secure-login setting stays out of frozen starts, like --no-wait", () => {
		expect(secureLoginSettingApplies({ frozen: true }, true, "7.24.5")).toBe(false);
		expect(secureLoginSettingApplies({}, true, "7.24.5")).toBe(true);
	});
});

describe("start --frozen", () => {
	test("with a provisioning flag is a clear error, before anything is created", async () => {
		const result = await runQuickchr(["start", "--name", "fz", "--version", "7.24.5", "--arch", "x86", "--frozen", "--add-package", "container"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Error [INVALID_ARGUMENT]: --frozen (frozen: true) cannot be combined with provisioning");
	});

	test("with --fg is refused, without printing the foreground console tips first", async () => {
		const result = await runQuickchr(["start", "--name", "fz", "--version", "7.24.5", "--arch", "x86", "--frozen", "--fg"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Error [INVALID_ARGUMENT]");
		expect(result.stdout).not.toContain("Ctrl-A");
	});

	test("--all refuses --frozen", async () => {
		const result = await runQuickchr(["start", "--all", "--frozen"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Error [INVALID_ARGUMENT]");
	});

	test("--help documents --frozen and names continue as the resume", async () => {
		const result = await runQuickchr(["start", "--help"]);
		expect(result.stdout).toContain("--frozen");
		expect(result.stdout).toContain("quickchr continue");
	});
});

describe("quickchr continue", () => {
	test("with no name is a usage error", async () => {
		const result = await runQuickchr(["continue"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Usage: quickchr continue <name> [--no-wait] [--timeout-extra <s>]");
	});

	test("rejects flags other than --no-wait/--timeout-extra", async () => {
		const result = await runQuickchr(["continue", "lab", "--fg"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("continue accepts only <name>, --no-wait and --timeout-extra <s>");
	});

	test("on a missing machine names it instead of throwing", async () => {
		const result = await runQuickchr(["continue", "nosuchmachine"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain('Machine "nosuchmachine" not found');
	});

	test("--help works and creates no state", async () => {
		const result = await runQuickchr(["continue", "--help"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("quickchr continue <name> [--no-wait] [--timeout-extra <s>]");
		expect(result.stdout).toContain("--timeout-extra");
		expect(existsSync(join(TEST_DIR, "machines"))).toBe(false);
	});

	test("add/start --help document the passthrough next to --frozen", async () => {
		for (const command of ["add", "start"]) {
			const result = await runQuickchr([command, "--help"]);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("--qemu-arg");
		}
	});

	test("--dry-run carries qemuArgs and frozen in its options JSON", async () => {
		const result = await runQuickchr([
			"start", "--name", "fz", "--version", "7.24.5", "--arch", "x86",
			"--dry-run", "--qemu-arg", "-M", "--qemu-arg", "pc", "--frozen",
		]);
		expect(result.exitCode).toBe(0);
		const json = JSON.parse(result.stdout.slice(result.stdout.indexOf("{"))) as Record<string, unknown>;
		expect(json["qemuArgs"]).toEqual(["-M", "pc"]);
		expect(json["frozen"]).toBe(true);
	});
});

describe("frozen output and continue options (mocked QuickCHR boundary)", () => {
	const savedEnv = {
		home: process.env.HOME,
		dataDir: process.env.QUICKCHR_DATA_DIR,
		noColor: process.env.NO_COLOR,
		noTips: process.env.QUICKCHR_NO_TIPS,
	};
	let lines: string[];

	beforeEach(async () => {
		process.env.HOME = join(TEST_DIR, "home");
		process.env.QUICKCHR_DATA_DIR = join(TEST_DIR, "data");
		process.env.NO_COLOR = "1";
		process.env.QUICKCHR_NO_TIPS = "1";
		lines = [];
		spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		});
		spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		mock.restore();
		for (const [key, value] of [
			["HOME", savedEnv.home],
			["QUICKCHR_DATA_DIR", savedEnv.dataDir],
			["NO_COLOR", savedEnv.noColor],
			["QUICKCHR_NO_TIPS", savedEnv.noTips],
		] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	async function requireQuickCHR() {
		// Dynamic import keeps the top-of-file imports subprocess-only.
		return import("../../src/lib/quickchr.ts");
	}

	test("start --frozen on an already-running normal machine does not claim frozen", async () => {
		const { QuickCHR } = await requireQuickCHR();
		const { cmdStart } = await import("../../src/cli/index.ts");
		const state = {
			name: "lab", version: "7.24.5", arch: "x86", status: "running",
			networks: [], ports: {}, lastStartedAt: "2026-10-21T00:00:00.000Z",
		};
		spyOn(QuickCHR, "get").mockImplementation(() => ({ name: "lab", state }) as never);
		spyOn(QuickCHR, "start").mockImplementation(async () => ({
			name: "lab", state, ports: { http: 9100, api: 9103, winbox: 9105 }, sshPort: 9102,
		}) as never);
		await cmdStart(["lab", "--frozen", "--version", "7.24.5", "--arch", "x86"]);
		expect(lines[0]).toContain("started");
		expect(lines[0]).not.toContain("frozen at reset");
	});

	test("plain start on a frozen running machine reports frozen, not started", async () => {
		const { QuickCHR } = await requireQuickCHR();
		const { cmdStart } = await import("../../src/cli/index.ts");
		const machineDir = join(TEST_DIR, "data", "machines", "lab");
		const state = { name: "lab", version: "7.24.5", arch: "x86", status: "running", frozen: true, machineDir, lastStartedAt: "2026-10-21T00:00:00.000Z" };
		spyOn(QuickCHR, "get").mockImplementation(() => ({ name: "lab", state }) as never);
		spyOn(QuickCHR, "start").mockImplementation(async () => ({ name: "lab", state }) as never);
		await cmdStart(["lab", "--version", "7.24.5", "--arch", "x86"]);
		expect(lines[0]).toContain("frozen at reset");
		expect(lines[1]).toContain("gdb.sock");
	});

	test("continue forwards --timeout-extra to instance.continue", async () => {
		const { QuickCHR } = await requireQuickCHR();
		const { cmdContinue } = await import("../../src/cli/index.ts");
		const seen: unknown[] = [];
		const state = { name: "lab", version: "7.24.5", arch: "x86", status: "running", ports: { http: { host: 9100, guest: 80 } } };
		spyOn(QuickCHR, "get").mockImplementation(() => ({
			name: "lab",
			state,
			ports: { http: 9100, api: 9103 },
			sshPort: 9102,
			continue: async (opts: unknown) => { seen.push(opts); },
		}) as never);
		await cmdContinue(["lab", "--timeout-extra", "30"]);
		expect(seen).toEqual([{ wait: true, timeoutExtra: 30_000 }]);
	});

	test("continue merges the -T alias into --timeout-extra", async () => {
		const { QuickCHR } = await requireQuickCHR();
		const { cmdContinue } = await import("../../src/cli/index.ts");
		const seen: unknown[] = [];
		const state = { name: "lab", version: "7.24.5", arch: "x86", status: "running", ports: { http: { host: 9100, guest: 80 } } };
		spyOn(QuickCHR, "get").mockImplementation(() => ({
			name: "lab",
			state,
			ports: { http: 9100, api: 9103 },
			sshPort: 9102,
			continue: async (opts: unknown) => { seen.push(opts); },
		}) as never);
		await cmdContinue(["lab", "-T", "15"]);
		expect(seen).toEqual([{ wait: true, timeoutExtra: 15_000 }]);
	});

	test("continue rejects an invalid --timeout-extra before resuming", async () => {
		const { QuickCHR } = await requireQuickCHR();
		const { cmdContinue } = await import("../../src/cli/index.ts");
		let resumed = false;
		spyOn(QuickCHR, "get").mockImplementation(() => ({
			name: "lab",
			state: { name: "lab", version: "7.24.5", arch: "x86", status: "running" },
			continue: async () => { resumed = true; },
		}) as never);
		await expect(cmdContinue(["lab", "--timeout-extra", "abc"])).rejects.toThrow();
		expect(resumed).toBe(false);
	});
});
