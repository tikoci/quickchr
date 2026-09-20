import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { assertValidResourceName, isValidResourceName } from "../../src/lib/names.ts";
import { _resetSocketCache, createNamedSocket } from "../../src/lib/socket-registry.ts";
import { parseNetworkSpecifier } from "../../src/lib/network.ts";

const TEST_DIR = join(import.meta.dir, ".tmp-resource-names");
const CLI = join(import.meta.dir, "../../src/cli/index.ts");

async function runQuickchr(args: string[]) {
	const proc = Bun.spawn(["bun", CLI, ...args], {
		env: { ...process.env, QUICKCHR_DATA_DIR: TEST_DIR, NO_COLOR: "1", QUICKCHR_NO_PROMPT: "1" },
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
	process.env.QUICKCHR_DATA_DIR = TEST_DIR;
	_resetSocketCache();
});

afterEach(() => {
	_resetSocketCache();
	rmSync(TEST_DIR, { recursive: true, force: true });
	process.env.QUICKCHR_DATA_DIR = undefined;
});

describe("resource name rules", () => {
	test("accepts the names quickchr generates for itself", () => {
		for (const name of ["7.24.4-x86-1", "lab", "chr_01", "a"]) {
			expect({ name, ok: isValidResourceName(name) }).toEqual({ name, ok: true });
		}
	});

	test("rejects names that read as a flag", () => {
		expect(() => assertValidResourceName("--help", "named socket")).toThrow(/cannot start with/);
		expect(() => assertValidResourceName("-x", "machine")).toThrow(/cannot start with/);
	});

	test("rejects names that would escape the data dir", () => {
		// Both become a path segment: machines/<name>/ and networks/<name>.json.
		for (const name of ["..", "../evil", "a/b", "a\\b"]) {
			expect({ name, ok: isValidResourceName(name) }).toEqual({ name, ok: false });
		}
	});

	test("rejects shell-significant characters and overlong names", () => {
		for (const name of ["a b", "a;b", "a$b", "a".repeat(65)]) {
			expect({ name, ok: isValidResourceName(name) }).toEqual({ name, ok: false });
		}
	});
});

describe("named sockets validate their name (#156)", () => {
	test("createNamedSocket refuses a flag-shaped name before writing anything", () => {
		expect(() => createNamedSocket("--help")).toThrow(/cannot start with/);
		expect(existsSync(join(TEST_DIR, "networks", "--help.json"))).toBe(false);
	});

	test("the socket:: specifier validates too — it is the other door into the registry", () => {
		expect(() => parseNetworkSpecifier("socket::../escape")).toThrow(/Invalid named socket name/);
		expect(parseNetworkSpecifier("socket::lab")).toEqual({ type: "socket", name: "lab" });
	});

	test("CLI: sockets create --help does not burn the default start port", async () => {
		const help = await runQuickchr(["networks", "sockets", "create", "--help"]);
		expect(help.exitCode).toBe(0);

		// Created with an explicit port-using transport, because since #158 the default
		// is `dgram`, which carries no port at all — the symptom this test was written
		// against only exists where a port is allocated.
		const created = await runQuickchr(["networks", "sockets", "create", "lab", "--mode", "mcast"]);
		expect(created.exitCode).toBe(0);
		// 4000 is DEFAULT_START_PORT — a socket named "--help" used to take it first.
		const entry = JSON.parse(readFileSync(join(TEST_DIR, "networks", "lab.json"), "utf-8"));
		expect(entry.port).toBe(4000);
		expect(readdirSync(join(TEST_DIR, "networks")).sort()).toEqual(["lab.json"]);
	});

	test("CLI: a traversal name cannot delete a file outside networks/", async () => {
		// `networks sockets remove ../victim` used to delete <dataDir>/victim.json, and a
		// longer prefix reached outside the data dir entirely. socketPath() is the single
		// place a name becomes a path, so the guard lives there.
		writeFileSync(join(TEST_DIR, "victim.json"), "victim");
		mkdirSync(join(TEST_DIR, "networks"), { recursive: true });

		for (const name of ["../victim", "..", "a/b"]) {
			const result = await runQuickchr(["networks", "sockets", "remove", name]);
			expect({ name, exitCode: result.exitCode }).toEqual({ name, exitCode: 1 });
			expect(result.stderr).toContain("INVALID_NAME");
		}
		expect(existsSync(join(TEST_DIR, "victim.json"))).toBe(true);

		// A legitimate name still round-trips.
		expect((await runQuickchr(["networks", "sockets", "create", "lab"])).exitCode).toBe(0);
		expect((await runQuickchr(["networks", "sockets", "remove", "lab"])).exitCode).toBe(0);
	});

	test("CLI: an explicit flag-shaped socket name is rejected", async () => {
		// handleSockets takes the name positionally, so this is the raw name it sees.
		const result = await runQuickchr(["networks", "sockets", "create", "-bad"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Invalid named socket name");
		expect(existsSync(join(TEST_DIR, "networks", "-bad.json"))).toBe(false);
	});
});
