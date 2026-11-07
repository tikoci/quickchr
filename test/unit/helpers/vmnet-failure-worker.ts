// Keep module spies in this process so they cannot affect the rest of the suite.
import { expect, mock, spyOn } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const kind = process.argv[2];
if (kind === "timeout") {
	const net = await import("node:net");
	const socket = Object.assign(new EventEmitter(), { destroy: mock(() => {}) });
	mock.module("node:net", () => ({ ...net, createConnection: () => socket }));
	const { assertSocketVmnetReachable } = await import("../../../src/lib/network.ts");
	const started = performance.now();
	await expect(assertSocketVmnetReachable([
		{ id: "net0", specifier: "shared", resolved: { qemuNetdevArgs: [], socketVmnetPath: "/pending.sock" } },
	], 20)).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE", message: expect.stringContaining("within 20 ms") });
	expect(performance.now() - started).toBeLessThan(1000);
	expect(socket.destroy).toHaveBeenCalledTimes(1);
} else {
	await import("./ample-storage.ts");
	const platform = await import("../../../src/lib/platform.ts");
	const qemu = await import("../../../src/lib/qemu.ts");
	const network = await import("../../../src/lib/network.ts");
	const images = await import("../../../src/lib/images.ts");
	const disks = await import("../../../src/lib/disk.ts");
	const channels = await import("../../../src/lib/channels.ts");
	const deviceMode = await import("../../../src/lib/device-mode.ts");
	const { getCacheDir, getMachineDir, loadMachine, saveMachine } = await import("../../../src/lib/state.ts");
	const { QuickCHRError } = await import("../../../src/lib/types.ts");
	const name = "vmnet-failure";
	const machineDir = getMachineDir(name);
	mkdirSync(getCacheDir(), { recursive: true });
	const factory = join(getCacheDir(), "chr-7.25.img");
	writeFileSync(factory, "factory");
	spyOn(platform, "requireQemu").mockReturnValue("qemu");
	spyOn(platform, "detectPlatform").mockResolvedValue({ os: "linux", hostArch: "x64", packageManager: "apt", accelAvailable: ["kvm"] });
	spyOn(platform, "detectAccel").mockResolvedValue("kvm");
	spyOn(images, "ensureCachedImage").mockResolvedValue(factory);
	spyOn(disks, "ensureConfiguredDisks").mockImplementation(async (dir) => ({ bootDisk: { path: join(dir, "disk.img"), format: "raw" } }));
	spyOn(qemu, "buildQemuArgs").mockResolvedValue([]);
	const spawn = spyOn(qemu, "spawnQemu").mockResolvedValue({ pid: 99999999 });
	spyOn(qemu, "stopQemu").mockResolvedValue(true);
	spyOn(qemu, "waitForBoot").mockResolvedValue(false);
	spyOn(channels, "monitorCommand").mockResolvedValue("");
	const probe = spyOn(network, "assertSocketVmnetReachable");
	const { QuickCHR } = await import("../../../src/lib/quickchr.ts");
	let instance: ReturnType<typeof QuickCHR.get>;
	if (kind === "retry") {
		probe.mockResolvedValueOnce(undefined).mockRejectedValue(new QuickCHRError("NETWORK_UNAVAILABLE", "daemon stopped"));
		const diagnostics = await import("../../../src/lib/diagnostics.ts");
		spyOn(diagnostics, "captureBootFailure").mockResolvedValue({ summary: "failed", reportPath: null, preserved: false });
		await expect(QuickCHR.start({ name, version: "7.25", arch: "x86", secureLogin: false })).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE" });
		expect(probe).toHaveBeenCalledTimes(2);
		expect(spawn).toHaveBeenCalledTimes(1);
	} else {
		const state = await QuickCHR.add({ name, version: "7.25", arch: "x86" });
		state.status = "running";
		state.pid = 99999999;
		state.lastStartedAt = new Date().toISOString();
		saveMachine(state);
		instance = QuickCHR.get(name);
		if (!instance) throw new Error("missing handle");
		instance.state.status = "running";
		instance.state.pid = 99999999;
		saveMachine(instance.state);
		probe.mockRejectedValue(new QuickCHRError("NETWORK_UNAVAILABLE", "daemon stopped"));
		spyOn(deviceMode, "waitForDeviceModeApi").mockResolvedValue(undefined);
		spyOn(deviceMode, "readDeviceMode").mockResolvedValue({ mode: "advanced", container: "no" });
		spyOn(deviceMode, "startDeviceModeUpdate").mockImplementation(() => new Promise(() => {}));
		await expect(QuickCHR._provisionInstance(instance, instance.state, { deviceMode: { enable: ["container"] } }, {
			arch: "x86", machineDir, bootDisk: { path: factory, format: "raw" }, mem: 512, cpu: 1,
			ports: state.ports, networks: state.networks, background: true, portBase: state.portBase,
		})).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE" });
		expect(spawn).not.toHaveBeenCalled();
		expect(instance.state).toMatchObject({ status: "stopped" });
		expect(instance.state.pid).toBeUndefined();
		expect(() => instance?.descriptor()).toThrow();
	}
	expect(loadMachine(name)?.status).toBe("stopped");
	expect(loadMachine(name)?.pid).toBeUndefined();
}
console.log("vmnet-failure-ok");
