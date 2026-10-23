import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	autoPruneIfOverCap,
	cacheInventory,
	formatSizeBytes,
	RECENT_USE_MS,
	listCacheEntries,
	parseCacheBasename,
	parseSizeString,
	pruneCache,
} from "../../src/lib/cache.ts";
import { getCacheDir, getMachinesDir } from "../../src/lib/state.ts";
import { pinCacheEntries } from "../../src/lib/storage-lease.ts";
import { QuickCHRError } from "../../src/lib/types.ts";

const TEST_DIR = join(import.meta.dir, ".tmp-cache-test");
const origDataDir = process.env.QUICKCHR_DATA_DIR;
const origHome = process.env.HOME;

function writeFakeImage(name: string, sizeBytes: number): string {
	const cacheDir = getCacheDir();
	mkdirSync(cacheDir, { recursive: true });
	const full = join(cacheDir, name);
	writeFileSync(full, Buffer.alloc(sizeBytes));
	return full;
}

/** Make a cache entry look last used `ageMs` ago. */
function backdate(path: string, ageMs: number = 2 * RECENT_USE_MS): void {
	const when = new Date(Date.now() - ageMs);
	utimesSync(path, when, when);
}

/** An all-packages archive and its extraction, as packages.ts leaves them. */
function writeFakePackages(arch: "x86" | "arm64", version: string, zipBytes: number, npkBytes: number): void {
	const cacheDir = getCacheDir();
	mkdirSync(join(cacheDir, `packages-${arch}-${version}`), { recursive: true });
	writeFileSync(join(cacheDir, `all_packages-${arch}-${version}.zip`), Buffer.alloc(zipBytes));
	writeFileSync(join(cacheDir, `packages-${arch}-${version}`, `container-${version}.npk`), Buffer.alloc(npkBytes));
}

function writeFakeMachine(name: string, version: string, arch: "x86" | "arm64", extra: Record<string, unknown> = {}): void {
	const dir = join(getMachinesDir(), name);
	mkdirSync(dir, { recursive: true });
	const state = {
		name,
		version,
		arch,
		cpu: 1,
		mem: 512,
		networks: [{ specifier: "user", id: "net0" }],
		ports: {},
		packages: [],
		portBase: 9100,
		excludePorts: [],
		extraPorts: [],
		createdAt: new Date().toISOString(),
		status: "stopped",
		machineDir: dir,
		...extra,
	};
	writeFileSync(join(dir, "machine.json"), JSON.stringify(state, null, "\t"));
}

beforeEach(() => {
	process.env.QUICKCHR_DATA_DIR = TEST_DIR;
	process.env.HOME = TEST_DIR;
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	if (origDataDir === undefined) delete process.env.QUICKCHR_DATA_DIR;
	else process.env.QUICKCHR_DATA_DIR = origDataDir;
	if (origHome === undefined) delete process.env.HOME;
	else process.env.HOME = origHome;
});

describe("parseCacheBasename", () => {
	test("parses x86 .img", () => {
		expect(parseCacheBasename("chr-7.20.7.img")).toEqual({ version: "7.20.7", arch: "x86" });
	});
	test("parses arm64 .img", () => {
		expect(parseCacheBasename("chr-7.22.0-arm64.img")).toEqual({ version: "7.22.0", arch: "arm64" });
	});
	test("parses .img.zip", () => {
		expect(parseCacheBasename("chr-7.21.0.img.zip")).toEqual({ version: "7.21.0", arch: "x86" });
	});
	test("parses two-part version", () => {
		expect(parseCacheBasename("chr-7.22.img")).toEqual({ version: "7.22", arch: "x86" });
	});
	test("parses beta", () => {
		expect(parseCacheBasename("chr-7.23beta2-arm64.img")).toEqual({ version: "7.23beta2", arch: "arm64" });
	});
	test("returns unknown for garbage", () => {
		expect(parseCacheBasename("not-a-chr.img")).toEqual({ version: "unknown", arch: "unknown" });
	});
	test("returns unknown for missing chr- prefix", () => {
		expect(parseCacheBasename("7.22.0.img")).toEqual({ version: "unknown", arch: "unknown" });
	});
});

