import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { parseFlags, secureLoginSettingApplies } from "../../src/cli/index.ts";
import { START_FLAGS, VALUE_FLAGS } from "../../src/cli/flags.ts";

/**
 * `start --no-wait` and the `--bg` deprecation (#159), and the CLI half of RouterOS 6
 * as a boot-only target (#182). The CLI is run as a subprocess against an empty data
 * dir; every case here is refused or dry-run, so none of them reaches QEMU.
 */

const TEST_DIR = join(import.meta.dir, ".tmp-cli-no-wait");
const CLI = join(import.meta.dir, "../../src/cli/index.ts");

async function runQuickchr(args: string[]) {
	const proc = Bun.spawn(["bun", CLI, ...args], {
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

beforeEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));
afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe("flag resolution", () => {
	test("--no-wait parses as wait=false and is a known, boolean start flag", () => {
		expect(parseFlags(["--no-wait", "lab"])).toEqual({ flags: { wait: false }, positional: ["lab"] });
		expect(START_FLAGS).toContain("wait");
		expect(VALUE_FLAGS.has("wait")).toBe(false);
	});

	test("the secure-login setting stays out of starts that cannot provision", () => {
		expect(secureLoginSettingApplies({}, true, "7.24.5")).toBe(true);
		expect(secureLoginSettingApplies({}, false, "7.24.5")).toBe(false);
		expect(secureLoginSettingApplies({ wait: false }, true, "7.24.5")).toBe(false);
		expect(secureLoginSettingApplies({}, true, "6.49.23")).toBe(false);
		// No version known yet (channel start): the setting applies as before.
		expect(secureLoginSettingApplies({}, true, undefined)).toBe(true);
	});
});

describe("start --no-wait", () => {
	for (const extra of [["--add-package", "container"], ["--fg"], ["--no-bg"], ["--device-mode", "rose"], ["--add-user", "ops:pw"]]) {
		test(`--all refuses ignored options: ${extra.join(" ")}`, async () => {
			const result = await runQuickchr(["start", "--all", "--no-wait", ...extra]);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("Error [INVALID_ARGUMENT]");
			expect(result.stdout).not.toContain("No stopped instances");
		});
	}

	test("with a provisioning flag is a clear error, before anything is created", async () => {
		const result = await runQuickchr(["start", "--name", "nw", "--version", "7.24.5", "--arch", "x86", "--no-wait", "--add-package", "container"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Error [INVALID_ARGUMENT]: --no-wait (wait: false) cannot be combined with provisioning");
	});

	test("with --fg is refused, without printing the foreground console tips first", async () => {
		const result = await runQuickchr(["start", "--name", "nw", "--version", "7.24.5", "--arch", "x86", "--no-wait", "--fg"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Error [INVALID_ARGUMENT]");
		expect(result.stdout).not.toContain("Ctrl-A");
	});

	test("--help documents --no-wait and names centrs as the way to own readiness", async () => {
		const result = await runQuickchr(["start", "--help"]);
		expect(result.stdout).toContain("--no-wait");
		expect(result.stdout).toContain("centrs retrieve --quickchr <name> /system/resource --wait 5m");
		expect(result.stdout).toMatch(/--bg \/ --background\s+Deprecated, does nothing/);
	});
});

describe("--bg is a deprecated no-op", () => {
	test("is accepted, warns on stderr, and changes nothing about the start", async () => {
		const plain = await runQuickchr(["start", "--name", "bg", "--version", "7.24.5", "--arch", "x86", "--dry-run"]);
		const withBg = await runQuickchr(["start", "--name", "bg", "--version", "7.24.5", "--arch", "x86", "--dry-run", "--bg"]);
		expect(withBg.exitCode).toBe(0);
		expect(withBg.stderr).toContain("--bg is deprecated and does nothing");
		expect(withBg.stderr).toContain("--no-wait");
		expect(plain.stderr).not.toContain("deprecated");
		// The dry-run dump is the resolved StartOptions: identical with and without --bg.
		expect(withBg.stdout).toBe(plain.stdout);
	});
});

describe("RouterOS 6 on the CLI (#182)", () => {
	test("add refuses an explicit provisioning flag with the boot-only message, not the 7.x advice", async () => {
		const result = await runQuickchr(["add", "--name", "lab6", "--version", "6.49.23", "--arch", "x86", "--add-user", "ops:pw"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Error [PROVISIONING_VERSION_UNSUPPORTED]");
		expect(result.stderr).toContain("RouterOS 6 is a best-effort boot-only target");
		expect(result.stderr).not.toContain("For older 7.x");
	});

	test("start refuses arm64 for 6.x before downloading", async () => {
		const result = await runQuickchr(["start", "--name", "lab6", "--version", "6.49.23", "--arch", "arm64"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Error [INVALID_ARCH]");
		expect(result.stderr).toContain("x86 only");
	});
});
