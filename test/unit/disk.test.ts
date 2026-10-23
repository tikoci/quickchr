import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
	bootDiskFormatOf,
	ensureConfiguredDisks,
	writeBootDisk,
	prepareExtraDisks,
	cleanDiskFiles,
	getDiskInfo,
	parseSnapshotList,
	formatSnapshotTable,
	formatDiskSize,
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

describe("writeBootDisk", () => {
	const source = join(TEST_DIR, "factory.img");
	beforeEach(() => {
		mkdirSync(TEST_DIR, { recursive: true });
		writeFileSync(source, Buffer.alloc(1024 * 1024, 1));
	});
	afterEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	test("raw copies the source to disk.img and leaves no temp file", async () => {
		const result = await writeBootDisk(TEST_DIR, source, "raw");
		expect(result).toEqual({ path: join(TEST_DIR, "disk.img"), format: "raw" });
		expect(readFileSync(result.path).equals(readFileSync(source))).toBe(true);
		expect(existsSync(`${result.path}.tmp`)).toBe(false);
	});

	test("qcow2 converts straight from the source: standalone, resized, no local disk.img", async () => {
		if (!hasQemuImg()) {
			console.log("Skipping: qemu-img not installed");
			return;
		}
		const result = await writeBootDisk(TEST_DIR, source, "qcow2", "64M");
		expect(result).toEqual({ path: join(TEST_DIR, "boot.qcow2"), format: "qcow2" });
		const info = await getDiskInfo(result.path);
		expect(info.format).toBe("qcow2");
		expect(info.backingFilename).toBeUndefined();
		expect(info.virtualSize).toBe(64 * 1024 * 1024);
		expect(existsSync(join(TEST_DIR, "disk.img"))).toBe(false);
		expect(existsSync(`${result.path}.tmp`)).toBe(false);
	});

	test("a failed conversion publishes nothing", async () => {
		if (!hasQemuImg()) {
			console.log("Skipping: qemu-img not installed");
			return;
		}
		await expect(writeBootDisk(TEST_DIR, join(TEST_DIR, "missing.img"), "qcow2")).rejects.toThrow("qemu-img convert failed");
		expect(existsSync(join(TEST_DIR, "boot.qcow2"))).toBe(false);
		expect(existsSync(join(TEST_DIR, "boot.qcow2.tmp"))).toBe(false);
	});

	test("a failed resize publishes nothing, and leaves an existing disk alone", async () => {
		if (!hasQemuImg()) {
			console.log("Skipping: qemu-img not installed");
			return;
		}
		writeFileSync(join(TEST_DIR, "boot.qcow2"), "previous-disk");
		await expect(writeBootDisk(TEST_DIR, source, "qcow2", "1K")).rejects.toThrow("qemu-img resize failed");
		expect(readFileSync(join(TEST_DIR, "boot.qcow2"), "utf-8")).toBe("previous-disk");
		expect(existsSync(join(TEST_DIR, "boot.qcow2.tmp"))).toBe(false);
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
	const factory = join(TEST_DIR, "factory.img");
	let factoryCalls = 0;
	const factoryImage = async () => {
		factoryCalls++;
		return factory;
	};
	beforeEach(() => {
		mkdirSync(TEST_DIR, { recursive: true });
		writeFileSync(factory, Buffer.alloc(1024 * 1024, 2));
		factoryCalls = 0;
	});
	afterEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	test("returns an existing raw disk without touching the factory image", async () => {
		writeFileSync(join(TEST_DIR, "disk.img"), "guest-disk");
		const disks = await ensureConfiguredDisks(TEST_DIR, undefined, undefined, "raw", { booted: true, factoryImage });
		expect(disks.bootDisk).toEqual({ path: join(TEST_DIR, "disk.img"), format: "raw" });
		expect(disks.extraDisks).toBeUndefined();
		expect(factoryCalls).toBe(0);
	});

	test("a booted qcow2 machine needs only boot.qcow2, not disk.img (#200)", async () => {
		writeFileSync(join(TEST_DIR, "boot.qcow2"), "guest-disk");
		const disks = await ensureConfiguredDisks(TEST_DIR, "1G", undefined, "qcow2", { booted: true, factoryImage });
		expect(disks.bootDisk).toEqual({ path: join(TEST_DIR, "boot.qcow2"), format: "qcow2" });
		expect(readFileSync(join(TEST_DIR, "boot.qcow2"), "utf-8")).toBe("guest-disk");
		expect(factoryCalls).toBe(0);
	});

	test("a booted qcow2 machine with boot.qcow2 missing is refused, not rebuilt from disk.img", async () => {
		writeFileSync(join(TEST_DIR, "disk.img"), "factory-copy");
		await expect(
			ensureConfiguredDisks(TEST_DIR, undefined, undefined, "qcow2", { booted: true, factoryImage }),
		).rejects.toThrow("quickchr clean");
		expect(existsSync(join(TEST_DIR, "boot.qcow2"))).toBe(false);
		expect(factoryCalls).toBe(0);
	});

	test("a booted raw machine with disk.img missing is refused", async () => {
		await expect(
			ensureConfiguredDisks(TEST_DIR, undefined, undefined, "raw", { booted: true, factoryImage }),
		).rejects.toThrow("Disk image not found");
		expect(existsSync(join(TEST_DIR, "disk.img"))).toBe(false);
		expect(factoryCalls).toBe(0);
	});

	test("a booted machine with an extra disk missing is refused, not given a blank one", async () => {
		writeFileSync(join(TEST_DIR, "disk.img"), "guest-disk");
		await expect(
			ensureConfiguredDisks(TEST_DIR, undefined, ["256M"], "raw", { booted: true, factoryImage }),
		).rejects.toThrow("disk1.qcow2");
		expect(existsSync(join(TEST_DIR, "disk1.qcow2"))).toBe(false);
	});

	test("a never-booted raw machine with no disk.img is built from the factory image", async () => {
		const disks = await ensureConfiguredDisks(TEST_DIR, undefined, undefined, "raw", { booted: false, factoryImage });
		expect(disks.bootDisk.path).toBe(join(TEST_DIR, "disk.img"));
		expect(readFileSync(disks.bootDisk.path).equals(readFileSync(factory))).toBe(true);
		expect(factoryCalls).toBe(1);
	});

	test("a never-booted machine with no disk and no factory image is refused", async () => {
		await expect(
			ensureConfiguredDisks(TEST_DIR, undefined, undefined, "raw", { booted: false }),
		).rejects.toThrow("Disk image not found");
	});

	test("a new qcow2 machine is built from the factory image, with no local disk.img", async () => {
		if (!hasQemuImg()) {
			console.log("Skipping: qemu-img not installed");
			return;
		}
		const disks = await ensureConfiguredDisks(TEST_DIR, "1G", ["256M", "512M"], "qcow2", { booted: false, factoryImage });
		expect(disks.bootDisk).toEqual({ path: join(TEST_DIR, "boot.qcow2"), format: "qcow2" });
		expect((await getDiskInfo(disks.bootDisk.path)).virtualSize).toBe(1024 ** 3);
		expect(existsSync(join(TEST_DIR, "disk.img"))).toBe(false);
		expect(disks.extraDisks).toHaveLength(2);
		expect(existsSync(join(TEST_DIR, "disk1.qcow2"))).toBe(true);
		expect(existsSync(join(TEST_DIR, "disk2.qcow2"))).toBe(true);
		expect(factoryCalls).toBe(1);
	});

	test("a legacy never-booted qcow2 state converts its own disk.img, not the factory image", async () => {
		if (!hasQemuImg()) {
			console.log("Skipping: qemu-img not installed");
			return;
		}
		writeFileSync(join(TEST_DIR, "disk.img"), Buffer.alloc(1024 * 1024, 3));
		const disks = await ensureConfiguredDisks(TEST_DIR, undefined, undefined, "qcow2", { booted: false, factoryImage });
		expect(disks.bootDisk.path).toBe(join(TEST_DIR, "boot.qcow2"));
		expect(existsSync(disks.bootDisk.path)).toBe(true);
		expect(factoryCalls).toBe(0);
	});
});

describe("bootDiskFormatOf", () => {
	test("explicit format wins; a bare bootSize means qcow2; otherwise raw", () => {
		expect(bootDiskFormatOf({ bootDiskFormat: "raw" })).toBe("raw");
		expect(bootDiskFormatOf({ bootDiskFormat: "qcow2" })).toBe("qcow2");
		expect(bootDiskFormatOf({ bootSize: "1G" })).toBe("qcow2");
		expect(bootDiskFormatOf({})).toBe("raw");
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

describe("parseSnapshotList", () => {
	test("parses typical QEMU monitor output", () => {
		const output = [
			"ID        TAG               VM SIZE                DATE        VM CLOCK     ICOUNT",
			"--        test              113 MiB 2026-04-14 00:47:19  0000:01:17.163         --",
			"1         before-upgrade    118 MiB 2026-04-14 01:02:33  0001:32:15.421         --",
		].join("\n");
		const snaps = parseSnapshotList(output);
		expect(snaps).toHaveLength(2);
		expect(snaps[0]?.name).toBe("test");
		expect(snaps[0]?.id).toBe("0"); // "--" maps to "0"
		expect(snaps[0]?.vmStateSize).toBe(113 * 1024 * 1024);
		expect(snaps[0]?.date).toBe("2026-04-14T00:47:19Z");
		expect(snaps[0]?.vmClock).toBe("0000:01:17.163");
		expect(snaps[0]?.icount).toBeUndefined();
		expect(snaps[1]?.name).toBe("before-upgrade");
		expect(snaps[1]?.id).toBe("1");
	});

	test("returns empty for no snapshots", () => {
		expect(parseSnapshotList("There is no snapshot available.")).toHaveLength(0);
		expect(parseSnapshotList("")).toHaveLength(0);
	});

	test("handles GiB sizes", () => {
		const output = "--        bigsnap           2.1 GiB 2026-04-14 02:00:00  0010:00:00.000         --";
		const snaps = parseSnapshotList(output);
		expect(snaps).toHaveLength(1);
		expect(snaps[0]?.vmStateSize).toBeGreaterThan(2 * 1024 ** 3);
	});

	// QEMU version drift guards (#31 follow-up): the runner's QEMU 8.x prints
	// 2-digit VM CLOCK hours (and ICOUNT may be absent entirely); 11.x brew
	// builds print 4-digit hours. A parser gap here returns [] and makes a
	// SUCCESSFUL savevm look failed.
	test("parses 2-digit VM CLOCK hours (QEMU 8.x)", () => {
		const output = [
			"List of snapshots present on all disks:",
			"ID        TAG               VM SIZE                DATE        VM CLOCK     ICOUNT",
			"--        baseline           47 MiB 2026-07-05 04:37:01    00:00:41.532         --",
		].join("\n");
		const snaps = parseSnapshotList(output);
		expect(snaps).toHaveLength(1);
		expect(snaps[0]?.name).toBe("baseline");
		expect(snaps[0]?.vmClock).toBe("00:00:41.532");
	});

	test("parses rows without an ICOUNT column", () => {
		const output = "--        baseline           47 MiB 2026-07-05 04:37:01    00:00:41.532";
		const snaps = parseSnapshotList(output);
		expect(snaps).toHaveLength(1);
		expect(snaps[0]?.icount).toBeUndefined();
	});
});

describe("formatDiskSize", () => {
	test("formats bytes to human readable", () => {
		expect(formatDiskSize(500)).toBe("500 B");
		expect(formatDiskSize(1024)).toBe("1 KiB");
		expect(formatDiskSize(113 * 1024 * 1024)).toBe("113 MiB");
		expect(formatDiskSize(2.5 * 1024 ** 3)).toBe("2.5 GiB");
	});
});

describe("formatSnapshotTable", () => {
	test("formats snapshots as aligned table", () => {
		const snaps = [
			{ id: "1", name: "baseline", vmStateSize: 113 * 1024 * 1024, date: "2026-04-14T00:47:19.000Z", vmClock: "0001:17:00.000" },
			{ id: "2", name: "after-config", vmStateSize: 118 * 1024 * 1024, date: "2026-04-14T01:02:33.000Z", vmClock: "0001:32:15.000" },
		];
		const table = formatSnapshotTable(snaps);
		expect(table).toContain("#");
		expect(table).toContain("NAME");
		expect(table).toContain("baseline");
		expect(table).toContain("after-config");
		expect(table).toContain("113 MiB");
		const lines = table.split("\n");
		expect(lines).toHaveLength(3); // header + 2 data rows
	});

	test("returns message for empty list", () => {
		expect(formatSnapshotTable([])).toBe("No snapshots.");
	});
});
