import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
	assertSufficientQuickchrStorage,
	estimateMachineCreation,
	formatQuickchrUsage,
	getQuickchrStorageReport,
	STORAGE_ESTIMATES,
	storageProbe,
} from "../../src/lib/storage.ts";
import { RECENT_USE_MS } from "../../src/lib/cache.ts";
import { getDataDir } from "../../src/lib/state.ts";

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
	test("measures the data dir's filesystem, at its nearest existing directory", () => {
		// HOME is TEST_DIR, where nothing of ~/.local/share/quickchr exists yet. On Windows
		// getDataDir() reads LOCALAPPDATA instead, so only the shape is asserted there.
		const report = getQuickchrStorageReport();
		expect(report.path).toBe(getDataDir());
		if (process.platform !== "win32") expect(report.statPath).toBe(TEST_DIR);
		expect(report.freeBytes).toBeGreaterThan(0);
	});

	test("uses QUICKCHR_DATA_DIR as the storage root override", () => {
		process.env.QUICKCHR_DATA_DIR = join(TEST_DIR, "custom-data");
		mkdirSync(join(TEST_DIR, "custom-data"), { recursive: true });

		const report = getQuickchrStorageReport();
		expect(report.path).toBe(join(TEST_DIR, "custom-data"));
		expect(report.statPath).toBe(join(TEST_DIR, "custom-data"));
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
			assertSufficientQuickchrStorage("run quickchr tests", { bytes: freeBytes + 1, detail: "everything" }, { reclaim: false });
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toMatchObject({
				code: "INSUFFICIENT_DISK_SPACE",
				message: expect.stringContaining("Not enough free space"),
			});
		}
	});
});

