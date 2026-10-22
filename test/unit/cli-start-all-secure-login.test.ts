import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { cmdStart } from "../../src/cli/index.ts";
import { QuickCHR } from "../../src/lib/quickchr.ts";
import { QuickCHRError, type ChrInstance, type MachineState, type StartOptions } from "../../src/lib/types.ts";

/**
 * `start --all` resolves `--secure-login` per machine (#193 F9). The resolution
 * helpers are pinned in cli-start-flag-resolution.test.ts; this pins the loop: what
 * each machine's `QuickCHR.start()` call actually receives, and that a refusal stops
 * the batch after the machines before it have started. No QEMU — `list` and `start`
 * are replaced at the class boundary.
 */

const TMP = join(import.meta.dir, ".tmp-cli-start-all-secure-login");
const saved = {
	home: process.env.HOME,
	dataDir: process.env.QUICKCHR_DATA_DIR,
	secureLogin: process.env.QUICKCHR_SECURE_LOGIN,
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

const MACHINES = [machine("a-fresh", false), machine("b-booted", true), machine("c-fresh", false)];

let calls: StartOptions[];

function fakeInstance(name: string): ChrInstance {
	return {
		name,
		state: { name, version: "7.24.5", arch: "x86" },
		ports: { http: 9100, api: 9108 },
		sshPort: 9102,
	} as unknown as ChrInstance;
}

function replaceStart(refuse?: string) {
	spyOn(QuickCHR, "start").mockImplementation(async (opts: StartOptions = {}) => {
		calls.push(opts);
		if (opts.name === refuse) throw new QuickCHRError("PROVISIONING_WINDOW_CLOSED", `refused ${refuse}`);
		return fakeInstance(opts.name ?? "");
	});
}

function secureLoginByMachine(): Record<string, boolean | undefined> {
	return Object.fromEntries(calls.map((c) => [c.name, c.secureLogin]));
}

beforeEach(() => {
	rmSync(TMP, { recursive: true, force: true });
	process.env.HOME = join(TMP, "home");
	process.env.QUICKCHR_DATA_DIR = join(TMP, "data");
	delete process.env.QUICKCHR_SECURE_LOGIN;
	calls = [];
	spyOn(QuickCHR, "list").mockReturnValue(MACHINES.map((m) => ({ ...m })));
	spyOn(console, "log").mockImplementation(() => {});
	spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	mock.restore();
	rmSync(TMP, { recursive: true, force: true });
	for (const [key, value] of [["HOME", saved.home], ["QUICKCHR_DATA_DIR", saved.dataDir], ["QUICKCHR_SECURE_LOGIN", saved.secureLogin]] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("start --all forwards secure-login per machine (#193)", () => {
	test("--secure-login reaches every machine, booted or not", async () => {
		replaceStart();
		await cmdStart(["--all", "--secure-login"]);
		expect(secureLoginByMachine()).toEqual({ "a-fresh": true, "b-booted": true, "c-fresh": true });
	});

	test("--no-secure-login reaches every machine as false", async () => {
		replaceStart();
		await cmdStart(["--all", "--no-secure-login"]);
		expect(secureLoginByMachine()).toEqual({ "a-fresh": false, "b-booted": false, "c-fresh": false });
	});

	test("the setting applies only to machines that have never booted", async () => {
		process.env.QUICKCHR_SECURE_LOGIN = "true";
		replaceStart();
		await cmdStart(["--all"]);
		expect(secureLoginByMachine()).toEqual({ "a-fresh": true, "b-booted": undefined, "c-fresh": true });
	});

	test("with --no-wait the setting applies to none, and the explicit flag still reaches each", async () => {
		process.env.QUICKCHR_SECURE_LOGIN = "true";
		replaceStart();
		await cmdStart(["--all", "--no-wait"]);
		expect(secureLoginByMachine()).toEqual({ "a-fresh": undefined, "b-booted": undefined, "c-fresh": undefined });
		expect(calls.every((c) => c.wait === false)).toBe(true);

		calls = [];
		await cmdStart(["--all", "--no-wait", "--secure-login"]);
		expect(secureLoginByMachine()).toEqual({ "a-fresh": true, "b-booted": true, "c-fresh": true });
	});

	test("a refusal stops the batch after the machines before it have started", async () => {
		replaceStart("b-booted");
		await expect(cmdStart(["--all", "--secure-login"])).rejects.toThrow("refused b-booted");
		expect(calls.map((c) => c.name)).toEqual(["a-fresh", "b-booted"]);
	});
});