describe("listCacheEntries", () => {
	test("returns empty for missing cache dir", () => {
		expect(listCacheEntries()).toEqual([]);
	});

	test("lists parsed entries", () => {
		writeFakeImage("chr-7.20.7.img", 100);
		writeFakeImage("chr-7.22.0-arm64.img", 200);
		writeFakeImage("README.txt", 10); // ignored
		const entries = listCacheEntries();
		expect(entries.length).toBe(2);
		const versions = entries.map((e) => e.version).sort();
		expect(versions).toEqual(["7.20.7", "7.22.0"]);
		const arm = entries.find((e) => e.version === "7.22.0");
		expect(arm?.arch).toBe("arm64");
	});

	test("marks in-use images", () => {
		writeFakeImage("chr-7.20.8.img", 100);
		writeFakeImage("chr-7.21.0.img", 100);
		writeFakeMachine("test1", "7.20.8", "x86");
		const entries = listCacheEntries();
		const used = entries.find((e) => e.version === "7.20.8");
		const unused = entries.find((e) => e.version === "7.21.0");
		expect(used?.inUse).toBe(true);
		expect(unused?.inUse).toBe(false);
	});
});

describe("pruneCache", () => {
	test("evicts oldest version first under size cap", () => {
		writeFakeImage("chr-7.20.7.img", 1000);
		writeFakeImage("chr-7.21.0.img", 1000);
		writeFakeImage("chr-7.22.0.img", 1000);
		const result = pruneCache({ maxSizeBytes: 2000 });
		expect(result.evicted.length).toBe(1);
		expect(result.evicted[0]?.version).toBe("7.20.7");
		expect(existsSync(join(getCacheDir(), "chr-7.20.7.img"))).toBe(false);
		expect(existsSync(join(getCacheDir(), "chr-7.22.0.img"))).toBe(true);
	});

	test("protectVersions keeps protected entry over cap", () => {
		writeFakeImage("chr-7.20.7.img", 1000);
		writeFakeImage("chr-7.22.0.img", 1000);
		const result = pruneCache({ maxSizeBytes: 500, protectVersions: ["7.22.0"] });
		const evictedVersions = result.evicted.map((e) => e.version);
		expect(evictedVersions).toContain("7.20.7");
		expect(evictedVersions).not.toContain("7.22.0");
		expect(existsSync(join(getCacheDir(), "chr-7.22.0.img"))).toBe(true);
	});

	test("dryRun does not delete files", () => {
		writeFakeImage("chr-7.20.7.img", 1000);
		writeFakeImage("chr-7.22.0.img", 1000);
		const result = pruneCache({ maxSizeBytes: 500, dryRun: true });
		expect(result.evicted.length).toBeGreaterThan(0);
		expect(existsSync(join(getCacheDir(), "chr-7.20.7.img"))).toBe(true);
		expect(existsSync(join(getCacheDir(), "chr-7.22.0.img"))).toBe(true);
	});

	test("olderThan evicts entries with version < threshold", () => {
		writeFakeImage("chr-7.20.7.img", 100);
		writeFakeImage("chr-7.20.8.img", 100);
		writeFakeImage("chr-7.21.0.img", 100);
		writeFakeImage("chr-7.22.0.img", 100);
		const result = pruneCache({ olderThan: "7.21.0" });
		const evictedVersions = result.evicted.map((e) => e.version).sort();
		expect(evictedVersions).toEqual(["7.20.7", "7.20.8"]);
		expect(existsSync(join(getCacheDir(), "chr-7.21.0.img"))).toBe(true);
		expect(existsSync(join(getCacheDir(), "chr-7.22.0.img"))).toBe(true);
	});

	test("never evicts in-use entries even when over cap", () => {
		writeFakeImage("chr-7.20.7.img", 1000);
		writeFakeImage("chr-7.20.8.img", 1000);
		writeFakeMachine("inuse", "7.20.8", "x86");
		const result = pruneCache({ maxSizeBytes: 500 });
		const inUseEntry = result.kept.find((e) => e.version === "7.20.8");
		expect(inUseEntry?.inUse).toBe(true);
		expect(existsSync(join(getCacheDir(), "chr-7.20.8.img"))).toBe(true);
	});

	test("returns empty result when no policy options provided", () => {
		writeFakeImage("chr-7.20.7.img", 1000);
		const result = pruneCache({});
		expect(result.evicted.length).toBe(0);
		expect(result.kept.length).toBe(1);
	});
});

