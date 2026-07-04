import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	SETTINGS_KEYS,
	settingsFilePath,
	lookupSettingsKey,
	resolveSetting,
	settingsGet,
	settingsPrint,
	settingsSet,
	settingsReset,
} from "../../src/lib/settings.ts";
import { saveMachine, loadMachine } from "../../src/lib/state.ts";
import { QuickCHRError } from "../../src/lib/types.ts";
import type { MachineState } from "../../src/lib/types.ts";

const TMP = join(import.meta.dir, ".tmp-settings-test");
const HOME = join(TMP, "home");
const originalHome = process.env.HOME;
const originalDataDir = process.env.QUICKCHR_DATA_DIR;
const ENV_KEYS = SETTINGS_KEYS.map((def) => def.envKey);
const originalEnvValues = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
	rmSync(TMP, { recursive: true, force: true });
	process.env.HOME = HOME;
	process.env.QUICKCHR_DATA_DIR = join(TMP, "data");
	for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
	rmSync(TMP, { recursive: true, force: true });
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalDataDir === undefined) delete process.env.QUICKCHR_DATA_DIR;
	else process.env.QUICKCHR_DATA_DIR = originalDataDir;
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

function readSettingsFileRaw(): string {
	return readFileSync(settingsFilePath(), "utf-8");
}

describe("settingsFilePath", () => {
	test("resolves under ~/.config/quickchr/quickchr.env", () => {
		expect(settingsFilePath()).toBe(join(HOME, ".config", "quickchr", "quickchr.env"));
	});
});

describe("lookupSettingsKey normalization", () => {
	test("accepts kebab, SCREAMING_SNAKE, prefixed, and lowercase-with-underscore forms", () => {
		expect(lookupSettingsKey("default-channel")?.attr).toBe("default-channel");
		expect(lookupSettingsKey("QUICKCHR_DEFAULT_CHANNEL")?.attr).toBe("default-channel");
		expect(lookupSettingsKey("DEFAULT_CHANNEL")?.attr).toBe("default-channel");
		expect(lookupSettingsKey("default_channel")?.attr).toBe("default-channel");
	});

	test("returns undefined for an unrecognized key", () => {
		expect(lookupSettingsKey("not-a-real-key")).toBeUndefined();
	});
});

describe("resolveSetting — precedence (env > file > default)", () => {
	test("default-channel: default when nothing configured", () => {
		expect(resolveSetting("default-channel")).toEqual({ value: "stable", source: "default" });
	});

	test("default-channel: file wins over default", () => {
		writeSettingsFile("QUICKCHR_DEFAULT_CHANNEL=testing\n");
		expect(resolveSetting("default-channel")).toEqual({ value: "testing", source: "file" });
	});

	test("default-channel: env wins over file", () => {
		writeSettingsFile("QUICKCHR_DEFAULT_CHANNEL=testing\n");
		process.env.QUICKCHR_DEFAULT_CHANNEL = "development";
		expect(resolveSetting("default-channel")).toEqual({ value: "development", source: "env" });
	});

	test("default-arch: default is auto, file/env override", () => {
		expect(resolveSetting("default-arch")).toEqual({ value: "auto", source: "default" });
		writeSettingsFile("QUICKCHR_DEFAULT_ARCH=x86\n");
		expect(resolveSetting("default-arch")).toEqual({ value: "x86", source: "file" });
		process.env.QUICKCHR_DEFAULT_ARCH = "arm64";
		expect(resolveSetting("default-arch")).toEqual({ value: "arm64", source: "env" });
	});

	test("cache-max-size: built-in default matches DEFAULT_CACHE_MAX_BYTES (2 GiB), file/env override it", () => {
		expect(resolveSetting("cache-max-size")).toEqual({ value: 2 * 1024 ** 3, source: "default" });
		writeSettingsFile("QUICKCHR_CACHE_MAX_SIZE=3G\n");
		expect(resolveSetting("cache-max-size")).toEqual({ value: 3 * 1024 ** 3, source: "file" });
	});

	test("timeout-extra: built-in default is 0 seconds, file/env override it", () => {
		expect(resolveSetting("timeout-extra")).toEqual({ value: 0, source: "default" });
		writeSettingsFile("QUICKCHR_TIMEOUT_EXTRA=45\n");
		expect(resolveSetting("timeout-extra")).toEqual({ value: 45, source: "file" });
	});

	test("secure-login: no built-in default (undefined) — the wizard needs to distinguish unset from explicitly-false", () => {
		expect(resolveSetting("secure-login")).toEqual({ value: undefined, source: "default" });
		writeSettingsFile("QUICKCHR_SECURE_LOGIN=false\n");
		expect(resolveSetting("secure-login")).toEqual({ value: false, source: "file" });
	});

	test("secure-login: boolean parsing, canonical write form", () => {
		writeSettingsFile("QUICKCHR_SECURE_LOGIN=yes\n");
		expect(resolveSetting("secure-login")).toEqual({ value: true, source: "file" });
	});

	test("throws INVALID_SETTING_KEY for an unrecognized attr", () => {
		expect(() => resolveSetting("bogus-key")).toThrow(QuickCHRError);
		try {
			resolveSetting("bogus-key");
			throw new Error("should have thrown");
		} catch (e) {
			expect((e as QuickCHRError).code).toBe("INVALID_SETTING_KEY");
		}
	});
});

