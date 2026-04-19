import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	assertSufficientQuickchrStorage,
	formatQuickchrUsage,
	getQuickchrStorageReport,
} from "../../src/lib/storage.ts";

const TEST_DIR = join(import.meta.dir, ".tmp-storage-test");
const originalHome = process.env.HOME;
const originalDataDir = process.env.QUICKCHR_DATA_DIR;

beforeEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.HOME = TEST_DIR;
	delete process.env.QUICKCHR_DATA_DIR;
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
	if (originalDataDir === undefined) {
		delete process.env.QUICKCHR_DATA_DIR;
	} else {
		process.env.QUICKCHR_DATA_DIR = originalDataDir;
	}
});

describe("storage helpers", () => {
	test("reports .local as the default storage root", () => {
		const report = getQuickchrStorageReport();
		expect(report.label).toBe(".local");
		expect(report.path).toBe(join(TEST_DIR, ".local"));
		expect(report.freeBytes).toBeGreaterThan(0);
	});

	test("uses QUICKCHR_DATA_DIR as the storage root override", () => {
		process.env.QUICKCHR_DATA_DIR = join(TEST_DIR, "custom-data");

		const report = getQuickchrStorageReport();
		expect(report.label).toBe("data dir");
		expect(report.path).toBe(join(TEST_DIR, "custom-data"));
	});

	test("summarizes quickchr usage across cache and machines", () => {
		const cacheDir = join(TEST_DIR, ".local", "share", "quickchr", "cache");
		const machineDir = join(TEST_DIR, ".local", "share", "quickchr", "machines", "vm1");
		const notesDir = join(TEST_DIR, ".local", "share", "quickchr");
		mkdirSync(cacheDir, { recursive: true });
		mkdirSync(machineDir, { recursive: true });
		writeFileSync(join(cacheDir, "chr.img"), "cache-data");
		writeFileSync(join(machineDir, "disk.img"), "machine-data");
		writeFileSync(join(notesDir, "notes.txt"), "misc");

		const report = getQuickchrStorageReport();
		expect(report.cacheBytes).toBe("cache-data".length);
		expect(report.machinesBytes).toBe("machine-data".length);
		expect(report.otherBytes).toBe("misc".length);
		expect(report.quickchrBytes).toBe(
			"cache-data".length + "machine-data".length + "misc".length,
		);
		expect(formatQuickchrUsage(report)).toContain("quickchr uses");
		expect(formatQuickchrUsage(report)).toContain("cache");
		expect(formatQuickchrUsage(report)).toContain("machines");
		expect(formatQuickchrUsage(report)).toContain("other");
	});

	test("throws INSUFFICIENT_DISK_SPACE when below the requested threshold", () => {
		const { freeBytes } = getQuickchrStorageReport();

		try {
			assertSufficientQuickchrStorage("run quickchr tests", freeBytes + 1);
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toMatchObject({
				code: "INSUFFICIENT_DISK_SPACE",
				message: expect.stringContaining("Not enough free space"),
			});
		}
	});
});
