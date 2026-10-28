import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import { QuickCHR } from "../../src/lib/quickchr.ts";
import { loadMachine, saveMachine } from "../../src/lib/state.ts";
import type { MachineState } from "../../src/lib/types.ts";

/**
 * Library-level `continue()` branches that need no guest: a dead pid, a
 * QEMU-level `cont` error, and frozen-vs-recorded-provisioning refusal.
 * The happy path and timeout recovery live in
 * test/integration/frozen-continue.test.ts and the timeout worker below.
 *
 * The monitor mock binds a Unix socket, so socket tests skip on Windows
 * (named-pipe mock not supported here — same rule as channels.test.ts).
 */

const TEST_DIR = join(import.meta.dir, ".tmp-continue");
const origDataDir = process.env.QUICKCHR_DATA_DIR;

function machine(name: string, overrides: Partial<MachineState> = {}): MachineState {
	return {
		name,
		version: "7.24.5",
		arch: "x86",
		cpu: 1,
		mem: 512,
		networks: [{ specifier: "user", id: "net0" }],
		ports: {},
		packages: [],
		portBase: 9130,
		excludePorts: [],
		extraPorts: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		status: "stopped",
		machineDir: join(TEST_DIR, "machines", name),
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

/** Minimal QEMU-monitor stand-in: prompt, then one canned reply per command. */
async function fakeMonitor(machineDir: string, reply: (command: string) => string): Promise<Server> {
	const server = createServer((sock) => {
		sock.write("(qemu) ");
		sock.on("data", (data) => {
			const command = data.toString().trim();
			sock.write(`${command}\n${reply(command)}\n(qemu) `);
		});
	});
	await new Promise<void>((resolve) => server.listen(join(machineDir, "monitor.sock"), resolve));
	return server;
}

async function closeServer(server: Server): Promise<void> {
	await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

describe("continue() without a guest", () => {
	test("a dead pid is MACHINE_STOPPED and leaves clean state", async () => {
		saveMachine(machine("cont-dead", { status: "running", pid: 999_999_999, frozen: true }));
		const instance = QuickCHR.get("cont-dead");
		if (!instance) throw new Error("seeded machine did not load");

		await expect(instance.continue({ wait: false })).rejects.toMatchObject({ code: "MACHINE_STOPPED" });
		const after = loadMachine("cont-dead");
		expect(after?.status).toBe("stopped");
		expect(after?.pid).toBeUndefined();
		expect(after?.frozen).toBeUndefined();
	});

	test("a QEMU-level cont error throws PROCESS_FAILED and keeps the marker", async () => {
		if (process.platform === "win32") return;
		const name = "cont-error";
		// process.pid is alive, so the dead-pid branch cannot trigger.
		saveMachine(machine(name, { status: "running", pid: process.pid, frozen: true }));
		const server = await fakeMonitor(join(TEST_DIR, "machines", name), (command) =>
			command === "cont" ? "Error: cannot resume frozen guest" : "VM status: paused (prelaunch)",
		);
		try {
			const instance = QuickCHR.get(name);
			if (!instance) throw new Error("seeded machine did not load");
			await expect(instance.continue({ wait: false })).rejects.toMatchObject({
				code: "PROCESS_FAILED",
				message: expect.stringContaining("continue failed"),
			});
			// The guest never resumed: still frozen, still running.
			expect(loadMachine(name)?.frozen).toBe(true);
			expect(instance.state.frozen).toBe(true);
		} finally {
			await closeServer(server);
		}
	});
});

describe("start() with frozen and recorded provisioning", () => {
	test("add-recorded packages plus frozen is refused before any boot I/O", async () => {
		// Never booted (no lastStartedAt): the provisioning window is open and
		// the recorded packages are pending — frozen cannot provision them.
		saveMachine(machine("cont-recorded", { packages: ["container"] }));
		await expect(QuickCHR.start({ name: "cont-recorded", frozen: true })).rejects.toMatchObject({
			code: "INVALID_ARGUMENT",
			message: expect.stringContaining("--frozen"),
		});
		// Refused, never persisted: still stopped, still never booted.
		const after = loadMachine("cont-recorded");
		expect(after?.status).toBe("stopped");
		expect(after?.pid).toBeUndefined();
	});
});