describe("full 4-tier composition (flag > env > file > default) — the CLI's own pattern", () => {
	function resolveChannel(flagValue: string | undefined): string | undefined {
		return flagValue ?? (resolveSetting("default-channel").value as string | undefined);
	}

	test("flag wins over env and file", () => {
		writeSettingsFile("QUICKCHR_DEFAULT_CHANNEL=testing\n");
		process.env.QUICKCHR_DEFAULT_CHANNEL = "development";
		expect(resolveChannel("long-term")).toBe("long-term");
	});

	test("env wins over file when flag absent", () => {
		writeSettingsFile("QUICKCHR_DEFAULT_CHANNEL=testing\n");
		process.env.QUICKCHR_DEFAULT_CHANNEL = "development";
		expect(resolveChannel(undefined)).toBe("development");
	});

	test("file wins over built-in default when flag and env absent", () => {
		writeSettingsFile("QUICKCHR_DEFAULT_CHANNEL=testing\n");
		expect(resolveChannel(undefined)).toBe("testing");
	});

	test("built-in default when nothing set", () => {
		expect(resolveChannel(undefined)).toBe("stable");
	});

	function resolveArchValue(flagValue: string | undefined): string | undefined {
		return flagValue ?? (resolveSetting("default-arch").value as string | undefined);
	}

	test("default-arch: explicit --arch auto always wins over a configured file default", () => {
		writeSettingsFile("QUICKCHR_DEFAULT_ARCH=x86\n");
		expect(resolveArchValue("auto")).toBe("auto");
	});

	function resolveSecureLogin(noSecureLoginFlag: boolean, secureLoginFlag: boolean): boolean | undefined {
		if (noSecureLoginFlag) return false;
		if (secureLoginFlag) return true;
		return resolveSetting("secure-login").value === true ? true : undefined;
	}

	test("secure-login: --no-secure-login always wins", () => {
		writeSettingsFile("QUICKCHR_SECURE_LOGIN=true\n");
		expect(resolveSecureLogin(true, false)).toBe(false);
	});

	test("secure-login: --secure-login wins over an unset/false setting", () => {
		expect(resolveSecureLogin(false, true)).toBe(true);
	});

	test("secure-login: setting only consulted when neither flag passed", () => {
		expect(resolveSecureLogin(false, false)).toBeUndefined();
		writeSettingsFile("QUICKCHR_SECURE_LOGIN=true\n");
		expect(resolveSecureLogin(false, false)).toBe(true);
	});
});

