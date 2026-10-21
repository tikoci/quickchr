/**
 * Concurrency regressions for machine creation and the lifecycle lock.
 *
 * #140: two creations each read the machine list and probe the same free ports before
 * either persists anything, so both pick the same port block and one QEMU fails its
 * `hostfwd` bind. The MAC allocator sits on the same lines and inherits the race.
 * `claimNewMachine()` is the shared step of `add()` and `start()`; driving it directly
 * exercises the allocation window without a download or a QEMU.
 *
 * #181: `stop()`/`remove()`/`clean()` took no lock, so they raced every relaunch. They
 * now wait, bounded, for a holder — and act on state re-read under the lock (#180).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { QuickCHR, claimNewMachine } from "../../src/lib/quickchr.ts";
import { acquireLockNow, listReservations, machineLockPath } from "../../src/lib/lock.ts";
import { getMachineDir, loadMachine, saveMachine } from "../../src/lib/state.ts";
import type { MachineState } from "../../src/lib/types.ts";

const TEST_DIR = join(import.meta.dir, ".tmp-machine-lock-concurrency");
const WORKER = join(import.meta.dir, "helpers/claim-machine-worker.ts");
const origDataDir = process.env.QUICKCHR_DATA_DIR;

/** A live process to stand in for a holder or a QEMU — Bun itself, so it exists on
 *  Windows too. */
function spawnIdle() {
	return Bun.spawn([process.execPath, "-e", "await Bun.sleep(60_000)"], { stdout: "ignore", stderr: "ignore" });
}

function expectErrorCode(e: unknown, code: string) {
	expect(e).toBeInstanceOf(Error);
	expect((e as { code?: string }).code).toBe(code);
}

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
		createdAt: "2026-10-21T00:00:00.000Z",
		status: "stopped",
		machineDir: getMachineDir(name),
		...overrides,
	};
}

function seed(state: MachineState): void {
	mkdirSync(state.machineDir, { recursive: true });
	saveMachine(state);
}

beforeEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.QUICKCHR_DATA_DIR = TEST_DIR;
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	if (origDataDir === undefined) delete process.env.QUICKCHR_DATA_DIR;
	else process.env.QUICKCHR_DATA_DIR = origDataDir;
});

