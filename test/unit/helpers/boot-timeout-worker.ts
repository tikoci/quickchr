// Module spies stay in this subprocess so they cannot affect other unit tests.
import { expect, spyOn } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as platform from "../../../src/lib/platform.ts";
import * as qemu from "../../../src/lib/qemu.ts";
import * as images from "../../../src/lib/images.ts";
import * as diagnostics from "../../../src/lib/diagnostics.ts";
import * as disks from "../../../src/lib/disk.ts";
// Routing is under test, not the host's free space (#193).
import "./ample-storage.ts";
import { getCacheDir, getMachineDir, loadMachine, saveMachine } from "../../../src/lib/state.ts";
import { getInstanceCredentials, saveInstanceCredentials } from "../../../src/lib/credentials.ts";
import { currentHolder, machineLockPath } from "../../../src/lib/lock.ts";
import { isProvisioningWindowOpen } from "../../../src/lib/provisioning-window.ts";
import type { MachineState } from "../../../src/lib/types.ts";

const kind = process.argv[2];
const preserved = process.argv[3] === "preserve";
const name = "timeout-worker";
const machineDir = getMachineDir(name);
mkdirSync(getCacheDir(), { recursive: true });
const factory = join(getCacheDir(), "chr-7.24.5.img");
writeFileSync(factory, "factory-disk");
spyOn(platform, "requireQemu").mockReturnValue("qemu");
spyOn(platform, "detectPlatform").mockResolvedValue({ os: "linux", hostArch: "x64", packageManager: "apt", accelAvailable: ["tcg"] });
spyOn(platform, "detectAccel").mockResolvedValue("tcg");
spyOn(images, "ensureCachedImage").mockResolvedValue(factory);
spyOn(disks, "ensureConfiguredDisks").mockImplementation(async (dir) => ({ bootDisk: { path: join(dir, "disk.img"), format: "raw" } }));
spyOn(qemu, "buildQemuArgs").mockResolvedValue([]);
spyOn(qemu, "spawnQemu").mockResolvedValue({ pid: 99999999 });
spyOn(qemu, "stopQemu").mockResolvedValue(true);
spyOn(qemu, "waitForBoot").mockResolvedValue(false);
spyOn(diagnostics, "captureBootFailure").mockImplementation(async () => ({ summary: "diagnostic-sentinel", reportPath: null, preserved }));
const stop = qemu.stopQemu;
const { QuickCHR } = await import("../../../src/lib/quickchr.ts");

let stale: MachineState | undefined;
if (kind !== "new") {
	const state = await QuickCHR.add({ name, version: "7.24.5", arch: "x86" });
	stale = structuredClone(state);
	if (kind === "legacy") state.lastStartedAt = "2026-10-21T00:01:00.000Z";
	if (kind === "configured") state.provisioning = { at: "2026-10-21T00:01:00.000Z", steps: [] };
	if (kind === "configured" || kind === "legacy") {
		state.bootDiskFormat = "qcow2";
		state.bootSize = "128M";
		state.extraDisks = ["16M"];
		state.user = { name: "ops", password: "sentinel-password" };
	}
	saveMachine(state);
	// Give the relaunch a snapshot whose lifecycle classification is wrong. The
	// authoritative record under the lock must decide, in both directions.
	if (kind === "first") stale.lastStartedAt = "2026-10-21T00:01:00.000Z";
	writeFileSync(join(machineDir, "disk.img"), "configured-boot-sentinel");
	writeFileSync(join(machineDir, "boot.qcow2"), "configured-overlay-sentinel");
	writeFileSync(join(machineDir, "disk1.qcow2"), "configured-extra-sentinel");
	saveInstanceCredentials(name, "ops", "sentinel-password");
}
let message = "";
try {
	if (stale) await QuickCHR._launchExisting(stale, true);
	else await QuickCHR.start({ name, version: "7.24.5", arch: "x86", secureLogin: false });
	throw new Error("expected BOOT_TIMEOUT");
} catch (err) {
	expect((err as { code: string }).code).toBe("BOOT_TIMEOUT");
	message = (err as Error).message;
}
expect(message).toContain("diagnostic-sentinel");
expect(stop).toHaveBeenCalledWith(99999999);
expect(currentHolder(machineLockPath(machineDir))).toBeUndefined();
const after = loadMachine(name);
if (kind === "new" && !preserved) {
	expect(after).toBeUndefined();
	expect(getInstanceCredentials(name)).toBeNull();
} else {
	if (!after) throw new Error("preserved machine missing");
	expect(after.status).toBe("stopped");
	expect(after?.pid).toBeUndefined();
	if (kind === "first" && !preserved) {
		expect(isProvisioningWindowOpen(after)).toBe(true);
		expect(readFileSync(join(machineDir, "disk.img"), "utf8")).toBe("factory-disk");
	} else if (kind !== "new") {
		expect(isProvisioningWindowOpen(after)).toBe(false);
		expect(readFileSync(join(machineDir, "disk.img"), "utf8")).toBe("configured-boot-sentinel");
		expect(readFileSync(join(machineDir, "disk1.qcow2"), "utf8")).toBe("configured-extra-sentinel");
		expect(getInstanceCredentials(name)).toEqual({ user: "ops", password: "sentinel-password" });
	}
	if (kind === "configured" || kind === "legacy") {
		expect(after?.bootDiskFormat).toBe("qcow2");
		expect(after?.bootSize).toBe("128M");
		expect(after?.extraDisks).toEqual(["16M"]);
		expect(after?.user).toEqual({ name: "ops", password: "sentinel-password" });
		expect(readFileSync(join(machineDir, "boot.qcow2"), "utf8")).toBe("configured-overlay-sentinel");
		expect(message).toContain("stopped and preserved");
		expect(message).toContain(`quickchr start ${name}`);
		expect(message).toContain(`quickchr remove ${name}`);
		expect(message).not.toContain("quickchr clean");
		expect(message).not.toContain("QUICKCHR_PRESERVE_ON_FAILURE");
	}
}
