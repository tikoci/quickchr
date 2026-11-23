import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { cmdAdd, cmdStart } from "../../src/cli/index.ts";
import { QuickCHR } from "../../src/lib/quickchr.ts";
import type { ChrInstance, MachineState, StartOptions } from "../../src/lib/types.ts";

/**
 * `--no-identity` reaches the library as `identity: false` from `add` and from a
 * single-target `start`; absent, it reaches it as `undefined`, so stored intent can
 * fall through (#265). `start --all` is pinned in cli-start-all-secure-login.test.ts.
 * No QEMU: `add`, `get` and `start` are replaced at the class boundary.
 */

const TMP = join(import.meta.dir, ".tmp-cli-identity-flag");
const saved = { home: process.env.HOME, dataDir: process.env.QUICKCHR_DATA_DIR };

const STATE = {
	name: "lab",
	version: "7.24.5",
	arch: "x86",
	cpu: 1,
	mem: 512,
	networks: [],
	ports: {},
	packages: [],
	machineDir: join(TMP, "data", "machines", "lab"),
	status: "running",
} as unknown as MachineState;

let calls: StartOptions[];

beforeEach(() => {
	rmSync(TMP, { recursive: true, force: true });
	process.env.HOME = join(TMP, "home");
	process.env.QUICKCHR_DATA_DIR = join(TMP, "data");
	calls = [];
	spyOn(QuickCHR, "get").mockReturnValue(null);
	spyOn(QuickCHR, "add").mockImplementation(async (opts: StartOptions = {}) => {
		calls.push(opts);
		return { ...STATE, status: "stopped" } as MachineState;
	});
	spyOn(QuickCHR, "start").mockImplementation(async (opts: StartOptions = {}) => {
		calls.push(opts);
		return { name: "lab", state: STATE, ports: { http: 9100, api: 9108, winbox: 9105 }, sshPort: 9102 } as unknown as ChrInstance;
	});
	spyOn(console, "log").mockImplementation(() => {});
	spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	mock.restore();
	rmSync(TMP, { recursive: true, force: true });
	for (const [key, value] of [["HOME", saved.home], ["QUICKCHR_DATA_DIR", saved.dataDir]] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("--no-identity reaches the library (#265)", () => {
	test("add forwards identity: false, and nothing when the flag is absent", async () => {
		await cmdAdd(["lab", "--version", "7.24.5", "--no-identity"]);
		await cmdAdd(["lab", "--version", "7.24.5"]);
		expect(calls.map((c) => c.identity)).toEqual([false, undefined]);
	});

	test("a single-target start forwards identity: false, and nothing when the flag is absent", async () => {
		await cmdStart(["lab", "--version", "7.24.5", "--no-identity"]);
		await cmdStart(["lab", "--version", "7.24.5"]);
		expect(calls.map((c) => [c.name, c.identity])).toEqual([["lab", false], ["lab", undefined]]);
	});
});