describe("settingsGet / settingsSet / settingsReset round-trip", () => {
	test("settingsSet writes a line; settingsGet reads it back", () => {
		const result = settingsSet("default-channel", "testing");
		expect(result).toEqual({ key: "default-channel", previous: undefined, value: "testing" });
		expect(settingsGet("default-channel")).toEqual({ key: "default-channel", value: "testing", source: "file" });
	});

	test("settingsSet reports the previous value on overwrite", () => {
		settingsSet("default-channel", "testing");
		const result = settingsSet("default-channel", "development");
		expect(result.previous).toBe("testing");
		expect(result.value).toBe("development");
	});

	test("settingsGet throws INVALID_SETTING_KEY for an unrecognized key", () => {
		expect(() => settingsGet("not-a-real-key")).toThrow(QuickCHRError);
	});

	test("settingsSet throws INVALID_SETTING_VALUE for a bad value", () => {
		expect(() => settingsSet("default-channel", "bogus")).toThrow(QuickCHRError);
		try {
			settingsSet("default-channel", "bogus");
			throw new Error("should have thrown");
		} catch (e) {
			expect((e as QuickCHRError).code).toBe("INVALID_SETTING_VALUE");
		}
	});

	test("timeout-extra rejects negative and non-numeric values, allows explicit 0", () => {
		expect(() => settingsSet("timeout-extra", "-5")).toThrow(QuickCHRError);
		expect(() => settingsSet("timeout-extra", "abc")).toThrow(QuickCHRError);
		expect(settingsSet("timeout-extra", "0").value).toBe(0);
	});

	test("secure-login accepts multiple boolean spellings, canonical write form", () => {
		settingsSet("secure-login", "YES");
		expect(readSettingsFileRaw()).toContain("QUICKCHR_SECURE_LOGIN=true");
		settingsSet("secure-login", "0");
		expect(readSettingsFileRaw()).toContain("QUICKCHR_SECURE_LOGIN=false");
	});

	test("cache-max-size parses a size string to bytes", () => {
		const result = settingsSet("cache-max-size", "3G");
		expect(result.value).toBe(3 * 1024 ** 3);
	});

	test("settingsReset(attr) deletes the line entirely — never blanks it", () => {
		settingsSet("default-channel", "testing");
		const result = settingsReset("default-channel");
		expect(result.cleared).toEqual(["default-channel"]);
		expect(readSettingsFileRaw()).not.toContain("QUICKCHR_DEFAULT_CHANNEL");
		expect(resolveSetting("default-channel")).toEqual({ value: "stable", source: "default" });
	});

	test("settingsReset(attr) on an unset key reports nothing cleared", () => {
		expect(settingsReset("default-channel")).toEqual({ cleared: [] });
	});

	test("settingsReset() with no key clears all managed lines, preserves foreign content", () => {
		writeSettingsFile("# a comment\nQUICKCHR_DEFAULT_CHANNEL=testing\nFOO=bar\nQUICKCHR_DEFAULT_ARCH=x86\n");
		const result = settingsReset();
		expect(result.cleared.sort()).toEqual(["default-arch", "default-channel"]);
		const raw = readSettingsFileRaw();
		expect(raw).toContain("# a comment");
		expect(raw).toContain("FOO=bar");
		expect(raw).not.toContain("QUICKCHR_DEFAULT_CHANNEL");
		expect(raw).not.toContain("QUICKCHR_DEFAULT_ARCH");
	});

	test("settingsSet preserves foreign lines, comments, and blank lines byte-for-byte", () => {
		writeSettingsFile("# a comment\n\nFOO=bar\nQUICKCHR_DEFAULT_CHANNEL=testing\n");
		settingsSet("default-arch", "x86");
		const raw = readSettingsFileRaw();
		expect(raw).toContain("# a comment");
		expect(raw).toContain("FOO=bar");
		expect(raw).toContain("QUICKCHR_DEFAULT_CHANNEL=testing");
		expect(raw).toContain("QUICKCHR_DEFAULT_ARCH=x86");
	});

	test("settingsSet updates the effective duplicate line and self-heals older duplicates", () => {
		writeSettingsFile("QUICKCHR_DEFAULT_CHANNEL=testing\nFOO=bar\nQUICKCHR_DEFAULT_CHANNEL=development\n");
		expect(resolveSetting("default-channel")).toEqual({ value: "development", source: "file" });

		const result = settingsSet("default-channel", "long-term");

		expect(result.previous).toBe("development");
		expect(result.value).toBe("long-term");
		expect(resolveSetting("default-channel")).toEqual({ value: "long-term", source: "file" });
		const raw = readSettingsFileRaw();
		expect(raw.match(/^QUICKCHR_DEFAULT_CHANNEL=/gm)?.length).toBe(1);
		expect(raw).toContain("QUICKCHR_DEFAULT_CHANNEL=long-term");
		expect(raw).toContain("FOO=bar");
	});

	test("settingsReset(attr) removes every duplicate line for that managed key", () => {
		writeSettingsFile("QUICKCHR_DEFAULT_CHANNEL=testing\nFOO=bar\nQUICKCHR_DEFAULT_CHANNEL=development\n");

		const result = settingsReset("default-channel");

		expect(result.cleared).toEqual(["default-channel"]);
		const raw = readSettingsFileRaw();
		expect(raw).not.toContain("QUICKCHR_DEFAULT_CHANNEL");
		expect(raw).toContain("FOO=bar");
		expect(resolveSetting("default-channel")).toEqual({ value: "stable", source: "default" });
	});
});

describe("settingsPrint tolerance", () => {
	test("reports all 5 keys even with a corrupted value in one", () => {
		writeSettingsFile("QUICKCHR_TIMEOUT_EXTRA=not-a-number\n");
		const entries = settingsPrint();
		expect(entries.length).toBe(5);
		const timeoutEntry = entries.find((e) => e.key === "timeout-extra");
		expect(timeoutEntry?.value).toBe("not-a-number");
		expect(timeoutEntry?.source).toBe("file");
	});
});

describe("regression: settings never mutate machine.json", () => {
	function makeMachine(name: string): MachineState {
		return {
			name,
			version: "7.22.1",
			arch: "x86",
			cpu: 1,
			mem: 512,
			networks: [{ specifier: "user", id: "net0" }],
			ports: {},
			packages: [],
			portBase: 9100,
			excludePorts: [],
			extraPorts: [],
			createdAt: "2026-01-01T00:00:00.000Z",
			status: "stopped",
			machineDir: join(process.env.QUICKCHR_DATA_DIR ?? "", "machines", name),
		};
	}

	test("machine.json is byte-for-byte unchanged after exercising every settings function", () => {
		const machine = makeMachine("regression-test-vm");
		saveMachine(machine);
		const machinePath = join(machine.machineDir, "machine.json");
		const before = readFileSync(machinePath, "utf-8");

		settingsSet("default-channel", "testing");
		settingsSet("default-arch", "x86");
		settingsSet("cache-max-size", "1G");
		resolveSetting("timeout-extra");
		settingsPrint();
		settingsGet("default-channel");
		settingsReset("default-channel");
		settingsReset();

		const after = readFileSync(machinePath, "utf-8");
		expect(after).toBe(before);
		expect(loadMachine("regression-test-vm")).toEqual(machine);
		expect(existsSync(machinePath)).toBe(true);
	});
});