describe("cache inventory (#199)", () => {
	test("a package archive and its extraction are one entry, sized and deleted together", () => {
		writeFakePackages("x86", "7.24.5", 300, 200);
		const [entry] = listCacheEntries();
		expect(entry).toMatchObject({ basename: "packages-x86-7.24.5", kind: "packages", version: "7.24.5", arch: "x86", sizeBytes: 500, inUse: false });
		expect(entry?.paths.sort()).toEqual([
			join(getCacheDir(), "all_packages-x86-7.24.5.zip"),
			join(getCacheDir(), "packages-x86-7.24.5"),
		]);

		const result = pruneCache({ maxSizeBytes: 0 });
		expect(result.freedBytes).toBe(500);
		expect(existsSync(join(getCacheDir(), "all_packages-x86-7.24.5.zip"))).toBe(false);
		expect(existsSync(join(getCacheDir(), "packages-x86-7.24.5"))).toBe(false);
	});

	test("packages are in use only until the first boot that installs them is stamped done", () => {
		writeFakePackages("x86", "7.24.5", 100, 100);
		writeFakeMachine("pending", "7.24.5", "x86", { packages: ["container"] });
		expect(listCacheEntries().find((e) => e.kind === "packages")?.inUse).toBe(true);

		writeFakeMachine("pending", "7.24.5", "x86", { packages: ["container"], provisioning: { at: new Date().toISOString(), steps: ["packages"] } });
		expect(listCacheEntries().find((e) => e.kind === "packages")?.inUse).toBe(false);
	});

	test("the image is still in use by a provisioned machine: clean rebuilds from it", () => {
		writeFakeImage("chr-7.24.5.img", 100);
		writeFakeMachine("done", "7.24.5", "x86", { provisioning: { at: new Date().toISOString(), steps: [] } });
		expect(listCacheEntries()[0]?.inUse).toBe(true);
	});

	test("an interrupted download is a partial entry, live while its writer is, and goes first", () => {
		backdate(writeFakeImage("chr-7.20.7.img", 1000));
		backdate(writeFakeImage("chr-7.24.5.img.zip.999999-0a1b2c3d.part", 400));
		writeFakeImage(`chr-7.26.img.zip.${process.pid}-0a1b2c3d.part`, 400);

		const entries = listCacheEntries();
		expect(entries.find((e) => e.basename.startsWith("chr-7.24.5"))).toMatchObject({ kind: "partial", version: "7.24.5", inUse: false });
		expect(entries.find((e) => e.basename.startsWith("chr-7.26"))).toMatchObject({ kind: "partial", inUse: true });

		const result = pruneCache({ reclaimBytes: 1 });
		expect(result.evicted.map((e) => e.basename)).toEqual(["chr-7.24.5.img.zip.999999-0a1b2c3d.part"]);
		expect(result.reasons[`chr-7.26.img.zip.${process.pid}-0a1b2c3d.part`]).toBe("in progress");
	});

	test("names that only resemble quickchr's are not managed (Codex review of #203)", () => {
		const cacheDir = getCacheDir();
		mkdirSync(join(cacheDir, "packages-x86-notes"), { recursive: true });
		writeFileSync(join(cacheDir, "packages-x86-notes", "notes.txt"), "a user's notes");
		writeFileSync(join(cacheDir, "packages-x86-7.24.5.zip"), "a file under the directory's name");
		writeFileSync(join(cacheDir, "all_packages-x86-notes.zip"), "x");
		writeFileSync(join(cacheDir, "backup.2147483647-dead.part"), "an unrelated partial backup");
		mkdirSync(join(cacheDir, ".quickchr-image-file"));
		writeFileSync(join(cacheDir, ".quickchr-packages-file"), "a file, not an extraction dir");
		for (const name of readdirSync(cacheDir)) backdate(join(cacheDir, name));

		const inventory = cacheInventory();
		expect(inventory.entries.map((e) => e.basename)).toEqual([".quickchr-image-file"]);
		pruneCache({ maxSizeBytes: 0 });
		for (const name of ["packages-x86-notes", "packages-x86-7.24.5.zip", "all_packages-x86-notes.zip", "backup.2147483647-dead.part", ".quickchr-packages-file"]) {
			expect(existsSync(join(cacheDir, name))).toBe(true);
		}
	});

	test("files quickchr did not write are counted, never deleted", () => {
		writeFakeImage("notes.txt", 123);
		writeFakeImage("chr-garbage.img", 7);
		const inventory = cacheInventory();
		expect(inventory.entries).toEqual([]);
		expect(inventory.unmanagedBytes).toBe(130);
		pruneCache({ maxSizeBytes: 0 });
		expect(existsSync(join(getCacheDir(), "notes.txt"))).toBe(true);
	});
});

