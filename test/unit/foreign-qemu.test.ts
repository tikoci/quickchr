/**
 * #259: a QEMU owned by another user (signal-0 answers EPERM) — typically one started
 * with `sudo quickchr start` for native vmnet — was read as dead. `list` then persisted
 * `stopped` over it, `stop` printed success and `shutdown` said "already stopped" while
 * QEMU kept running, and a later `start` could put a second QEMU on the same disk.
 *
 * The foreign pid is simulated: `process.kill` answers EPERM for one pid that does not
 * exist, and behaves normally for every other pid (the lock's own liveness checks).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { shellQuote } from "../../src/lib/names.ts";
import { pidLiveness } from "../../src/lib/pid.ts";
import { QuickCHR } from "../../src/lib/quickchr.ts";
import { getMachineDir, isMachineForeign, isMachineRunning, loadMachine, refreshAllStatuses, saveMachine } from "../../src/lib/state.ts";
import type { MachineState } from "../../src/lib/types.ts";

const TEST_DIR = join(import.meta.dir, ".tmp-foreign-qemu");
const origDataDir = process.env.QUICKCHR_DATA_DIR;
const FOREIGN_PID = 999_999_998;
const realKill = process.kill;

function machine(name: string, overrides: Partial<MachineState> = {}): MachineState {
	return {
		name,
		version: "7.24.4",
		arch: "x86",
		cpu: 1,
		mem: 512,
		networks: [{ specifier: "user", id: "net0" }],
		ports: {},
		packages: [],
		portBase: 9100,
		excludePorts: [],
		extraPorts: [],
		createdAt: "2026-11-16T00:00:00.000Z",
		status: "running",
		pid: FOREIGN_PID,
		machineDir: getMachineDir(name),
		...overrides,
	};
}

function seed(state: MachineState): void {
	mkdirSync(state.machineDir, { recursive: true });
	saveMachine(state);
}

/** Every signal to FOREIGN_PID, signal 0 included, is refused as it would be for a
 *  root-owned process. */
function denyForeignPid(): void {
	process.kill = ((pid: number, signal?: string | number) => {
		if (pid === FOREIGN_PID) {
			throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
		}
		return realKill(pid, signal);
	}) as typeof process.kill;
}

function expectStillRunning(name: string): void {
	const stored = loadMachine(name);
	expect(stored?.status).toBe("running");
	expect(stored?.pid).toBe(FOREIGN_PID);
}

beforeEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.QUICKCHR_DATA_DIR = TEST_DIR;
	denyForeignPid();
});

afterEach(() => {
	process.kill = realKill;
	rmSync(TEST_DIR, { recursive: true, force: true });
	if (origDataDir === undefined) delete process.env.QUICKCHR_DATA_DIR;
	else process.env.QUICKCHR_DATA_DIR = origDataDir;
});

describe("pidLiveness", () => {
	test("tells alive, foreign (EPERM) and dead apart", () => {
		expect(pidLiveness(process.pid)).toBe("alive");
		expect(pidLiveness(FOREIGN_PID)).toBe("foreign");
		expect(pidLiveness(999_999_999)).toBe("dead");
	});
});

