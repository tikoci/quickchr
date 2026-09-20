// cspell:ignore hlep netwrok nosuchmachine
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { ADD_FLAGS, START_FLAGS, suggestFlag, unknownFlags } from "../../src/cli/flags.ts";

const TEST_DIR = join(import.meta.dir, ".tmp-cli-help-guard");
const CLI = join(import.meta.dir, "../../src/cli/index.ts");

async function runQuickchr(args: string[], env: Record<string, string> = {}) {
	const proc = Bun.spawn(["bun", CLI, ...args], {
		env: {
			...process.env,
			QUICKCHR_DATA_DIR: TEST_DIR,
			NO_COLOR: "1",
			QUICKCHR_NO_PROMPT: "1",
			...env,
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

/** Everything the data dir holds, relative to it — the assertion that a command
 *  touched no state has to look at the whole tree, not just machines/. */
function dataDirContents(): string[] {
	if (!existsSync(TEST_DIR)) return [];
	const out: string[] = [];
	const walk = (dir: string, prefix: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			out.push(rel);
			if (entry.isDirectory()) walk(join(dir, entry.name), rel);
		}
	};
	walk(TEST_DIR, "");
	return out.sort();
}

beforeEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("--help is handled before any side effect (#156)", () => {
	// The reported symptom was `add --help` printing nothing and hanging while it
	// downloaded 43 MB, so "prints help" and "touches no state" are both asserted.
	test("add --help prints add's help and creates nothing", async () => {
		const result = await runQuickchr(["add", "--help"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("quickchr add [options]");
		expect(result.stdout).toContain("--name <name>");
		expect(dataDirContents()).toEqual([]);
	});

	test("networks sockets create --help prints help and registers no socket", async () => {
		const result = await runQuickchr(["networks", "sockets", "create", "--help"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("quickchr networks");
		expect(dataDirContents()).toEqual([]);
	});

	test("-h works the same as --help", async () => {
		const result = await runQuickchr(["add", "-h"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("quickchr add [options]");
		expect(dataDirContents()).toEqual([]);
	});

	test("--help in any position is still help", async () => {
		const result = await runQuickchr(["add", "--name", "lab", "--help"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("quickchr add [options]");
		expect(dataDirContents()).toEqual([]);
	});

	test("every dispatched command answers --help without an error", async () => {
		// The guard lives in the dispatcher so a new subcommand cannot miss it; this
		// pins that for the commands that exist today.
		const commands = [
			"add", "start", "stop", "list", "remove", "clean", "console", "exec", "qga",
			"get", "set", "inspect", "env", "disk", "snapshot", "doctor", "logs",
			"completions", "networks", "cache", "settings", "version",
		];
		for (const cmd of commands) {
			const result = await runQuickchr([cmd, "--help"]);
			expect({ cmd, exitCode: result.exitCode }).toEqual({ cmd, exitCode: 0 });
			expect({ cmd, help: result.stdout.trim().length > 0 }).toEqual({ cmd, help: true });
			expect({ cmd, detailed: result.stdout.includes("No detailed help") }).toEqual({ cmd, detailed: false });
		}
		expect(dataDirContents()).toEqual([]);
	});

	test("a payload after -- is not scanned for --help", async () => {
		// `exec`'s RouterOS command is the user's, not quickchr's, to interpret.
		const result = await runQuickchr(["exec", "--", "nosuchmachine", "--help"]);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).not.toContain("quickchr exec <name>");
		expect(result.stderr).toContain("not found");
	});
});

describe("unknown flags on machine-creating commands (#156)", () => {
	test("add rejects an unknown flag instead of creating a machine", async () => {
		const result = await runQuickchr(["add", "--hlep"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("unknown flag for 'quickchr add'");
		expect(result.stderr).toContain("--hlep");
		expect(dataDirContents()).toEqual([]);
	});

	test("a near-miss gets a suggestion", async () => {
		const result = await runQuickchr(["add", "--add-netwrok", "user"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("did you mean --add-network?");
		expect(dataDirContents()).toEqual([]);
	});

	test("start rejects an unknown flag before touching the machine", async () => {
		const result = await runQuickchr(["start", "--drug-run"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("unknown flag for 'quickchr start'");
		expect(dataDirContents()).toEqual([]);
	});

	test("a known flag given without its value is an error, not an auto-named machine", async () => {
		// parseFlags stores `true` when a flag is followed by another flag, and flag()
		// turns that back into undefined — so this used to reach add() with no name and
		// create an auto-named machine, which is the exact hazard this command guards.
		const result = await runQuickchr(["add", "--name", "--version", "7.24.3"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("missing a value");
		expect(result.stderr).toContain("--name <value>");
		expect(dataDirContents()).toEqual([]);
	});

	test("--no-x negation is not mistaken for a missing value", async () => {
		const result = await runQuickchr(["start", "--dry-run", "--version", "7.24.3", "--no-device-mode", "--no-winbox"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Dry run");
	});

	test("every flag in the command's own help is accepted", async () => {
		// The registry and the help text are two hand-maintained lists of the same
		// thing; this is the check that keeps them from drifting apart.
		for (const [command, known] of [["add", ADD_FLAGS], ["start", START_FLAGS]] as const) {
			const help = await runQuickchr([command, "--help"]);
			const documented = new Set(
				[...help.stdout.matchAll(/--([a-z][a-z0-9-]*)/g)].map((m) => m[1] as string),
			);
			for (const raw of documented) {
				// `--no-x` documents the negation of `x`, which is the name parseFlags reports.
				const name = raw.startsWith("no-") ? raw.slice(3) : raw;
				if (name === "help") continue;
				expect({ command, flag: name, known: known.includes(name) })
					.toEqual({ command, flag: name, known: true });
			}
		}
	});

	test("unknownFlags/suggestFlag only suggest a close match", () => {
		expect(unknownFlags({ name: "x", cpu: "2" }, ADD_FLAGS)).toEqual([]);
		expect(suggestFlag("add-netwrok", ADD_FLAGS)).toBe("add-network");
		expect(suggestFlag("completely-different-thing", ADD_FLAGS)).toBeUndefined();
	});
});
