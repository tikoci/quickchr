/**
 * Windows-only unit tests for path resolution and platform detection.
 * Skipped automatically on macOS and Linux.
 *
 * Tests cover:
 * - getDataDir() reading LOCALAPPDATA / USERPROFILE fallback / QUICKCHR_DATA_DIR override
 * - getMachinesDir() / getCacheDir() derived paths
 * - findCommandOnPath() resolves through PATHEXT, as where.exe does
 * - detectPackageManager() returns "winget"
 */
import { describe, test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { getDataDir, getMachinesDir, getCacheDir } from "../../src/lib/state.ts";
import { detectPackageManager, findCommandOnPath } from "../../src/lib/platform.ts";

const isWindows = process.platform === "win32";

describe.skipIf(!isWindows)("Windows path resolution — getDataDir", () => {
	const saved = {
		QUICKCHR_DATA_DIR: process.env.QUICKCHR_DATA_DIR,
		LOCALAPPDATA: process.env.LOCALAPPDATA,
		USERPROFILE: process.env.USERPROFILE,
	};

	afterEach(() => {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});

	test("QUICKCHR_DATA_DIR override takes highest priority", () => {
		process.env.QUICKCHR_DATA_DIR = "C:\\custom\\quickchr";
		expect(getDataDir()).toBe("C:\\custom\\quickchr");
	});

	test("reads LOCALAPPDATA when QUICKCHR_DATA_DIR is not set", () => {
		delete process.env.QUICKCHR_DATA_DIR;
		process.env.LOCALAPPDATA = "C:\\Users\\test\\AppData\\Local";
		expect(getDataDir()).toBe("C:\\Users\\test\\AppData\\Local\\quickchr");
	});

	test("falls back to USERPROFILE\\AppData\\Local when LOCALAPPDATA is absent", () => {
		delete process.env.QUICKCHR_DATA_DIR;
		delete process.env.LOCALAPPDATA;
		process.env.USERPROFILE = "C:\\Users\\test";
		expect(getDataDir()).toBe(join("C:\\Users\\test", "AppData", "Local", "quickchr"));
	});

	test("getMachinesDir() appends 'machines' to dataDir", () => {
		process.env.QUICKCHR_DATA_DIR = "C:\\custom\\quickchr";
		expect(getMachinesDir()).toBe("C:\\custom\\quickchr\\machines");
	});

	test("getCacheDir() appends 'cache' to dataDir", () => {
		process.env.QUICKCHR_DATA_DIR = "C:\\custom\\quickchr";
		expect(getCacheDir()).toBe("C:\\custom\\quickchr\\cache");
	});
});

describe.skipIf(!isWindows)("Windows platform detection", () => {
	test("detectPackageManager returns 'winget'", () => {
		expect(detectPackageManager()).toBe("winget");
	});

	test("findCommandOnPath resolves cmd (via PATHEXT) to a string", () => {
		// cmd.exe is always present on Windows — use it as a known-present command.
		const result = findCommandOnPath("cmd");
		expect(typeof result).toBe("string");
		expect(result?.length).toBeGreaterThan(0);
	});

	test("findCommandOnPath agrees with where.exe's first result", () => {
		// The in-process resolver (#269) replaced a where.exe spawn; check it still
		// picks what where.exe picks on a real runner, for a system command and two
		// the runner puts on PATH.
		for (const cmd of ["cmd", "bun", "git"]) {
			const where = Bun.spawnSync(["where.exe", cmd], { stdout: "pipe", stderr: "pipe" });
			const first = new TextDecoder().decode(where.stdout).split(/\r?\n/).map((l) => l.trim()).find(Boolean);
			expect(findCommandOnPath(cmd)?.toLowerCase()).toBe(where.exitCode === 0 ? first?.toLowerCase() : undefined);
		}
	});

	test("findCommandOnPath returns undefined for a non-existent command", () => {
		expect(findCommandOnPath("__no_such_command_quickchr__")).toBeUndefined();
	});
});