describe("pins from operations in progress (Codex review of #203)", () => {
	/** A child process that pins `pins`, prints "pinned", and holds them until killed. */
	async function pinInChild(pins: string[]) {
		const lease = join(import.meta.dir, "../../src/lib/storage-lease.ts");
		const child = Bun.spawn([process.execPath, "-e", `
			import { pinCacheEntries } from ${JSON.stringify(lease)};
			pinCacheEntries("test reader", ${JSON.stringify(pins)});
			console.log("pinned");
			setInterval(() => {}, 1000);
		`], { env: process.env, stdout: "pipe", stderr: "inherit" });
		const reader = child.stdout.getReader();
		const { value } = await reader.read();
		expect(new TextDecoder().decode(value)).toContain("pinned");
		return child;
	}

	test("an entry another process has pinned is not evicted, and is shown in use", async () => {
		backdate(writeFakeImage("chr-7.20.7.img", 1000));
		backdate(writeFakeImage("chr-7.22.0.img", 1000));
		const child = await pinInChild(["chr-7.20.7.img"]);
		try {
			expect(listCacheEntries().find((e) => e.basename === "chr-7.20.7.img")?.inUse).toBe(true);
			const result = pruneCache({ maxSizeBytes: 0 });
			expect(result.evicted.map((e) => e.basename)).toEqual(["chr-7.22.0.img"]);
			expect(result.reasons["chr-7.20.7.img"]).toBe("in use");
		} finally {
			child.kill();
			await child.exited;
		}
		// Once the reader is gone, so is its pin.
		expect(pruneCache({ maxSizeBytes: 0 }).evicted.map((e) => e.basename)).toEqual(["chr-7.20.7.img"]);
	});

	test("pinning waits for an eviction pass in progress, so it is seen or comes after", async () => {
		const lease = join(import.meta.dir, "../../src/lib/storage-lease.ts");
		const child = Bun.spawn([process.execPath, "-e", `
			import { withStorageLock } from ${JSON.stringify(lease)};
			withStorageLock(() => { console.log("locked"); Bun.sleepSync(600); });
		`], { env: process.env, stdout: "pipe", stderr: "inherit" });
		try {
			const { value } = await child.stdout.getReader().read();
			expect(new TextDecoder().decode(value)).toContain("locked");
			const started = Date.now();
			pinCacheEntries("test reader", ["chr-7.20.7.img"]).release();
			expect(Date.now() - started).toBeGreaterThanOrEqual(300);
		} finally {
			await child.exited;
		}
	});
});

describe("pruneCache reclaimBytes (#199)", () => {
	test("evicts oldest version first until the target is met, then stops", () => {
		writeFakeImage("chr-7.20.7.img", 1000);
		writeFakeImage("chr-7.21.0.img", 1000);
		writeFakeImage("chr-7.22.0.img", 1000);
		const result = pruneCache({ reclaimBytes: 1500 });
		expect(result.evicted.map((e) => e.version)).toEqual(["7.20.7", "7.21.0"]);
		expect(result.freedBytes).toBe(2000);
		expect(existsSync(join(getCacheDir(), "chr-7.22.0.img"))).toBe(true);
	});

	test("skipRecentMs keeps recently used entries", () => {
		writeFakeImage("chr-7.20.7.img", 1000);
		backdate(writeFakeImage("chr-7.22.0.img", 1000));
		const result = pruneCache({ reclaimBytes: 5000, skipRecentMs: RECENT_USE_MS });
		expect(result.evicted.map((e) => e.version)).toEqual(["7.22.0"]);
		expect(result.reasons["chr-7.20.7.img"]).toBe("used recently");
	});

	test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"a failed delete is reported as failed, not as freed",
		() => {
			writeFakeImage("chr-7.20.7.img", 1000);
			chmodSync(getCacheDir(), 0o555);
			try {
				const result = pruneCache({ maxSizeBytes: 0 });
				expect(result.evicted).toEqual([]);
				expect(result.freedBytes).toBe(0);
				expect(result.failed.map((f) => f.entry.basename)).toEqual(["chr-7.20.7.img"]);
				expect(result.reasons["chr-7.20.7.img"]).toStartWith("delete failed:");
			} finally {
				chmodSync(getCacheDir(), 0o755);
			}
			expect(existsSync(join(getCacheDir(), "chr-7.20.7.img"))).toBe(true);
		},
	);
});