describe("concurrent creation claims (#140)", () => {
	test("one Promise.all of creations gets distinct port blocks and MACs", async () => {
		const names = ["lt", "testing", "stable", "dev"];
		const claims = await Promise.all(names.map((n) => claimNewMachine(n, "start", {})));
		try {
			const bases = claims.map((c) => c.portBase);
			expect(new Set(bases).size).toBe(names.length);
			const macs = claims.flatMap((c) => c.networks.map((n) => n.mac));
			expect(new Set(macs).size).toBe(macs.length);
		} finally {
			for (const c of claims) c.lock.release();
		}
	});

	test("separate processes creating at the same instant get distinct blocks", async () => {
		const names = ["proc-a", "proc-b", "proc-c"];
		const startAt = Date.now() + 500;
		const outputs = await Promise.all(names.map(async (name) => {
			const proc = Bun.spawn([process.execPath, WORKER, name, String(startAt), "1500"], {
				env: { ...process.env, QUICKCHR_DATA_DIR: TEST_DIR },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
			return out.trim();
		}));
		const ok = outputs.filter((o) => o.startsWith("OK "));
		expect(ok).toHaveLength(names.length);
		const bases = ok.map((o) => o.split(" ")[2]);
		expect(new Set(bases).size).toBe(names.length);
	}, 30_000);

	test("a claim is visible as a reservation until it is released", async () => {
		const claim = await claimNewMachine("inflight", "add", {});
		expect(listReservations().map((r) => r.portBase)).toEqual([claim.portBase]);
		claim.lock.release();
		expect(listReservations()).toEqual([]);
	});

	test("an explicit portBase overlapping a persisted machine is PORT_CONFLICT, not remapped", async () => {
		seed(machine("existing", { portBase: 9100 }));
		try {
			await claimNewMachine("newcomer", "start", { portBase: 9105 });
			expect.unreachable("should have thrown");
		} catch (e) {
			expectErrorCode(e, "PORT_CONFLICT");
			expect((e as Error).message).toContain('"existing"');
		}
		// Refused before anything was created for it.
		expect(existsSync(getMachineDir("newcomer"))).toBe(false);
	});

	test("an explicit portBase overlapping a creation in flight is PORT_CONFLICT", async () => {
		const first = await claimNewMachine("first", "start", {});
		try {
			await claimNewMachine("second", "start", { portBase: first.portBase });
			expect.unreachable("should have thrown");
		} catch (e) {
			expectErrorCode(e, "PORT_CONFLICT");
			expect((e as Error).message).toContain('"first"');
		} finally {
			first.lock.release();
		}
	});

	test("a second creation of the same name fails fast with MACHINE_LOCKED", async () => {
		const first = await claimNewMachine("same", "start", {});
		try {
			await claimNewMachine("same", "start", {});
			expect.unreachable("should have thrown");
		} catch (e) {
			expectErrorCode(e, "MACHINE_LOCKED");
		} finally {
			first.lock.release();
		}
	});

	test("a creation that lost the race to a finished create is MACHINE_EXISTS", async () => {
		seed(machine("done"));
		try {
			await claimNewMachine("done", "start", {});
			expect.unreachable("should have thrown");
		} catch (e) {
			expectErrorCode(e, "MACHINE_EXISTS");
		}
		expect(existsSync(machineLockPath(getMachineDir("done")))).toBe(false);
	});
});

describe("lifecycle operations take the machine lock (#181)", () => {
	test("stop() waits for a start in flight, then stops the pid that start recorded", async () => {
		const state = machine("busy");
		seed(state);
		const instance = QuickCHR.get("busy");
		if (!instance) throw new Error("seeded machine did not load");

		// A start holds the lock and, mid-flight, records the QEMU it spawned. The
		// handle's snapshot still says stopped with no pid.
		const holder = acquireLockNow(machineLockPath(state.machineDir), "start");
		const qemu = spawnIdle();
		try {
			saveMachine({ ...state, status: "running", pid: qemu.pid });

			let stopped = false;
			const stopping = instance.stop().then(() => { stopped = true; });
			await Bun.sleep(300);
			expect(stopped).toBe(false);

			holder.release();
			await stopping;
			expect(await Promise.race([qemu.exited.then(() => "exited"), Bun.sleep(3_000).then(() => "alive")])).toBe("exited");
			expect(loadMachine("busy")?.status).toBe("stopped");
			expect(loadMachine("busy")?.pid).toBeUndefined();
		} finally {
			holder.release();
			qemu.kill();
			await qemu.exited;
		}
	});

	test("remove() waits for the holder rather than deleting under it", async () => {
		const state = machine("doomed");
		seed(state);
		const instance = QuickCHR.get("doomed");
		if (!instance) throw new Error("seeded machine did not load");

		const holder = acquireLockNow(machineLockPath(state.machineDir), "start");
		const removing = instance.remove();
		await Bun.sleep(300);
		expect(existsSync(state.machineDir)).toBe(true);
		holder.release();
		await removing;
		expect(existsSync(state.machineDir)).toBe(false);
	});

	test("stop() does not wait for a foreground holder", async () => {
		const state = machine("attached");
		seed(state);
		const instance = QuickCHR.get("attached");
		if (!instance) throw new Error("seeded machine did not load");
		const holder = acquireLockNow(machineLockPath(state.machineDir), "foreground");
		try {
			await instance.stop();
			expect.unreachable("should have thrown");
		} catch (e) {
			expectErrorCode(e, "MACHINE_LOCKED");
		} finally {
			holder.release();
		}
	});
});

describe("_launchExisting() re-reads state under the lock (#180)", () => {
	test("a machine another start got running is handed back, not booted twice", async () => {
		const stale = machine("raced");
		seed(stale);
		const qemu = spawnIdle();
		try {
			saveMachine({ ...stale, status: "running", pid: qemu.pid });
			// No disk.img, no QEMU binary needed: the refresh comes first, and a running
			// machine returns before anything would spawn.
			const instance = await QuickCHR._launchExisting(stale, true);
			expect(instance.state.pid).toBe(qemu.pid);
			expect(existsSync(machineLockPath(stale.machineDir))).toBe(false);
		} finally {
			qemu.kill();
			await qemu.exited;
		}
	});
});
