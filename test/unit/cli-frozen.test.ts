// cspell:ignore nosuchmachine
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync } from "node:fs";
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
		expect(result.stderr).toContain("Usage: quickchr continue <name> [--no-wait]");
	});

	test("rejects flags other than --no-wait", async () => {
		const result = await runQuickchr(["continue", "lab", "--fg"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("continue accepts only <name> and --no-wait");
	});

	test("on a missing machine names it instead of throwing", async () => {
		const result = await runQuickchr(["continue", "nosuchmachine"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain('Machine "nosuchmachine" not found');
	});

	test("--help works and creates no state", async () => {
		const result = await runQuickchr(["continue", "--help"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("quickchr continue <name> [--no-wait]");
	});
});
