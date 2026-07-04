import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = join(import.meta.dir, ".tmp-cli-settings-test");
const CLI = join(import.meta.dir, "../../src/cli/index.ts");
const originalHome = process.env.HOME;

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
	return { stdout, stderr, exitCode };
}

function writeSettingsFile(content: string): void {
	const dir = join(TEST_DIR, ".config", "quickchr");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "quickchr.env"), content, "utf-8");
}

beforeEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.HOME = TEST_DIR;
});

afterEach(() => {
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("CLI `quickchr settings`", () => {
	test("print shows all 5 keys with their built-in defaults when nothing is configured", async () => {
		const { stdout, exitCode } = await runQuickchr(["settings", "print"]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("default-channel");
		expect(stdout).toContain("stable");
		expect(stdout).toContain("cache-max-size");
		expect(stdout).toContain("2.00 GiB");
		expect(stdout).toContain("timeout-extra");
		expect(stdout).toContain("secure-login");
		expect(stdout).toContain("(unset)");
	});

	test("print --json is valid JSON with all 5 entries", async () => {
		const { stdout, exitCode } = await runQuickchr(["settings", "print", "--json"]);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		expect(parsed.settings).toHaveLength(5);
	});

	test("set/get/reset round-trip through the real CLI", async () => {
		const setRes = await runQuickchr(["settings", "set", "default-channel", "testing"]);
		expect(setRes.exitCode).toBe(0);
		expect(setRes.stdout).toContain("testing");

		const getRes = await runQuickchr(["settings", "get", "default-channel"]);
		expect(getRes.exitCode).toBe(0);
		expect(getRes.stdout.trim()).toBe("testing");

		const resetRes = await runQuickchr(["settings", "reset", "default-channel"]);
		expect(resetRes.exitCode).toBe(0);

		const afterReset = await runQuickchr(["settings", "get", "default-channel"]);
		expect(afterReset.stdout.trim()).toBe("stable");
	});

	test("an invalid set value fails with a clear error and non-zero exit", async () => {
		const { stderr, exitCode } = await runQuickchr(["settings", "set", "default-arch", "bogus"]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("INVALID_SETTING_VALUE");
	});

	// Regression test for a review finding: `settings print` (all-keys) previously
	// resolved each key with the strict resolveSetting(), so a single malformed
	// env/file value crashed the whole command instead of showing the rest of the
	// table. It must use the tolerant settingsPrint() helper instead.
	test("print tolerates a corrupted value in quickchr.env — shows the rest of the table instead of crashing", async () => {
		writeSettingsFile("QUICKCHR_DEFAULT_CHANNEL=testing\nQUICKCHR_TIMEOUT_EXTRA=not-a-number\n");
		const { stdout, exitCode } = await runQuickchr(["settings", "print"]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("default-channel");
		expect(stdout).toContain("testing");
		expect(stdout).toContain("timeout-extra");
		expect(stdout).toContain("not-a-number");
		expect(stdout).toContain("secure-login");
	});
});
