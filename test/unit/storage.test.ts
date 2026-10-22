import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
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

const STORAGE_MODULE = join(import.meta.dir, "../../src/lib/storage.ts");

/** Free space as a child process reports it, with a stub `df` first on its PATH and,
 *  optionally, `statfsSync` replaced. A child because Bun resolves a spawned command
 *  against the PATH the process started with — setting process.env.PATH here would not
 *  reach freeBytesForPath()'s `df`. `availableKb: null` makes the stub exit 1, forcing
 *  the statfsSync fallback. Returns the report and every path statfsSync was asked about. */
async function freeSpaceInChild(
	availableKb: number | null,
	statfs?: { bavail: number; bsize: number },
): Promise<{ freeBytes: number; statPath: string; statfsPaths: string[] }> {
	const bin = join(TEST_DIR, "stub-bin");
	mkdirSync(bin, { recursive: true });
	// The failing variant still prints a parseable 1 KiB line: only the exit status says
	// "do not trust this", which is what freeBytesForPath() must honour.
	const header = "echo 'Filesystem 1024-blocks Used Available Capacity Mounted on'";
	const script = availableKb === null
		? `#!/bin/sh\n${header}\necho 'stub 9999999 1 1 1% /'\nexit 1\n`
		: `#!/bin/sh\n${header}\necho 'stub 9999999 1 ${availableKb} 1% /'\n`;
	writeFileSync(join(bin, "df"), script);
	chmodSync(join(bin, "df"), 0o755);
	const code = `
		import { spyOn } from "bun:test";
		import * as fs from "node:fs";
		const statfs = ${JSON.stringify(statfs ?? null)};
		const statfsPaths = [];
		if (statfs) spyOn(fs, "statfsSync").mockImplementation((path) => { statfsPaths.push(String(path)); return statfs; });
		const { getQuickchrStorageReport } = await import(${JSON.stringify(STORAGE_MODULE)});
		const report = getQuickchrStorageReport();
		console.log(JSON.stringify({ freeBytes: report.freeBytes, statPath: report.statPath, statfsPaths }));
	`;
	const proc = Bun.spawn([process.execPath, "-e", code], {
		env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	if (exitCode !== 0) throw new Error(`storage probe exited ${exitCode}: ${stderr}`);
	return JSON.parse(stdout);
}

describe("storage helpers", () => {
	test("reports .local as the default storage root", () => {
		if (process.platform === "win32") {
			// On Windows getDataDir() uses LOCALAPPDATA — the label is always "data dir"
			const report = getQuickchrStorageReport();
			expect(report.label).toBe("data dir");
			expect(report.freeBytes).toBeGreaterThan(0);
		} else {
			const report = getQuickchrStorageReport();
			expect(report.label).toBe(".local");
			expect(report.path).toBe(join(TEST_DIR, ".local"));
			expect(report.freeBytes).toBeGreaterThan(0);
		}
	});

	test("uses QUICKCHR_DATA_DIR as the storage root override", () => {
		process.env.QUICKCHR_DATA_DIR = join(TEST_DIR, "custom-data");

		const report = getQuickchrStorageReport();
		expect(report.label).toBe("data dir");
		expect(report.path).toBe(join(TEST_DIR, "custom-data"));
	});

	test("summarizes quickchr usage across cache and machines", () => {
		// Set QUICKCHR_DATA_DIR explicitly for cross-platform isolation.
		// On Windows getDataDir() reads LOCALAPPDATA (not HOME), so HOME alone is
		// insufficient to redirect storage to the temp test directory.
		const dataDir = join(TEST_DIR, ".local", "share", "quickchr");
		process.env.QUICKCHR_DATA_DIR = dataDir;
		const cacheDir = join(dataDir, "cache");
		const machineDir = join(dataDir, "machines", "vm1");
		mkdirSync(cacheDir, { recursive: true });
		mkdirSync(machineDir, { recursive: true });
		writeFileSync(join(cacheDir, "chr.img"), "cache-data");
		writeFileSync(join(machineDir, "disk.img"), "machine-data");
		writeFileSync(join(dataDir, "notes.txt"), "misc");

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

	test.skipIf(process.platform === "win32")("reads free space from df's Available column (POSIX)", async () => {
		// statfs is stubbed to a different answer, so a match proves df was the source.
		const { freeBytes, statfsPaths } = await freeSpaceInChild(7_000_000, { bavail: 3, bsize: 4096 });
		expect(freeBytes).toBe(7_000_000 * 1024);
		expect(statfsPaths).toEqual([]);
	});

	describe("statfsSync fallback — the only path Windows takes (#193)", () => {
		// On POSIX the failing df forces the fallback; on Windows df is never consulted, so
		// this is the native path either way. The stub prints 1 KiB before exiting 1, so a
		// fallback that read df's output anyway would report 1024. statfs is stubbed too,
		// so the expected value is exact rather than a live disk reading.
		test("returns bavail × bsize for the measured path", async () => {
			const { freeBytes, statPath, statfsPaths } = await freeSpaceInChild(null, { bavail: 123_457, bsize: 8192 });
			expect(freeBytes).toBe(123_457 * 8192);
			expect(statfsPaths).toEqual([statPath]);
		});

		test("reports zero when the filesystem is full", async () => {
			const { freeBytes } = await freeSpaceInChild(null, { bavail: 0, bsize: 4096 });
			expect(freeBytes).toBe(0);
		});

		test("treats a zero block size as 4096", async () => {
			const { freeBytes } = await freeSpaceInChild(null, { bavail: 10, bsize: 0 });
			expect(freeBytes).toBe(10 * 4096);
		});
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