describe("a QEMU owned by another user (#259)", () => {
	test("counts as running, and as foreign", () => {
		const state = machine("foreign-a");
		expect(isMachineRunning(state)).toBe(true);
		expect(isMachineForeign(state)).toBe(true);
		expect(isMachineForeign({ ...state, pid: process.pid })).toBe(false);
	});

	test("refreshAllStatuses keeps the stored status running", () => {
		seed(machine("foreign-list"));
		const listed = refreshAllStatuses().find((m) => m.name === "foreign-list");
		expect(listed?.status).toBe("running");
		expect(listed?.pid).toBe(FOREIGN_PID);
		expectStillRunning("foreign-list");
	});

	test("QuickCHR.get keeps the stored status running", () => {
		seed(machine("foreign-get"));
		expect(QuickCHR.get("foreign-get")?.state.status).toBe("running");
		expectStillRunning("foreign-get");
	});

	test("stop is refused with PERMISSION_DENIED and claims nothing", async () => {
		seed(machine("foreign-stop"));
		const instance = QuickCHR.get("foreign-stop");
		await expect(instance?.stop()).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
		expectStillRunning("foreign-stop");
	});

	test("shutdown is refused rather than reporting already-stopped", async () => {
		seed(machine("foreign-shutdown"));
		const instance = QuickCHR.get("foreign-shutdown");
		await expect(instance?.shutdown({ timeoutMs: 1000 })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
		expectStillRunning("foreign-shutdown");
	});

	test("remove is refused and the machine's state survives", async () => {
		const state = machine("foreign-remove");
		seed(state);
		const instance = QuickCHR.get("foreign-remove");
		await expect(instance?.remove()).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
		expect(existsSync(state.machineDir)).toBe(true);
		expectStillRunning("foreign-remove");
	});

	test("clean and destroy are refused and the machine's state survives", async () => {
		const state = machine("foreign-clean");
		seed(state);
		await expect(QuickCHR.get("foreign-clean")?.clean()).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
		await expect(QuickCHR.get("foreign-clean")?.destroy()).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
		expect(existsSync(state.machineDir)).toBe(true);
		expectStillRunning("foreign-clean");
	});

	test("set device-mode is refused before it touches the guest or relaunches QEMU", async () => {
		// Device-mode activation terminates and replaces QEMU. Before the refusal, a
		// failed monitor quit fell to an exit probe that read EPERM as exited and
		// spawned a replacement next to the live original.
		seed(machine("foreign-device-mode"));
		const instance = QuickCHR.get("foreign-device-mode");
		const error = await instance?.setDeviceMode({ mode: "rose" }).catch((e: unknown) => e);
		expect(error).toMatchObject({ code: "PERMISSION_DENIED" });
		// The hint carries the requested change: a bare `set <name>` is "Nothing to set".
		expect((error as { installHint?: string }).installHint).toEndWith("quickchr set foreign-device-mode --device-mode rose");
		expectStillRunning("foreign-device-mode");
	});

	// A `sudo quickchr start` can leave a root-owned lock in the machine dir; taking it
	// then fails with a raw EACCES. Modelled by denying writes on the machine dir,
	// which root ignores and Windows does not model, hence the skip.
	test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"a lock it cannot write still yields PERMISSION_DENIED, not a raw EACCES",
		async () => {
			const state = machine("foreign-locked");
			seed(state);
			chmodSync(state.machineDir, 0o500);
			try {
				const instance = QuickCHR.get("foreign-locked");
				await expect(instance?.stop()).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
				await expect(instance?.shutdown({ timeoutMs: 1000 })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
				await expect(instance?.remove()).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
				await expect(instance?.clean()).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
				await expect(instance?.setDeviceMode({ mode: "rose" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
			} finally {
				chmodSync(state.machineDir, 0o700);
			}
			expectStillRunning("foreign-locked");
		},
	);

	test("the hint quotes a legacy name so it pastes as one argument", async () => {
		seed(machine("lab old"));
		const error = await QuickCHR.get("lab old")?.stop().catch((e: unknown) => e);
		expect((error as { installHint?: string }).installHint).toEndWith("quickchr stop 'lab old'");
	});

	test("the refusal names the machine and a command to run as its owner", async () => {
		seed(machine("foreign-hint"));
		const error = await QuickCHR.get("foreign-hint")?.stop().catch((e: unknown) => e);
		expect(error).toMatchObject({ code: "PERMISSION_DENIED" });
		// sudo may reset HOME, so the hint pins this data dir rather than trusting it.
		const expected = process.platform === "win32"
			? "quickchr stop foreign-hint"
			: `sudo env QUICKCHR_DATA_DIR=${shellQuote(TEST_DIR)} quickchr stop foreign-hint`;
		expect((error as { installHint?: string }).installHint).toBe(`Run it as the user that owns that QEMU: ${expected}`);
		expect((error as Error).message).toContain(`PID ${FOREIGN_PID}`);
	});
});

describe("CLI stop --all with a foreign machine (#259)", () => {
	test("stops the owned machine, reports the foreign one, keeps its state, exits 1", async () => {
		// A real idle process stands in for an owned QEMU, so `stop` really signals it.
		const owned = Bun.spawn([process.execPath, "-e", "await Bun.sleep(60_000)"], { stdout: "ignore", stderr: "ignore" });
		try {
			seed(machine("owned-a", { pid: owned.pid }));
			seed(machine("foreign-b", { portBase: 9110 }));
			const proc = Bun.spawn([
				process.execPath,
				"--preload", join(import.meta.dir, "helpers/foreign-pid-preload.ts"),
				join(import.meta.dir, "../../src/cli/index.ts"),
				"stop", "--all",
			], {
				env: {
					...process.env,
					QUICKCHR_DATA_DIR: TEST_DIR,
					QUICKCHR_TEST_FOREIGN_PID: String(FOREIGN_PID),
					QUICKCHR_NO_TIPS: "1",
					NO_COLOR: "1",
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			expect(exitCode).toBe(1);
			expect(stdout).toContain("owned-a");
			expect(stderr).toContain("foreign-b");
			expect(stderr).toContain("as another user");
			expect(await owned.exited).not.toBeNull();
			expect(loadMachine("owned-a")?.status).toBe("stopped");
			expectStillRunning("foreign-b");
		} finally {
			owned.kill();
			await owned.exited;
		}
	}, 30_000);
});
