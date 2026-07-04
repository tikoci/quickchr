import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFlags, resolveTimeoutExtraMs, resolveSecureLoginFlag, applyTimeoutExtraShortFlag } from "../../src/cli/index.ts";
import { settingsFilePath } from "../../src/lib/settings.ts";
import { QuickCHRError } from "../../src/lib/types.ts";

const TMP = join(import.meta.dir, ".tmp-cli-start-flag-resolution-test");
const HOME = join(TMP, "home");
const originalHome = process.env.HOME;
const ENV_KEYS = ["QUICKCHR_TIMEOUT_EXTRA", "QUICKCHR_SECURE_LOGIN"];
const originalEnvValues = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
	rmSync(TMP, { recursive: true, force: true });
	process.env.HOME = HOME;
	for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
	rmSync(TMP, { recursive: true, force: true });
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	for (const k of ENV_KEYS) {
		if (originalEnvValues[k] === undefined) delete process.env[k];
		else process.env[k] = originalEnvValues[k];
	}
});

function writeSettingsFile(content: string): void {
	const path = settingsFilePath();
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content, "utf-8");
}

describe("applyTimeoutExtraShortFlag", () => {
	test("-T <n> is merged into flags['timeout-extra'] — parseFlags itself never recognizes single-dash args", () => {
		const argv = ["myname", "-T", "15"];
		const { flags } = parseFlags(argv);
		expect(flags["timeout-extra"]).toBeUndefined();
		applyTimeoutExtraShortFlag(argv, flags);
		expect(flags["timeout-extra"]).toBe("15");
	});

	test("does nothing when -T is absent", () => {
		const argv = ["myname"];
		const { flags } = parseFlags(argv);
		applyTimeoutExtraShortFlag(argv, flags);
		expect(flags["timeout-extra"]).toBeUndefined();
	});

	test("does nothing when -T has no following value", () => {
		const argv = ["myname", "-T"];
		const { flags } = parseFlags(argv);
		applyTimeoutExtraShortFlag(argv, flags);
		expect(flags["timeout-extra"]).toBeUndefined();
	});

	test("an explicit --timeout-extra always wins over a stray -T elsewhere in argv", () => {
		const argv = ["myname", "-T", "15", "--timeout-extra", "30"];
		const { flags } = parseFlags(argv);
		applyTimeoutExtraShortFlag(argv, flags);
		expect(flags["timeout-extra"]).toBe("30");
	});

	test("composes with resolveTimeoutExtraMs end-to-end", async () => {
		const argv = ["myname", "-T", "15"];
		const { flags } = parseFlags(argv);
		applyTimeoutExtraShortFlag(argv, flags);
		expect(await resolveTimeoutExtraMs(flags)).toBe(15_000);
	});

	test("consumes -T <n> from positional args when it appears before the machine name", () => {
		const argv = ["-T", "15", "lab"];
		const { flags, positional } = parseFlags(argv);
		applyTimeoutExtraShortFlag(argv, flags, positional);
		expect(flags["timeout-extra"]).toBe("15");
		expect(positional).toEqual(["lab"]);
	});

	test("still consumes a stray -T pair from positional args when --timeout-extra wins", () => {
		const argv = ["--timeout-extra", "30", "-T", "15", "lab"];
		const { flags, positional } = parseFlags(argv);
		applyTimeoutExtraShortFlag(argv, flags, positional);
		expect(flags["timeout-extra"]).toBe("30");
		expect(positional).toEqual(["lab"]);
	});
});

describe("resolveTimeoutExtraMs", () => {
	test("resolves to the built-in default (0ms) when no flag and no setting/env configured", async () => {
		const { flags } = parseFlags([]);
		expect(await resolveTimeoutExtraMs(flags)).toBe(0);
	});

	test("explicit flag wins over env and file, converted to ms", async () => {
		writeSettingsFile("QUICKCHR_TIMEOUT_EXTRA=10\n");
		process.env.QUICKCHR_TIMEOUT_EXTRA = "20";
		const { flags } = parseFlags(["--timeout-extra", "30"]);
		expect(await resolveTimeoutExtraMs(flags)).toBe(30_000);
	});

	test("explicit --timeout-extra 0 is honored, not treated as absent", async () => {
		const { flags } = parseFlags(["--timeout-extra", "0"]);
		expect(await resolveTimeoutExtraMs(flags)).toBe(0);
	});

	test("falls back to env when flag absent", async () => {
		process.env.QUICKCHR_TIMEOUT_EXTRA = "20";
		const { flags } = parseFlags([]);
		expect(await resolveTimeoutExtraMs(flags)).toBe(20_000);
	});

	test("falls back to the settings file when flag and env absent", async () => {
		writeSettingsFile("QUICKCHR_TIMEOUT_EXTRA=10\n");
		const { flags } = parseFlags([]);
		expect(await resolveTimeoutExtraMs(flags)).toBe(10_000);
	});

	test("an invalid --timeout-extra value throws INVALID_SETTING_VALUE instead of producing NaN", async () => {
		const { flags } = parseFlags(["--timeout-extra", "abc"]);
		await expect(resolveTimeoutExtraMs(flags)).rejects.toThrow(QuickCHRError);
		try {
			await resolveTimeoutExtraMs(flags);
			throw new Error("should have thrown");
		} catch (e) {
			expect((e as QuickCHRError).code).toBe("INVALID_SETTING_VALUE");
		}
	});

	test("a negative --timeout-extra value throws INVALID_SETTING_VALUE", async () => {
		const { flags } = parseFlags(["--timeout-extra", "-5"]);
		await expect(resolveTimeoutExtraMs(flags)).rejects.toThrow(QuickCHRError);
	});
});

describe("resolveSecureLoginFlag", () => {
	test("undefined when no flag and no setting/env configured", async () => {
		const { flags } = parseFlags([]);
		expect(await resolveSecureLoginFlag(flags)).toBeUndefined();
	});

	test("--no-secure-login always wins, even over an env/file value of true", async () => {
		writeSettingsFile("QUICKCHR_SECURE_LOGIN=true\n");
		process.env.QUICKCHR_SECURE_LOGIN = "true";
		const { flags } = parseFlags(["--no-secure-login"]);
		expect(await resolveSecureLoginFlag(flags)).toBe(false);
	});

	test("--secure-login wins over an unset setting", async () => {
		const { flags } = parseFlags(["--secure-login"]);
		expect(await resolveSecureLoginFlag(flags)).toBe(true);
	});

	test("falls back to the env var when neither flag is passed", async () => {
		process.env.QUICKCHR_SECURE_LOGIN = "true";
		const { flags } = parseFlags([]);
		expect(await resolveSecureLoginFlag(flags)).toBe(true);
	});

	test("falls back to the settings file when neither flag nor env is set", async () => {
		writeSettingsFile("QUICKCHR_SECURE_LOGIN=true\n");
		const { flags } = parseFlags([]);
		expect(await resolveSecureLoginFlag(flags)).toBe(true);
	});

	test("a false setting does not force secureLogin — leaves it undefined, not false", async () => {
		writeSettingsFile("QUICKCHR_SECURE_LOGIN=false\n");
		const { flags } = parseFlags([]);
		expect(await resolveSecureLoginFlag(flags)).toBeUndefined();
	});
});