describe("autoPruneIfOverCap", () => {
	test("no-op when under cap", () => {
		writeFakeImage("chr-7.22.0.img", 100);
		const result = autoPruneIfOverCap({ maxSizeBytes: 1024 });
		expect(result.evicted.length).toBe(0);
	});

	test("prunes when over cap", () => {
		backdate(writeFakeImage("chr-7.20.7.img", 1000));
		backdate(writeFakeImage("chr-7.22.0.img", 1000));
		const messages: string[] = [];
		const result = autoPruneIfOverCap({ maxSizeBytes: 1500, logger: (m) => messages.push(m) });
		expect(result.evicted.length).toBeGreaterThan(0);
		expect(messages.some((m) => m.includes("evicted"))).toBe(true);
	});

	test("leaves entries used in the last RECENT_USE_MS alone, even over cap", () => {
		writeFakeImage("chr-7.20.7.img", 1000);
		backdate(writeFakeImage("chr-7.22.0.img", 1000));
		const result = autoPruneIfOverCap({ maxSizeBytes: 500 });
		expect(result.evicted.map((e) => e.basename)).toEqual(["chr-7.22.0.img"]);
		expect(result.reasons["chr-7.20.7.img"]).toBe("used recently");
		expect(existsSync(join(getCacheDir(), "chr-7.20.7.img"))).toBe(true);
	});

	test("names what it evicted", () => {
		backdate(writeFakeImage("chr-7.20.7.img", 1000));
		backdate(writeFakeImage("chr-7.22.0.img", 1000));
		const messages: string[] = [];
		autoPruneIfOverCap({ maxSizeBytes: 1500, logger: (m) => messages.push(m) });
		expect(messages).toEqual(["cache: evicted chr-7.20.7.img — freed 1000 B"]);
	});

	test("never throws on errors", () => {
		expect(() => autoPruneIfOverCap({ cacheDir: "/nonexistent/path/xyz", maxSizeBytes: 0 })).not.toThrow();
	});
});

describe("parseSizeString", () => {
	test("parses plain integers as bytes", () => {
		expect(parseSizeString("1024")).toBe(1024);
	});

	test("parses K/M/G/T suffixes as IEC binary units", () => {
		expect(parseSizeString("512M")).toBe(512 * 1024 ** 2);
		expect(parseSizeString("2G")).toBe(2 * 1024 ** 3);
		expect(parseSizeString("1T")).toBe(1024 ** 4);
	});

	test("parses fractional sizes, flooring to an integer byte count", () => {
		expect(parseSizeString("1.5G")).toBe(Math.floor(1.5 * 1024 ** 3));
	});

	test("is case-insensitive and tolerates trailing i/B (KiB, GB, etc.)", () => {
		expect(parseSizeString("2g")).toBe(2 * 1024 ** 3);
		expect(parseSizeString("2GiB")).toBe(2 * 1024 ** 3);
		expect(parseSizeString("2GB")).toBe(2 * 1024 ** 3);
	});

	test("throws on an invalid size string", () => {
		expect(() => parseSizeString("not-a-size")).toThrow(QuickCHRError);
		expect(() => parseSizeString("2X")).toThrow(QuickCHRError);
		try {
			parseSizeString("2X");
			throw new Error("should have thrown");
		} catch (e) {
			expect((e as QuickCHRError).code).toBe("INVALID_SIZE_STRING");
		}
	});
});

describe("formatSizeBytes", () => {
	test("formats byte and exact IEC thresholds", () => {
		expect(formatSizeBytes(1023)).toBe("1023 B");
		expect(formatSizeBytes(1024)).toBe("1.0 KiB");
		expect(formatSizeBytes(1024 ** 2)).toBe("1.0 MiB");
		expect(formatSizeBytes(1024 ** 3)).toBe("1.00 GiB");
	});

	test("rounds non-exact KiB/MiB/GiB values using the display precision", () => {
		expect(formatSizeBytes(1536)).toBe("1.5 KiB");
		expect(formatSizeBytes(Math.floor(1.25 * 1024 ** 2))).toBe("1.3 MiB");
		expect(formatSizeBytes(Math.floor(2.346 * 1024 ** 3))).toBe("2.35 GiB");
	});
});
