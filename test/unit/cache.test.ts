import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	autoPruneIfOverCap,
	listCacheEntries,
	parseCacheBasename,
	pruneCache,
} from "../../src/lib/cache.ts";
import { getCacheDir, getMachinesDir } from "../../src/lib/state.ts";

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

function writeFakeMachine(name: string, version: string, arch: "x86" | "arm64"): void {
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
		machineDir: dir,
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

describe("autoPruneIfOverCap", () => {
	test("no-op when under cap", () => {
		writeFakeImage("chr-7.22.0.img", 100);
		const result = autoPruneIfOverCap({ maxSizeBytes: 1024 });
		expect(result.evicted.length).toBe(0);
	});

	test("prunes when over cap", () => {
		writeFakeImage("chr-7.20.7.img", 1000);
		writeFakeImage("chr-7.22.0.img", 1000);
		const messages: string[] = [];
		const result = autoPruneIfOverCap({ maxSizeBytes: 1500, logger: (m) => messages.push(m) });
		expect(result.evicted.length).toBeGreaterThan(0);
		expect(messages.some((m) => m.includes("evicted"))).toBe(true);
	});

	test("never throws on errors", () => {
		expect(() => autoPruneIfOverCap({ cacheDir: "/nonexistent/path/xyz", maxSizeBytes: 0 })).not.toThrow();
	});
});