describe("storage admission (#199)", () => {
	const GiB = 1024 ** 3;
	const MiB = 1024 ** 2;
	const originalReserve = process.env.QUICKCHR_STORAGE_RESERVE;
	let probe: ReturnType<typeof spyOn> | undefined;

	beforeEach(() => {
		process.env.QUICKCHR_DATA_DIR = join(TEST_DIR, "data");
		mkdirSync(join(TEST_DIR, "data", "cache"), { recursive: true });
		delete process.env.QUICKCHR_STORAGE_RESERVE;
	});

	afterEach(() => {
		probe?.mockRestore();
		probe = undefined;
		if (originalReserve === undefined) delete process.env.QUICKCHR_STORAGE_RESERVE;
		else process.env.QUICKCHR_STORAGE_RESERVE = originalReserve;
	});

	/** Free space reads come from `readings` in order; the last one repeats. */
	function freeSpace(...readings: number[]): void {
		let call = 0;
		probe = spyOn(storageProbe, "freeBytes").mockImplementation(() => readings[Math.min(call++, readings.length - 1)] as number);
	}

	function cachedImage(name: string, bytes: number): string {
		const path = join(TEST_DIR, "data", "cache", name);
		writeFileSync(path, Buffer.alloc(bytes));
		const old = new Date(Date.now() - 2 * RECENT_USE_MS);
		utimesSync(path, old, old);
		return path;
	}

	test("admits when free space covers the estimate plus the 2 GiB default reserve", () => {
		freeSpace(2 * GiB + 200 * MiB);
		const old = cachedImage("chr-7.20.7.img", 1000);
		const report = assertSufficientQuickchrStorage("start CHR lab", { bytes: 200 * MiB, detail: "boot disk" });
		expect(report.reserveBytes).toBe(2 * GiB);
		expect(existsSync(old)).toBe(true);
	});

	test("a small host is admitted where the old 10 GiB floor refused it", () => {
		freeSpace(3 * GiB);
		expect(() => assertSufficientQuickchrStorage("start CHR lab", { bytes: STORAGE_ESTIMATES.bootDisk + STORAGE_ESTIMATES.imageDownload, detail: "cold" })).not.toThrow();
	});

	test("when short, evicts the cache's oldest eligible entries, remeasures, then admits", () => {
		freeSpace(2 * GiB, 2 * GiB + 300 * MiB);
		const oldest = cachedImage("chr-7.20.7.img", 1000);
		const newer = cachedImage("chr-7.21.0.img", 1000);
		const needed = cachedImage("chr-7.24.5.img", 1000);
		const logs: string[] = [];
		assertSufficientQuickchrStorage("start CHR lab", { bytes: 1500, detail: "boot disk", protectVersions: ["7.24.5"] }, { logger: (m) => logs.push(m) });
		expect(existsSync(oldest)).toBe(false);
		expect(existsSync(newer)).toBe(false);
		expect(existsSync(needed)).toBe(true);
		expect(logs).toEqual(["cache: evicted chr-7.20.7.img, chr-7.21.0.img — freed 2.0 KiB"]);
	});

	test("admits on the new measurement, not on the logical size it deleted", () => {
		freeSpace(2 * GiB);
		cachedImage("chr-7.20.7.img", 4096);
		expect(() => assertSufficientQuickchrStorage("start CHR lab", { bytes: 1024, detail: "boot disk" })).toThrow("Not enough free space");
	});

	test("refuses with what was needed and what is kept — and evicts nothing that could not cover it", () => {
		freeSpace(GiB);
		const old = cachedImage("chr-7.20.7.img", 1000);
		writeFileSync(join(TEST_DIR, "data", "cache", "chr-7.24.5.img"), Buffer.alloc(3000));
		try {
			assertSufficientQuickchrStorage("start CHR lab", { bytes: 192 * MiB, detail: "boot disk 192.0 MB" });
			expect.unreachable("should have thrown");
		} catch (error) {
			const message = (error as Error).message;
			expect((error as { code: string }).code).toBe("INSUFFICIENT_DISK_SPACE");
			expect(message).toContain(join(TEST_DIR, "data"));
			expect(message).toContain("boot disk 192.0 MB + 2.0 GiB reserve");
			expect(message).toContain("The cache could spare only 1000 B (1 entry), not enough, so nothing was evicted.");
			expect(message).toContain("is kept: in use by a machine, needed by this operation, or used in the last 30 minutes");
			expect((error as { installHint?: string }).installHint).toContain("storage-reserve");
		}
		expect(existsSync(old)).toBe(true);
	});

	test("a refusal after eviction says what it evicted", () => {
		freeSpace(2 * GiB);
		cachedImage("chr-7.20.7.img", 4096);
		expect(() => assertSufficientQuickchrStorage("start CHR lab", { bytes: 1024, detail: "boot disk" })).toThrow("Evicted 1 entry from the cache (4 KiB) first.");
	});

	test("reclaim: false never evicts", () => {
		freeSpace(GiB);
		const old = cachedImage("chr-7.20.7.img", 1000);
		expect(() => assertSufficientQuickchrStorage("run quickchr tests", undefined, { reclaim: false })).toThrow("Not enough free space");
		expect(existsSync(old)).toBe(true);
	});

	test("QUICKCHR_STORAGE_RESERVE sets the reserve", () => {
		process.env.QUICKCHR_STORAGE_RESERVE = "512M";
		freeSpace(600 * MiB);
		const report = assertSufficientQuickchrStorage("start CHR lab", { bytes: 64 * MiB, detail: "boot disk" });
		expect(report.reserveBytes).toBe(512 * MiB);
	});

	test("estimates a cold create as boot disk + image, and a warm one as the boot disk", () => {
		const cold = estimateMachineCreation({ version: "7.24.5", arch: "x86", packages: true });
		expect(cold.bytes).toBe(STORAGE_ESTIMATES.bootDisk + STORAGE_ESTIMATES.imageDownload + STORAGE_ESTIMATES.packagesDownload);
		expect(cold.protectVersions).toEqual(["7.24.5"]);

		cachedImage("chr-7.24.5.img", 10);
		mkdirSync(join(TEST_DIR, "data", "cache", "packages-x86-7.24.5"));
		const warm = estimateMachineCreation({ version: "7.24.5", arch: "x86", packages: true });
		expect(warm.bytes).toBe(STORAGE_ESTIMATES.bootDisk);
		expect(estimateMachineCreation({ version: "7.24.5", arch: "arm64", packages: false }).bytes)
			.toBe(STORAGE_ESTIMATES.bootDisk + STORAGE_ESTIMATES.imageDownload);
	});
});
