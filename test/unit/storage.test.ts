import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
	admitStorage,
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
			admitStorage("run quickchr tests", { parts: [{ label: "everything", bytes: freeBytes + 1, path: getDataDir() }] }, { reclaim: false });
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
	const spies: Array<{ mockRestore(): void }> = [];
	const data = () => join(TEST_DIR, "data");
	const cache = () => join(TEST_DIR, "data", "cache");

	beforeEach(() => {
		process.env.QUICKCHR_DATA_DIR = data();
		mkdirSync(cache(), { recursive: true });
		delete process.env.QUICKCHR_STORAGE_RESERVE;
	});

	afterEach(() => {
		for (const spy of spies.splice(0)) spy.mockRestore();
		if (originalReserve === undefined) delete process.env.QUICKCHR_STORAGE_RESERVE;
		else process.env.QUICKCHR_STORAGE_RESERVE = originalReserve;
	});

	/** Free space reads come from `readings` in order; the last one repeats. */
	function freeSpace(...readings: number[]): string[] {
		const measured: string[] = [];
		let call = 0;
		spies.push(spyOn(storageProbe, "freeBytes").mockImplementation((path: string) => {
			measured.push(path);
			return readings[Math.min(call++, readings.length - 1)] as number;
		}));
		return measured;
	}

	function cachedImage(name: string, bytes: number): string {
		const path = join(cache(), name);
		writeFileSync(path, Buffer.alloc(bytes));
		const old = new Date(Date.now() - 2 * RECENT_USE_MS);
		utimesSync(path, old, old);
		return path;
	}

	const bootDisk = (bytes: number) => ({ parts: [{ label: "boot disk", bytes, path: join(data(), "machines") }] });

	test("admits when free space covers the estimate plus the 2 GiB default reserve", () => {
		freeSpace(2 * GiB + 200 * MiB);
		const old = cachedImage("chr-7.20.7.img", 1000);
		admitStorage("start CHR lab", bootDisk(200 * MiB)).release();
		expect(existsSync(old)).toBe(true);
	});

	test("a small host is admitted where the old 10 GiB floor refused it", () => {
		freeSpace(3 * GiB);
		const cold = estimateMachineCreation({ version: "7.24.5", arch: "x86", packages: true });
		expect(() => admitStorage("start CHR lab", cold).release()).not.toThrow();
	});

	test("when short, evicts the cache's oldest eligible entries, remeasures, then admits", () => {
		freeSpace(2 * GiB, 2 * GiB + 300 * MiB);
		const oldest = cachedImage("chr-7.20.7.img", 1000);
		const newer = cachedImage("chr-7.21.0.img", 1000);
		const needed = cachedImage("chr-7.24.5.img", 1000);
		const logs: string[] = [];
		admitStorage("start CHR lab", { ...bootDisk(1500), protectVersions: ["7.24.5"] }, { logger: (m: string) => logs.push(m) }).release();
		expect(existsSync(oldest)).toBe(false);
		expect(existsSync(newer)).toBe(false);
		expect(existsSync(needed)).toBe(true);
		expect(logs).toEqual(["cache: evicted chr-7.20.7.img, chr-7.21.0.img — freed 2.0 KiB"]);
	});

	test("keeps evicting against the measured shortfall when a deletion frees less than its size", () => {
		// Codex review of #203: a sparse or cloned entry can free less than its logical
		// size; the first pass meets the logical target but not the real one.
		process.env.QUICKCHR_STORAGE_RESERVE = "0";
		const measured = freeSpace(0, 1, 300);
		const first = cachedImage("chr-7.20.7.img", 200);
		const second = cachedImage("chr-7.21.0.img", 200);
		admitStorage("create", bootDisk(100)).release();
		expect(existsSync(first)).toBe(false);
		expect(existsSync(second)).toBe(false);
		expect(measured.length).toBe(3);
	});

	test("stops when a pass evicts nothing, and refuses", () => {
		process.env.QUICKCHR_STORAGE_RESERVE = "0";
		freeSpace(0);
		cachedImage("chr-7.20.7.img", 4096);
		expect(() => admitStorage("start CHR lab", bootDisk(1024))).toThrow("Evicted 1 entry from the cache (4 KiB) first.");
	});

	test("refuses with what was needed and what is kept — and evicts nothing that could not cover it", () => {
		freeSpace(GiB);
		const old = cachedImage("chr-7.20.7.img", 1000);
		writeFileSync(join(cache(), "chr-7.24.5.img"), Buffer.alloc(3000));
		try {
			admitStorage("start CHR lab", bootDisk(192 * MiB));
			expect.unreachable("should have thrown");
		} catch (error) {
			const message = (error as Error).message;
			expect((error as { code: string }).code).toBe("INSUFFICIENT_DISK_SPACE");
			expect(message).toContain(data());
			expect(message).toContain("boot disk 192 MiB + 2.0 GiB reserve");
			expect(message).toContain("The cache could spare only 1000 B (1 entry), not enough, so nothing was evicted.");
			expect(message).toContain("is kept: in use by a machine or an operation in progress, needed by this operation, or used in the last 30 minutes");
			expect((error as { installHint?: string }).installHint).toContain("storage-reserve");
		}
		expect(existsSync(old)).toBe(true);
	});

	test("reclaim: false never evicts", () => {
		freeSpace(GiB);
		const old = cachedImage("chr-7.20.7.img", 1000);
		expect(() => admitStorage("run quickchr tests", undefined, { reclaim: false })).toThrow("Not enough free space");
		expect(existsSync(old)).toBe(true);
	});

	test("QUICKCHR_STORAGE_RESERVE sets the reserve", () => {
		process.env.QUICKCHR_STORAGE_RESERVE = "512M";
		freeSpace(600 * MiB);
		expect(() => admitStorage("start CHR lab", bootDisk(64 * MiB)).release()).not.toThrow();
		expect(() => admitStorage("start CHR lab", bootDisk(128 * MiB))).toThrow("512 MiB reserve");
	});

	describe("concurrent creators share one budget (Codex review of #203)", () => {
		test("a second admission sees the first's reservation until it is released", () => {
			process.env.QUICKCHR_STORAGE_RESERVE = "0";
			freeSpace(192 * MiB);
			const first = admitStorage("prepare CHR a", bootDisk(192 * MiB));
			expect(() => admitStorage("prepare CHR b", bootDisk(192 * MiB))).toThrow("0 B available after 192 MiB held by other operations in progress");
			first.release();
			expect(() => admitStorage("prepare CHR b", bootDisk(192 * MiB)).release()).not.toThrow();
		});

		test("a check-only part is not held: the download it stands for reserves for itself", () => {
			process.env.QUICKCHR_STORAGE_RESERVE = "0";
			freeSpace(192 * MiB);
			const lease = admitStorage("prepare CHR a", { parts: [{ label: "image download", bytes: 192 * MiB, path: cache(), hold: false }] });
			expect(lease.record.reservations).toEqual([]);
			expect(() => admitStorage("cache CHR", { parts: [{ label: "image download", bytes: 192 * MiB, path: cache() }] }).release()).not.toThrow();
			lease.release();
		});

		test("a dead process's lease is ignored and removed", () => {
			process.env.QUICKCHR_STORAGE_RESERVE = "0";
			freeSpace(192 * MiB);
			const dir = join(data(), ".storage-leases");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "999999-x.json"), JSON.stringify({ pid: 999999, at: "", action: "crashed", pins: [], reservations: [{ dev: storageProbe.filesystem(data()).dev, bytes: 192 * MiB }] }));
			admitStorage("prepare CHR a", bootDisk(192 * MiB)).release();
			expect(existsSync(join(dir, "999999-x.json"))).toBe(false);
		});
	});

	describe("each filesystem is checked where it is written (Codex review of #203)", () => {
		const external = () => join(TEST_DIR, "external");

		test("measures the part's own path, not the data dir", () => {
			mkdirSync(external(), { recursive: true });
			const measured: string[] = [];
			spies.push(spyOn(storageProbe, "freeBytes").mockImplementation((path: string) => {
				measured.push(path);
				return path.startsWith(external()) ? 10 * GiB : 0;
			}));
			const victim = cachedImage("chr-7.20.img", 1000);
			admitStorage("cache packages", { parts: [{ label: "packages download", bytes: 192 * MiB, path: external() }], cacheDir: external() }).release();
			expect(measured).toEqual([external()]);
			expect(existsSync(victim)).toBe(true);
		});

		test("never reclaims a cache on another filesystem", () => {
			mkdirSync(external(), { recursive: true });
			const realFilesystem = storageProbe.filesystem;
			spies.push(spyOn(storageProbe, "filesystem").mockImplementation((path: string) => {
				const fs = realFilesystem(path);
				return path.startsWith(external()) ? { ...fs, dev: fs.dev + 1 } : fs;
			}));
			process.env.QUICKCHR_STORAGE_RESERVE = "0";
			freeSpace(0);
			// Enough to cover the shortfall, so only the filesystem check can keep it.
			const victim = cachedImage("chr-7.20.7.img", 4096);
			expect(() => admitStorage("start CHR lab", { parts: [{ label: "boot disk", bytes: 1024, path: external() }] })).toThrow(external());
			expect(existsSync(victim)).toBe(true);
		});
	});

	test("estimates a cold create as boot disk + image, and a warm one as the boot disk", () => {
		const bytes = (need: ReturnType<typeof estimateMachineCreation>) => need.parts.reduce((sum, p) => sum + p.bytes, 0);
		const cold = estimateMachineCreation({ version: "7.24.5", arch: "x86", packages: true });
		expect(bytes(cold)).toBe(STORAGE_ESTIMATES.bootDisk + STORAGE_ESTIMATES.imageDownload + STORAGE_ESTIMATES.packagesDownload);
		expect(cold.parts.filter((p) => p.hold !== false).map((p) => p.label)).toEqual(["boot disk"]);
		expect(cold.protectVersions).toEqual(["7.24.5"]);
		expect(cold.pins).toEqual(["chr-7.24.5.img", "chr-7.24.5.img.zip"]);

		cachedImage("chr-7.24.5.img", 10);
		mkdirSync(join(cache(), "packages-x86-7.24.5"));
		expect(bytes(estimateMachineCreation({ version: "7.24.5", arch: "x86", packages: true }))).toBe(STORAGE_ESTIMATES.bootDisk);
		expect(bytes(estimateMachineCreation({ version: "7.24.5", arch: "arm64", packages: false })))
			.toBe(STORAGE_ESTIMATES.bootDisk + STORAGE_ESTIMATES.imageDownload);
	});
});
