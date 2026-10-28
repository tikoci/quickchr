// Module spies stay in this subprocess so they cannot affect other unit tests.
import { expect, spyOn } from "bun:test";

// The fake monitor binds a Unix socket, which the Windows named-pipe client
// would never reach — same rule as the in-process socket tests. Silent exit:
// the driver asserts empty output.
if (process.platform === "win32") process.exit(0);
// Tripwire: the driver must pass its data dir explicitly (Bun.spawn without
// env ignores runtime process.env mutations). Without it this worker would
// silently write a test machine into the developer's real data dir.
if (!process.env.QUICKCHR_DATA_DIR) throw new Error("QUICKCHR_DATA_DIR is not set");
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import * as platform from "../../../src/lib/platform.ts";
import * as qemu from "../../../src/lib/qemu.ts";
import * as diagnostics from "../../../src/lib/diagnostics.ts";
import { getMachineDir, saveMachine } from "../../../src/lib/state.ts";
import type { MachineState } from "../../../src/lib/types.ts";

/**
 * `continue()` reuses the frozen launch's recorded accelerator instead of
 * re-detecting: the seed carries lastAccel "hvf" while detectAccel() is
 * stubbed to "tcg", so a fresh detection would surface as accel=tcg in the
 * BOOT_TIMEOUT message. Detection prefers the current process's override,
 * which may differ from the launch's (`start --accel tcg`, plain `continue`).
 */

const name = "continue-accel";
const machineDir = getMachineDir(name);
mkdirSync(machineDir, { recursive: true });
const detectAccelSpy = spyOn(platform, "detectAccel").mockResolvedValue("tcg");
spyOn(qemu, "waitForBoot").mockResolvedValue(false);
spyOn(qemu, "stopQemu").mockResolvedValue(true);
spyOn(diagnostics, "captureBootFailure").mockImplementation(async () => ({ summary: "diagnostic-sentinel", reportPath: null, preserved: false }));

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
	lastAccel: "hvf",
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
expect(message).toContain("accel=hvf");
expect(detectAccelSpy).not.toHaveBeenCalled();
await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
