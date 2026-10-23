import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { cmdStart } from "../../src/cli/index.ts";
import { QuickCHR } from "../../src/lib/quickchr.ts";
import type { ChrInstance, MachineState, StartOptions } from "../../src/lib/types.ts";

/**
 * Single-target `start` says when this call created the machine (#194): a typo or a
 * removed name boots a factory CHR, and the status line is the only place that shows
 * it. No QEMU — `get` and `start` are replaced at the class boundary, as in
 * cli-start-all-secure-login.test.ts.
 */

const TMP = join(import.meta.dir, ".tmp-cli-start-created");
const saved = {
	home: process.env.HOME,
	dataDir: process.env.QUICKCHR_DATA_DIR,
	noColor: process.env.NO_COLOR,
	noTips: process.env.QUICKCHR_NO_TIPS,
};

function machine(name: string, booted: boolean): MachineState {
	return {
		name,
		version: "7.24.5",
		arch: "x86",
		status: "stopped",
		...(booted ? { lastStartedAt: "2026-10-21T00:00:00.000Z" } : {}),
	} as MachineState;
}

function fakeInstance(name: string): ChrInstance {
	return {
		name,
		state: { name, version: "7.24.5", arch: "x86", ports: { http: { host: 9100, guest: 80 } }, networks: [] },
		ports: { http: 9100, api: 9103, winbox: 9105 },
		sshPort: 9102,
	} as unknown as ChrInstance;
}

let calls: StartOptions[];
let lines: string[];

function existing(state: MachineState | null) {
	spyOn(QuickCHR, "get").mockImplementation((name: string) =>
		state && state.name === name ? ({ name, state } as unknown as ChrInstance) : null,
	);
}

async function statusLine(argv: string[]): Promise<string | undefined> {
	await cmdStart(argv);
	return lines.find((line) => line.startsWith("● "));
}

beforeEach(() => {
	rmSync(TMP, { recursive: true, force: true });
	process.env.HOME = join(TMP, "home");
	process.env.QUICKCHR_DATA_DIR = join(TMP, "data");
	process.env.NO_COLOR = "1";
	process.env.QUICKCHR_NO_TIPS = "1";
	calls = [];
	lines = [];
	spyOn(QuickCHR, "start").mockImplementation(async (opts: StartOptions = {}) => {
		calls.push(opts);
		return fakeInstance(opts.name ?? "7.24.5-x86-1");
	});
	spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		lines.push(args.map(String).join(" "));
	});
	spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	mock.restore();
	rmSync(TMP, { recursive: true, force: true });
	for (const [key, value] of [
		["HOME", saved.home],
		["QUICKCHR_DATA_DIR", saved.dataDir],
		["NO_COLOR", saved.noColor],
		["QUICKCHR_NO_TIPS", saved.noTips],
	] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("single-target start names a machine it created (#194)", () => {
	test("a name no machine has: created and started", async () => {
		existing(null);
		expect(await statusLine(["lab", "--version", "7.24.5", "--arch", "x86"])).toBe("● lab created and started");
		expect(calls.map((c) => c.name)).toEqual(["lab"]);
	});

	test("a name no machine has, with --no-wait: created — not waiting", async () => {
		existing(null);
		expect(await statusLine(["lab", "--version", "7.24.5", "--arch", "x86", "--no-wait"])).toBe(
			"● lab created — not waiting for RouterOS (--no-wait)",
		);
	});

	test("no name at all: the generated machine is reported as created", async () => {
		existing(null);
		expect(await statusLine(["--version", "7.24.5", "--arch", "x86"])).toBe("● 7.24.5-x86-1 created and started");
	});

	test("a machine that was added and never booted (add → start): started", async () => {
		existing(machine("lab", false));
		expect(await statusLine(["lab"])).toBe("● lab started");
	});

	test("a machine that has booted before: started, or launched with --no-wait", async () => {
		existing(machine("lab", true));
		expect(await statusLine(["lab"])).toBe("● lab started");
		lines = [];
		expect(await statusLine(["lab", "--no-wait"])).toBe("● lab launched — not waiting for RouterOS (--no-wait)");
	});
});
