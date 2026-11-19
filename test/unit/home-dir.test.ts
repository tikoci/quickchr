/**
 * One home-directory rule for the data dir, the config dir and the completion
 * paths, none of which may resolve relative to the working directory (#276).
 *
 * The HOME cases run in child processes: Bun reads HOME for `os.homedir()` at
 * startup, so deleting it in this process would only test the cached value.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { getDataDir } from "../../src/lib/state.ts";
import { isFullyQualifiedPath } from "../../src/lib/paths.ts";
import { QuickCHRError } from "../../src/lib/types.ts";

const SRC = join(import.meta.dir, "..", "..", "src", "lib");
const PROBE = `
const { getDataDir } = await import(${JSON.stringify(join(SRC, "state.ts"))});
const { quickchrConfigDir } = await import(${JSON.stringify(join(SRC, "paths.ts"))});
const { completionInstallPath } = await import(${JSON.stringify(join(SRC, "completions.ts"))});
try {
	console.log(JSON.stringify({ data: getDataDir(), config: quickchrConfigDir(), completion: completionInstallPath("zsh").file }));
} catch (e) {
	console.log(JSON.stringify({ code: e.code }));
}
`;

type ProbeResult = { data?: string; config?: string; completion?: string; code?: string };

function probe(home: string | undefined, cwd: string): ProbeResult {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v !== undefined && !["HOME", "USERPROFILE", "QUICKCHR_DATA_DIR"].includes(k)) env[k] = v;
	}
	if (home !== undefined) env.HOME = home;
	const proc = Bun.spawnSync([process.execPath, "--no-env-file", "-e", PROBE], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const out = proc.stdout.toString().trim().split("\n").pop() ?? "";
	if (!out) throw new Error(`probe printed nothing: ${proc.stderr.toString()}`);
	return JSON.parse(out) as ProbeResult;
}

describe.skipIf(process.platform === "win32")("home dir rule (#276)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	for (const [label, home] of [["unset", undefined], ["empty", ""], ["relative", "work-home"]] as const) {
		test(`HOME ${label}: never relative, never cwd-dependent, data and config agree`, () => {
			const a = mkdtempSync(join(tmpdir(), "qchr-home-a-"));
			const b = mkdtempSync(join(tmpdir(), "qchr-home-b-"));
			dirs.push(a, b);
			const fromA = probe(home, a);
			const fromB = probe(home, b);
			expect(fromA).toEqual(fromB);
			if (fromA.code !== undefined) {
				// No absolute home anywhere (Bun echoes a relative HOME from homedir()
				// and userInfo()): refused, never resolved against the cwd.
				expect(fromA.code).toBe("STATE_ERROR");
				return;
			}
			const data = fromA.data ?? "";
			const config = fromA.config ?? "";
			expect(isAbsolute(data)).toBe(true);
			expect(isAbsolute(fromA.completion ?? "")).toBe(true);
			const homeDir = data.slice(0, -"/.local/share/quickchr".length);
			expect(data).toBe(join(homeDir, ".local", "share", "quickchr"));
			expect(config).toBe(join(homeDir, ".config", "quickchr"));
		});
	}

	test("HOME unset resolves to an absolute home (the OS account's)", () => {
		const a = mkdtempSync(join(tmpdir(), "qchr-home-a-"));
		dirs.push(a);
		const result = probe(undefined, a);
		expect(result.code).toBeUndefined();
		expect(isAbsolute(result.data ?? "")).toBe(true);
	});

	test("an absolute HOME wins", () => {
		const a = mkdtempSync(join(tmpdir(), "qchr-home-a-"));
		dirs.push(a);
		const result = probe("/tmp/quickchr-home-test", a);
		expect(result.data).toBe("/tmp/quickchr-home-test/.local/share/quickchr");
		expect(result.config).toBe("/tmp/quickchr-home-test/.config/quickchr");
	});
});

describe("QUICKCHR_DATA_DIR must be fully qualified (#276)", () => {
	const saved = process.env.QUICKCHR_DATA_DIR;
	afterEach(() => {
		if (saved === undefined) delete process.env.QUICKCHR_DATA_DIR;
		else process.env.QUICKCHR_DATA_DIR = saved;
	});

	test("a relative value is a STATE_ERROR naming the variable", () => {
		process.env.QUICKCHR_DATA_DIR = "rel/quickchr";
		let err: unknown;
		try {
			getDataDir();
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(QuickCHRError);
		expect((err as QuickCHRError).code).toBe("STATE_ERROR");
		expect((err as QuickCHRError).message).toContain("QUICKCHR_DATA_DIR");
	});

	test("an absolute value is used as given", () => {
		const dir = join(tmpdir(), "quickchr-data-test");
		process.env.QUICKCHR_DATA_DIR = dir;
		expect(getDataDir()).toBe(dir);
	});
});

describe("isFullyQualifiedPath on Windows (#276)", () => {
	test("drive-qualified and UNC paths qualify", () => {
		expect(isFullyQualifiedPath("C:\\Users\\me", "win32")).toBe(true);
		expect(isFullyQualifiedPath("d:/data", "win32")).toBe(true);
		expect(isFullyQualifiedPath("\\\\server\\share\\q", "win32")).toBe(true);
	});

	test("drive-relative and relative paths do not", () => {
		expect(isFullyQualifiedPath("\\quickchr-data", "win32")).toBe(false);
		expect(isFullyQualifiedPath("/quickchr-data", "win32")).toBe(false);
		expect(isFullyQualifiedPath("C:quickchr", "win32")).toBe(false);
		// A UNC root needs a share as well as a server.
		expect(isFullyQualifiedPath("//server", "win32")).toBe(false);
		expect(isFullyQualifiedPath("\\\\server\\", "win32")).toBe(false);
		expect(isFullyQualifiedPath("//server/share", "win32")).toBe(true);
		expect(isFullyQualifiedPath("quickchr", "win32")).toBe(false);
	});

	test("POSIX keeps isAbsolute", () => {
		expect(isFullyQualifiedPath("/home/me", "linux")).toBe(true);
		expect(isFullyQualifiedPath("home/me", "linux")).toBe(false);
	});
});
