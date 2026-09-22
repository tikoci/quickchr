import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { refreshMachineState } from "../../src/lib/quickchr.ts";
import { loadMachine, saveMachine } from "../../src/lib/state.ts";
import type { MachineState } from "../../src/lib/types.ts";

/**
 * A `ChrInstance` closes over one `MachineState` object, captured once when the handle
 * is created. A library consumer can hold that handle indefinitely — across another
 * process stopping and restarting the machine — so any operation that acts on the
 * *current* guest has to re-read under the lock first.
 *
 * `setDeviceMode()` is the one that must: it reads `state.pid` to power-cycle, and a
 * stale pid is either a process that has exited (a false `MACHINE_STOPPED`) or one the
 * OS has since reused, which `hardRebootMachine()` would then terminate.
 */

const TEST_DIR = join(import.meta.dir, ".tmp-refresh-machine-state");
const origDataDir = process.env.QUICKCHR_DATA_DIR;

function machine(overrides: Partial<MachineState> = {}): MachineState {
	return {
		name: "refresh-test",
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
		createdAt: "2026-01-01T00:00:00.000Z",
		status: "stopped",
		machineDir: join(TEST_DIR, "machines", "refresh-test"),
		...overrides,
	};
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

describe("refreshMachineState", () => {
	test("picks up a pid another process wrote", () => {
		// The snapshot says stopped with a dead pid; the machine has since been
		// restarted by someone else. Without the refresh this is a false MACHINE_STOPPED
		// at best, and a power-cycle aimed at a recycled pid at worst.
		const held = machine({ status: "stopped", pid: 4242 });
		saveMachine(machine({ status: "running", pid: 9999 }));

		refreshMachineState(held);

		expect(held.status).toBe("running");
		expect(held.pid).toBe(9999);
	});

	test("mutates in place, because the handle exposes this object as instance.state", () => {
		const held = machine({ pid: 4242 });
		const sameReference = held;
		saveMachine(machine({ status: "running", pid: 9999 }));

		refreshMachineState(held);

		expect(sameReference.pid).toBe(9999);
	});

	test("drops a field the reloaded record no longer has", () => {
		// The subtle half, and the reason this is not `Object.assign`. `clean()` removes
		// `provisioning`, `user` and `disableAdmin` precisely because they stopped being
		// true — a leftover would be read as fact, and `appliedDeviceModeRecord()` reads
		// exactly one of them.
		const held = machine({
			provisioning: { at: "2026-01-01T00:00:00.000Z", steps: ["deviceMode"] },
			user: { name: "lab", password: "x" },
			lastStartedAt: "2026-01-01T00:00:00.000Z",
		});
		saveMachine(machine({ cleanedAt: "2026-02-01T00:00:00.000Z" }));

		refreshMachineState(held);

		expect(held.provisioning).toBeUndefined();
		expect(held.user).toBeUndefined();
		expect(held.lastStartedAt).toBeUndefined();
		expect(held.cleanedAt).toBe("2026-02-01T00:00:00.000Z");
	});

	test("leaves the snapshot alone when there is nothing on disk to read", () => {
		// A removed machine is not a reason to blank a caller's handle — the operation
		// that follows will fail on its own terms with a better message.
		const held = machine({ pid: 4242 });
		expect(loadMachine("refresh-test")).toBeFalsy();

		refreshMachineState(held);

		expect(held.pid).toBe(4242);
	});
});
