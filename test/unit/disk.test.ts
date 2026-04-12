import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
	ensureConfiguredDisks,
	prepareBootDisk,
	prepareExtraDisks,
	cleanDiskFiles,
	getDiskInfo,
} from "../../src/lib/disk.ts";
import { findQemuImg } from "../../src/lib/platform.ts";

const TEST_DIR = "/tmp/quickchr-disk-test";

function hasQemuImg(): boolean {
	return findQemuImg() !== undefined;
}

describe("cleanDiskFiles", () => {
	beforeEach(() => {
		mkdirSync(TEST_DIR, { recursive: true });
	});
	afterEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	test("removes boot.qcow2 if present", () => {
		const bootQcow2 = join(TEST_DIR, "boot.qcow2");
		writeFileSync(bootQcow2, "fake-qcow2");
		expect(existsSync(bootQcow2)).toBe(true);

		cleanDiskFiles(TEST_DIR);
		expect(existsSync(bootQcow2)).toBe(false);
	});

	test("removes sequential extra disk files", () => {
		writeFileSync(join(TEST_DIR, "disk1.qcow2"), "fake");
		writeFileSync(join(TEST_DIR, "disk2.qcow2"), "fake");
		writeFileSync(join(TEST_DIR, "disk3.qcow2"), "fake");

		cleanDiskFiles(TEST_DIR);
		expect(existsSync(join(TEST_DIR, "disk1.qcow2"))).toBe(false);
		expect(existsSync(join(TEST_DIR, "disk2.qcow2"))).toBe(false);
		expect(existsSync(join(TEST_DIR, "disk3.qcow2"))).toBe(false);
	});

	test("does not remove disk.img (raw boot)", () => {
		const rawDisk = join(TEST_DIR, "disk.img");
		writeFileSync(rawDisk, "fake-raw");
		cleanDiskFiles(TEST_DIR);
		expect(existsSync(rawDisk)).toBe(true);
	});

	test("handles empty directory without error", () => {
		expect(() => cleanDiskFiles(TEST_DIR)).not.toThrow();
	});
});

describe("prepareBootDisk", () => {
	beforeEach(() => {
		mkdirSync(TEST_DIR, { recursive: true });
		// Create a fake raw disk image
		writeFileSync(join(TEST_DIR, "disk.img"), Buffer.alloc(512));
	});
	afterEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	test("returns raw disk when no bootSize specified", async () => {
		const result = await prepareBootDisk(TEST_DIR);
		expect(result.format).toBe("raw");
		expect(result.path).toBe(join(TEST_DIR, "disk.img"));
	});

	test("converts and resizes when bootSize specified", async () => {
		if (!hasQemuImg()) {
			console.log("Skipping: qemu-img not installed");
			return;
		}
		const result = await prepareBootDisk(TEST_DIR, "1G");
		expect(result.format).toBe("qcow2");
		expect(result.path).toBe(join(TEST_DIR, "boot.qcow2"));
		expect(existsSync(result.path)).toBe(true);
	});
});

describe("prepareExtraDisks", () => {
	beforeEach(() => {
		mkdirSync(TEST_DIR, { recursive: true });
	});
	afterEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	test("creates sequential qcow2 extra disks", async () => {
		if (!hasQemuImg()) {
			console.log("Skipping: qemu-img not installed");
			return;
		}
		const results = await prepareExtraDisks(TEST_DIR, ["256M", "512M"]);
		expect(results).toHaveLength(2);
		expect(results[0]?.path).toBe(join(TEST_DIR, "disk1.qcow2"));
		expect(results[0]?.format).toBe("qcow2");
		expect(results[1]?.path).toBe(join(TEST_DIR, "disk2.qcow2"));
		expect(existsSync(results[0]?.path ?? "")).toBe(true);
		expect(existsSync(results[1]?.path ?? "")).toBe(true);
	});

	test("returns empty array for empty sizes", async () => {
		const results = await prepareExtraDisks(TEST_DIR, []);
		expect(results).toHaveLength(0);
	});
});

describe("ensureConfiguredDisks", () => {
	beforeEach(() => {
		mkdirSync(TEST_DIR, { recursive: true });
		writeFileSync(join(TEST_DIR, "disk.img"), Buffer.alloc(512));
	});
	afterEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	test("returns raw boot disk when no disk customizations are requested", async () => {
		const disks = await ensureConfiguredDisks(TEST_DIR);
		expect(disks.bootDisk.format).toBe("raw");
		expect(disks.bootDisk.path).toBe(join(TEST_DIR, "disk.img"));
		expect(disks.extraDisks).toBeUndefined();
	});

	test("creates missing resized boot and extra disks from persisted config", async () => {
		if (!hasQemuImg()) {
			console.log("Skipping: qemu-img not installed");
			return;
		}
		const disks = await ensureConfiguredDisks(TEST_DIR, "1G", ["256M", "512M"]);
		expect(disks.bootDisk.format).toBe("qcow2");
		expect(existsSync(join(TEST_DIR, "boot.qcow2"))).toBe(true);
		expect(disks.extraDisks).toHaveLength(2);
		expect(existsSync(join(TEST_DIR, "disk1.qcow2"))).toBe(true);
		expect(existsSync(join(TEST_DIR, "disk2.qcow2"))).toBe(true);
	});
});

describe("getDiskInfo", () => {
	beforeEach(() => {
		mkdirSync(TEST_DIR, { recursive: true });
	});
	afterEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	test("returns disk info for a qcow2 image", async () => {
		if (!hasQemuImg()) {
			console.log("Skipping: qemu-img not installed");
			return;
		}
		// Create a real qcow2 disk to inspect
		const disks = await prepareExtraDisks(TEST_DIR, ["128M"]);
		const info = await getDiskInfo(disks[0]?.path as string);
		expect(info.format).toBe("qcow2");
		expect(info.virtualSize).toBe(128 * 1024 * 1024);
		expect(info.actualSize).toBeGreaterThan(0);
		expect(info.filename).toContain("disk1.qcow2");
	});
});
