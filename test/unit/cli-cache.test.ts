import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = join(import.meta.dir, ".tmp-cli-cache-test");
const CLI = join(import.meta.dir, "../../src/cli/index.ts");

async function runQuickchr(args: string[]) {
	const proc = Bun.spawn(["bun", CLI, ...args], {
		env: {
			...process.env,
			QUICKCHR_DATA_DIR: TEST_DIR,
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

beforeEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(join(TEST_DIR, "cache"), { recursive: true });
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("CLI cache key", () => {
	test("pinned JSON output contains the actual cache dir and needs no network", async () => {
		const result = await runQuickchr(["cache", "key", "--version", "7.24.4", "--arch", "x86", "--json"]);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout)).toEqual({
			dir: join(TEST_DIR, "cache"),
			version: "7.24.4",
			arch: "x86",
		});
	});

	test("human output can be appended directly to GITHUB_OUTPUT", async () => {
		const result = await runQuickchr(["cache", "key", "--version", "7.24.4", "--arch", "x86"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim().split("\n")).toEqual([
			`dir=${join(TEST_DIR, "cache")}`,
			"version=7.24.4",
			"arch=x86",
		]);
	});
});

describe("CLI cache add", () => {
	test("an existing pinned image is an idempotent JSON cache hit", async () => {
		const path = join(TEST_DIR, "cache", "chr-7.24.4.img");
		writeFileSync(path, "cached image");
		const result = await runQuickchr(["cache", "add", "--version", "7.24.4", "--arch", "x86", "--json"]);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout)).toEqual({
			dir: join(TEST_DIR, "cache"),
			version: "7.24.4",
			arch: "x86",
			path,
			cacheHit: true,
		});
	});
});
