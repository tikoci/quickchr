// Module spies stay in this subprocess so they cannot affect other unit tests.
import { expect, spyOn } from "bun:test";

// Tripwire: the driver must pass its data dir explicitly (Bun.spawn without
// env ignores runtime process.env mutations). Without it this worker would
// silently write a test machine into the developer's real data dir.
if (!process.env.QUICKCHR_DATA_DIR) throw new Error("QUICKCHR_DATA_DIR is not set");
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as platform from "../../../src/lib/platform.ts";
import * as qemu from "../../../src/lib/qemu.ts";
import * as images from "../../../src/lib/images.ts";
import * as diagnostics from "../../../src/lib/diagnostics.ts";
import * as disks from "../../../src/lib/disk.ts";
// Routing is under test, not the host's free space (#193).
import "./ample-storage.ts";
import { getCacheDir, saveMachine } from "../../../src/lib/state.ts";

/**
 * `start({ name, timeoutExtra })` of a machine that already exists adds
 * `timeoutExtra` to its boot wait, as a new machine's start does (#291).
 * The boot wait is stubbed false and records the budget it was given;
 * forensics and cleanup are stubbed, so no QEMU or guest is involved.
 *
 * Kinds: `added` (add() made it, nothing pending), `pending` (add() recorded
 * first-boot provisioning), `booted` (it has booted before).
 */

const kind = process.argv[2];
const name = `extra-${kind}`;
const EXTRA_MS = 7_000;

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
const wait = spyOn(qemu, "waitForBoot").mockResolvedValue(false);
spyOn(diagnostics, "captureBootFailure").mockImplementation(async () => ({ summary: "diagnostic-sentinel", reportPath: null, preserved: true }));
const { QuickCHR, defaultBootTimeout } = await import("../../../src/lib/quickchr.ts");

const state = await QuickCHR.add({
	name,
	version: "7.24.5",
	arch: "x86",
	...(kind === "pending" ? { user: { name: "ops", password: "sentinel-password" } } : {}),
});
if (kind === "booted") {
	state.lastStartedAt = "2026-10-21T00:01:00.000Z";
	saveMachine(state);
}

let code = "";
try {
	await QuickCHR.start({ name, timeoutExtra: EXTRA_MS });
} catch (err) {
	code = (err as { code: string }).code;
}
expect(code).toBe("BOOT_TIMEOUT");
expect(wait).toHaveBeenCalledTimes(1);
expect(wait.mock.calls[0]?.[1]).toBe(defaultBootTimeout("x86", false, "tcg") + EXTRA_MS);
