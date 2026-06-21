import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CHANNELS } from "../../src/lib/types.ts";
import { isValidVersion } from "../../src/lib/versions.ts";

const TEST_DIR = join(import.meta.dir, ".tmp-cli-version-doctor-test");
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

describe("CLI version --json", () => {
	// Network-tolerant: offline emits {}, online emits a { channel: version } map.
	// Either way the contract is "a plain object of channel→valid-version".
	test("emits a { channel: version } object with no human noise", async () => {
		const result = await runQuickchr(["version", "--json"]);

		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.stdout);
		expect(typeof parsed).toBe("object");
		expect(Array.isArray(parsed)).toBe(false);
		// The quickchr-version banner line must not leak into --json output.
		expect(result.stdout).not.toContain("quickchr ");
		for (const [channel, version] of Object.entries(parsed)) {
			expect(CHANNELS as readonly string[]).toContain(channel);
			expect(isValidVersion(version as string)).toBe(true);
		}
	});
});

describe("CLI doctor --json", () => {
	// Empty data dir → no cache → staleImages resolves to [] without a network call.
	test("emits { ok, checks, staleImages } and exit reflects ok", async () => {
		const result = await runQuickchr(["doctor", "--json"]);

		const parsed = JSON.parse(result.stdout);
		expect(typeof parsed.ok).toBe("boolean");
		expect(Array.isArray(parsed.checks)).toBe(true);
		expect(Array.isArray(parsed.staleImages)).toBe(true);
		for (const check of parsed.checks) {
			expect(typeof check.label).toBe("string");
			expect(["ok", "warn", "error"]).toContain(check.status);
			expect(typeof check.detail).toBe("string");
		}
		expect(result.exitCode).toBe(parsed.ok ? 0 : 1);
	});
});
