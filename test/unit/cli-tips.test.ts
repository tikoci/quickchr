import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { CENTRS_EXEC_TIP, tipsForError } from "../../src/cli/tips.ts";

const TEST_DIR = join(import.meta.dir, ".tmp-cli-tips");
const CLI = join(import.meta.dir, "../../src/cli/index.ts");

async function runQuickchr(args: string[], env: Record<string, string> = {}) {
	const proc = Bun.spawn(["bun", CLI, ...args], {
		env: { ...process.env, QUICKCHR_DATA_DIR: TEST_DIR, NO_COLOR: "1", QUICKCHR_NO_PROMPT: "1", ...env },
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

beforeEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("tips point at the validated path", () => {
	test("exec --help names centrs as the command-validating client", async () => {
		const result = await runQuickchr(["exec", "--help"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("centrs execute  --quickchr <name> <command>");
		expect(result.stdout).toContain("/rest/execute");
	});

	test("exec with no arguments tips toward centrs", async () => {
		const result = await runQuickchr(["exec"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain(CENTRS_EXEC_TIP);
	});

	test("tips go to stderr, never into a command's output", async () => {
		const result = await runQuickchr(["exec"]);
		expect(result.stdout).not.toContain("tip:");
	});

	test("QUICKCHR_NO_TIPS silences them", async () => {
		const result = await runQuickchr(["exec"], { QUICKCHR_NO_TIPS: "1" });
		expect(result.exitCode).toBe(1);
		expect(result.stderr).not.toContain("tip:");
		// The usage text itself is not a tip and must survive.
		expect(result.stderr).toContain("Usage: quickchr exec");
	});

	test("tipsForError stays scoped to the command it helps", () => {
		expect(tipsForError("EXEC_FAILED", "exec")).toEqual([CENTRS_EXEC_TIP]);
		expect(tipsForError("EXEC_FAILED", "start")).toEqual([]);
		expect(tipsForError("BOOT_TIMEOUT", "exec")).toEqual([]);
	});
});
