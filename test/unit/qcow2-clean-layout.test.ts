import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { QuickCHR } from "../../src/lib/quickchr.ts";
import { saveMachine } from "../../src/lib/state.ts";
import { getDiskInfo } from "../../src/lib/disk.ts";
import { findQemuImg } from "../../src/lib/platform.ts";
import type { MachineState } from "../../src/lib/types.ts";

/**
 * Anchors the qcow2 machine layout `clean()` leaves behind (#199, #200).
 *
 * A qcow2 machine boots from `boot.qcow2` alone. Machines created before 0.5.1 also
 * kept the raw `disk.img` the qcow2 was converted from — a full-size copy of the cached
 * image that nothing reads. `clean()` now converts the fresh `boot.qcow2` straight from
 * the cache, so that copy goes too.
 */

const TEST_DIR = join(import.meta.dir, ".tmp-qcow2-clean-layout");
const NAME = "qcow2-clean";
const VERSION = "7.22.1";
const origEnv = { dataDir: process.env.QUICKCHR_DATA_DIR, home: process.env.HOME };

function machineDir(): string {
	return join(TEST_DIR, "machines", NAME);
}

function seedLegacyQcow2Machine(): void {
	const dir = machineDir();
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "disk.img"), "pre-0.5.1-raw-copy");
	writeFileSync(join(dir, "boot.qcow2"), "configured-guest-disk");
	writeFileSync(join(dir, "disk1.qcow2"), "configured-extra-disk");
	const state: MachineState = {
		name: NAME,
		version: VERSION,
		arch: "x86",
		cpu: 1,
		mem: 512,
		networks: [{ specifier: "user", id: "net0" }],
		ports: {},
		packages: [],
		portBase: 9100,
		excludePorts: [],
		extraPorts: [],
		bootDiskFormat: "qcow2",
		bootSize: "64M",
		extraDisks: ["32M"],
		createdAt: new Date().toISOString(),
		lastStartedAt: new Date().toISOString(),
		status: "stopped",
		machineDir: dir,
	};
	saveMachine(state);
	const cacheDir = join(TEST_DIR, "cache");
	mkdirSync(cacheDir, { recursive: true });
	writeFileSync(join(cacheDir, `chr-${VERSION}.img`), Buffer.alloc(1024 * 1024));
}

beforeEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.QUICKCHR_DATA_DIR = TEST_DIR;
	process.env.HOME = join(TEST_DIR, "home");
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	if (origEnv.dataDir !== undefined) process.env.QUICKCHR_DATA_DIR = origEnv.dataDir;
	else delete process.env.QUICKCHR_DATA_DIR;
	if (origEnv.home !== undefined) process.env.HOME = origEnv.home;
	else delete process.env.HOME;
});

describe("clean() on a qcow2 machine", () => {
	test("rebuilds boot.qcow2 from the cache and drops the legacy disk.img", async () => {
		if (!findQemuImg()) {
			console.log("Skipping: qemu-img not installed");
			return;
		}
		seedLegacyQcow2Machine();

		const instance = QuickCHR.get(NAME);
		await (instance as NonNullable<typeof instance>).clean();

		const boot = await getDiskInfo(join(machineDir(), "boot.qcow2"));
		expect(boot.format).toBe("qcow2");
		expect(boot.backingFilename).toBeUndefined();
		expect(boot.virtualSize).toBe(64 * 1024 * 1024);
		const extra = await getDiskInfo(join(machineDir(), "disk1.qcow2"));
		expect(extra.format).toBe("qcow2");
		expect(extra.virtualSize).toBe(32 * 1024 * 1024);
		expect(existsSync(join(machineDir(), "disk.img"))).toBe(false);
		expect(readdirSync(machineDir()).filter((file) => file.endsWith(".tmp"))).toEqual([]);
	});
});
