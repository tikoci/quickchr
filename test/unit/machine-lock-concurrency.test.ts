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
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { QuickCHR, claimNewMachine } from "../../src/lib/quickchr.ts";
import { acquireLockNow, currentHolder, listReservations, machineLockPath } from "../../src/lib/lock.ts";
import { getMachineDir, loadMachine, removeMachine, saveMachine } from "../../src/lib/state.ts";
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
		expect(currentHolder(machineLockPath(getMachineDir("done")))).toBeUndefined();
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

	test("shutdown refreshes a stale handle under the lock and uses no nested stop lock", async () => {
		const state = machine("shutdown-busy");
		seed(state);
		const instance = QuickCHR.get(state.name);
		if (!instance) throw new Error("missing fixture");
		const holder = acquireLockNow(machineLockPath(state.machineDir), "start");
		const qemu = spawnIdle();
		try {
			saveMachine({ ...state, status: "running", pid: qemu.pid, version: "6.49.23" });
			let settled = false;
			const pending = instance.shutdown({ timeoutMs: 10 }).then((result) => { settled = true; return result; });
			await Bun.sleep(100);
			expect(settled).toBe(false);
			holder.release();
			const result = await pending;
			expect(result.outcome).toBe("forced");
			expect(result.requestError).toContain("REST");
			expect(loadMachine(state.name)?.pid).toBeUndefined();
			expect(loadMachine(state.name)?.status).toBe("stopped");
			expect(await instance.shutdown()).toEqual({ outcome: "already-stopped" });
		} finally {
			holder.release();
			qemu.kill();
			await qemu.exited;
		}
	});

	test("shutdown validates before acquiring a lock and rejects same-name recreation", async () => {
		const state = machine("shutdown-replaced");
		seed(state);
		const instance = QuickCHR.get(state.name);
		if (!instance) throw new Error("missing fixture");
		const holder = acquireLockNow(machineLockPath(state.machineDir), "foreground");
		try {
			await expect(instance.shutdown({ timeoutMs: 0 })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
		} finally { holder.release(); }
		removeMachine(state.name);
		seed({ ...state, createdAt: "2026-10-22T00:00:00.000Z" });
		await expect(instance.shutdown()).rejects.toMatchObject({ code: "MACHINE_NOT_FOUND" });
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

describe("remove() and a same-named create (Codex review of #190)", () => {
	// Codex's public-API repro: remove() deletes the machine directory before it
	// releases, and a create in a re-created directory takes a fresh record 1. The old
	// remove's release then appended into the new log and collected it, and a third
	// caller got in beside the new holder. Each interleaving point from 0 to 6
	// microtasks into the remove is tried.
	for (let ticks = 0; ticks <= 6; ticks++) {
		test(`a create racing a remove never shares the lock (after ${ticks} microtasks)`, async () => {
			const state = machine("same");
			seed(state);
			const instance = QuickCHR.get("same");
			if (!instance) throw new Error("seeded machine did not load");

			const removing = instance.remove();
			for (let i = 0; i < ticks; i++) await Promise.resolve();
			const lockPath = machineLockPath(state.machineDir);
			mkdirSync(state.machineDir, { recursive: true });
			let creator: ReturnType<typeof acquireLockNow> | undefined;
			try { creator = acquireLockNow(lockPath, "start"); } catch { /* the remove still holds it, or took the directory */ }
			await removing;
			mkdirSync(state.machineDir, { recursive: true });
			creator ??= acquireLockNow(lockPath, "start");

			expect(() => acquireLockNow(lockPath, "clean")).toThrow();
			expect(currentHolder(lockPath)?.op).toBe("start");
			creator.release();
		});
	}

	test("a create refused by a remove in progress leaves no orphan, and a retry succeeds", async () => {
		// Codex's P2: a create that made the directory and was then refused the lock
		// left it behind, and every retry said MACHINE_EXISTS. The lock lives in the
		// directory now, so a refusal means a live holder owns the directory.
		const state = machine("again");
		seed(state);
		const instance = QuickCHR.get("again");
		if (!instance) throw new Error("seeded machine did not load");
		const remover = acquireLockNow(machineLockPath(state.machineDir), "remove");
		const removing = instance.remove();
		try {
			await claimNewMachine("again", "add", {});
			expect.unreachable("should have thrown");
		} catch (e) {
			expectErrorCode(e, "MACHINE_LOCKED");
		}
		remover.release();
		await removing;
		expect(QuickCHR.listOrphans()).toEqual([]);
		const retry = await claimNewMachine("again", "add", {});
		retry.lock.release();
	});

	// Codex P2: when the rename failed, removeMachine() fell back to deleting in
	// place — the very window the rename exists to close. Now it retries, then refuses
	// and leaves the directory, lock and all. Made to fail by denying writes on the
	// rename target, which root ignores and Windows does not model, hence the skip.
	test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"a remove whose rename keeps failing leaves the machine, lock and all, and says so",
		() => {
			const state = machine("stuck");
			seed(state);
			const holder = acquireLockNow(machineLockPath(state.machineDir), "remove");
			const trashDir = join(TEST_DIR, ".removing");
			mkdirSync(trashDir, { recursive: true });
			chmodSync(trashDir, 0o500);
			try {
				removeMachine("stuck");
				expect.unreachable("should have thrown");
			} catch (e) {
				expectErrorCode(e, "STATE_ERROR");
				expect((e as Error).message).toContain("left in place");
			} finally {
				chmodSync(trashDir, 0o700);
			}
			expect(existsSync(join(state.machineDir, "machine.json"))).toBe(true);
			expect(currentHolder(machineLockPath(state.machineDir))?.op).toBe("remove");
			holder.release();
		},
		10_000,
	);

	// CodeRabbit: removeOrphan() released its lock only on the "not an orphan after
	// all" branch, so a removal that threw kept the leftover directory locked by this
	// process until it exited.
	test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"a leftover-directory removal that fails releases its lock, and a retry succeeds",
		() => {
			const dir = getMachineDir("leftover");
			mkdirSync(dir, { recursive: true });
			const trashDir = join(TEST_DIR, ".removing");
			mkdirSync(trashDir, { recursive: true });
			chmodSync(trashDir, 0o500);
			try {
				QuickCHR.removeOrphan("leftover");
				expect.unreachable("should have thrown");
			} catch (e) {
				expectErrorCode(e, "STATE_ERROR");
			} finally {
				chmodSync(trashDir, 0o700);
			}
			expect(currentHolder(machineLockPath(dir))).toBeUndefined();
			expect(QuickCHR.removeOrphan("leftover")).toBe(true);
			expect(existsSync(dir)).toBe(false);
		},
		10_000,
	);

	// CodeRabbit: a removal that stopped after its rename left the machine under
	// `.removing/`, where nothing would ever find it again.
	test("a later remove sweeps up an abandoned removal, and leaves one still in progress", async () => {
		const trashDir = join(TEST_DIR, ".removing");
		const abandoned = join(trashDir, `crashed.99999999.${crypto.randomUUID()}`);
		mkdirSync(abandoned, { recursive: true });
		const busy = spawnIdle();
		const inProgress = join(trashDir, `busy.${busy.pid}.${crypto.randomUUID()}`);
		mkdirSync(inProgress, { recursive: true });
		try {
			const state = machine("sweeper");
			seed(state);
			await QuickCHR.get("sweeper")?.remove();
			expect(existsSync(abandoned)).toBe(false);
			expect(existsSync(inProgress)).toBe(true);
		} finally {
			busy.kill();
			await busy.exited;
		}
	});

	test("remove() leaves nothing behind: no machine directory and no lock", async () => {
		const state = machine("tidy");
		seed(state);
		await QuickCHR.get("tidy")?.remove();
		expect(existsSync(state.machineDir)).toBe(false);
		expect(readdirSync(join(TEST_DIR, ".removing"))).toEqual([]);
	});

	test("a stop that waited out a remove is MACHINE_NOT_FOUND, not a stop of a stale pid", async () => {
		const state = machine("gone");
		seed(state);
		const instance = QuickCHR.get("gone");
		if (!instance) throw new Error("seeded machine did not load");
		const holder = acquireLockNow(machineLockPath(state.machineDir), "remove");
		const stopping = instance.stop();
		await Bun.sleep(200);
		rmSync(state.machineDir, { recursive: true, force: true });
		holder.release();
		try {
			await stopping;
			expect.unreachable("should have thrown");
		} catch (e) {
			expectErrorCode(e, "MACHINE_NOT_FOUND");
		}
	});

	test("a stop that waited out a remove and re-create does not act on the new machine", async () => {
		const state = machine("reborn");
		seed(state);
		const instance = QuickCHR.get("reborn");
		if (!instance) throw new Error("seeded machine did not load");
		const holder = acquireLockNow(machineLockPath(state.machineDir), "remove");
		const stopping = instance.stop();
		await Bun.sleep(200);
		saveMachine({ ...state, createdAt: "2026-10-22T00:00:00.000Z" });
		holder.release();
		try {
			await stopping;
			expect.unreachable("should have thrown");
		} catch (e) {
			expectErrorCode(e, "MACHINE_NOT_FOUND");
			expect((e as Error).message).toContain("created again");
		}
	});
});

describe("_launchExisting() re-reads state under the lock (#180)", () => {
	// CodeRabbit (outside the diff): start() works out pending provisioning from its
	// snapshot. If another start booted the machine before this one got the lock,
	// running it would be a second first boot.
	test("provisioning worked out before the lock is refused once another start booted the machine", async () => {
		const stale = machine("provisioned", { installAllPackages: true });
		seed(stale);
		saveMachine({ ...stale, lastStartedAt: "2026-10-21T12:00:00.000Z" });
		try {
			await QuickCHR._launchExisting(stale, true, { user: { name: "ops", password: "OpsPass1" } });
			expect.unreachable("should have thrown");
		} catch (e) {
			expectErrorCode(e, "PROVISIONING_WINDOW_CLOSED");
		}
		expect(currentHolder(machineLockPath(getMachineDir("provisioned")))).toBeUndefined();
	});

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
			expect(currentHolder(machineLockPath(stale.machineDir))).toBeUndefined();
		} finally {
			qemu.kill();
			await qemu.exited;
		}
	});
});
