// Module spies stay in this subprocess so they cannot affect other unit tests.
import { expect, spyOn } from "bun:test";

// The fake monitor binds a Unix socket, which the Windows named-pipe client
// would never reach — same rule as the in-process socket tests. Silent exit:
// the driver asserts empty output.
if (process.platform === "win32") process.exit(0);
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import * as platform from "../../../src/lib/platform.ts";
import * as qemu from "../../../src/lib/qemu.ts";
import * as diagnostics from "../../../src/lib/diagnostics.ts";
import { getMachineDir, loadMachine, saveMachine } from "../../../src/lib/state.ts";
import { currentHolder, machineLockPath } from "../../../src/lib/lock.ts";
import type { MachineState } from "../../../src/lib/types.ts";

/**
 * A `continue()` whose resume succeeds but whose guest never reaches REST:
 * the monitor answers `info status`/`cont` from a fake socket, the boot wait
 * is stubbed false, and forensics are a sentinel. Proves the BOOT_TIMEOUT +
 * preserve-existing path from #214 without a guest.
 *
 * process.pid stands in for the QEMU pid (alive, so the dead-pid branch
 * cannot trigger); stopQemu is stubbed so cleanup cannot signal this worker.
 */

const name = "continue-timeout";
const machineDir = getMachineDir(name);
mkdirSync(machineDir, { recursive: true });
spyOn(platform, "detectAccel").mockResolvedValue("tcg");
spyOn(qemu, "waitForBoot").mockResolvedValue(false);
spyOn(qemu, "stopQemu").mockResolvedValue(true);
spyOn(diagnostics, "captureBootFailure").mockImplementation(async () => ({ summary: "diagnostic-sentinel", reportPath: null, preserved: false }));
const stop = qemu.stopQemu;

const server: Server = createServer((sock) => {
	sock.write("(qemu) ");
	sock.on("data", (data) => {
		const command = data.toString().trim();
		const body = command === "cont" ? "" : "VM status: paused (prelaunch)";
		sock.write(`${command}\n${body}\n(qemu) `);
	});
});
await new Promise<void>((resolve) => server.listen(join(machineDir, "monitor.sock"), resolve));

const state: MachineState = {
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
	status: "running",
	pid: process.pid,
	frozen: true,
	machineDir,
};
saveMachine(state);

const { QuickCHR } = await import("../../../src/lib/quickchr.ts");
const instance = QuickCHR.get(name);
if (!instance) throw new Error("seeded machine did not load");

let message = "";
try {
	await instance.continue();
	throw new Error("expected BOOT_TIMEOUT");
} catch (err) {
	expect((err as { code: string }).code).toBe("BOOT_TIMEOUT");
	message = (err as Error).message;
}
expect(message).toContain("diagnostic-sentinel");
expect(message).toContain("stopped and preserved");
expect(message).toContain(`quickchr start ${name}`);
expect(message).toContain(`quickchr remove ${name}`);
expect(stop).toHaveBeenCalledWith(process.pid);
expect(currentHolder(machineLockPath(machineDir))).toBeUndefined();
const after = loadMachine(name);
if (!after) throw new Error("preserved machine missing");
expect(after.status).toBe("stopped");
expect(after.pid).toBeUndefined();
expect(after.frozen).toBeUndefined();
await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
