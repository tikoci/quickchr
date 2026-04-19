import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { listCachedImages, downloadImage, extractImage, ensureCachedImage, copyImageToMachine } from "../../src/lib/images.ts";

const TMP = join(import.meta.dir, ".tmp-images-test");
const originalSpawnSync = Bun.spawnSync;

beforeEach(() => {
	mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
	rmSync(TMP, { recursive: true, force: true });
	Bun.spawnSync = originalSpawnSync;
});

describe("listCachedImages", () => {
	test("returns empty array when cache dir does not exist", () => {
		const result = listCachedImages(join(TMP, "does-not-exist"));
		expect(result).toEqual([]);
	});

	test("returns empty array for an empty cache dir", () => {
		expect(listCachedImages(TMP)).toEqual([]);
	});

	test("returns only .img files", () => {
		writeFileSync(join(TMP, "chr-7.22.1.img"), "");
		writeFileSync(join(TMP, "chr-7.22.1-arm64.img"), "");
		writeFileSync(join(TMP, "chr-7.22.1.img.zip"), ""); // should be excluded
		writeFileSync(join(TMP, "README.md"), ""); // should be excluded

		const result = listCachedImages(TMP).sort();
		expect(result).toEqual(["chr-7.22.1-arm64.img", "chr-7.22.1.img"]);
	});

	test("returns filenames (not full paths)", () => {
		writeFileSync(join(TMP, "chr-7.20.0.img"), "");
		const result = listCachedImages(TMP);
		expect(result[0]).toBe("chr-7.20.0.img");
		expect(result[0]).not.toContain("/");
	});
});

// --- Mock-fetch helper ---

function makeMockFetch(fn: (url: string | URL | Request, init?: RequestInit) => Promise<Response>) {
	return Object.assign(fn, { preconnect: (_url: string | URL) => {} }) as typeof fetch;
}

describe("downloadImage", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("returns cached zip path without fetching when zip already exists", async () => {
		// chr-7.22.1.img.zip is the x86 zip name
		const zipPath = join(TMP, "chr-7.22.1.img.zip");
		writeFileSync(zipPath, "dummy");

		let fetchCalled = false;
		globalThis.fetch = makeMockFetch(() => {
			fetchCalled = true;
			return Promise.resolve(new Response("", { status: 200 }));
		});

		const result = await downloadImage("7.22.1", "x86", TMP);
		expect(result).toBe(zipPath);
		expect(fetchCalled).toBe(false);
	});

	test("throws DOWNLOAD_FAILED immediately on 4xx (non-retriable)", async () => {
		globalThis.fetch = makeMockFetch(() =>
			Promise.resolve(new Response("Not Found", { status: 404 })),
		);
		await expect(downloadImage("7.22.1", "x86", TMP)).rejects.toMatchObject({
			code: "DOWNLOAD_FAILED",
		});
	});

	test("throws DOWNLOAD_FAILED after retries exhausted on 5xx", async () => {
		globalThis.fetch = makeMockFetch(() =>
			Promise.resolve(new Response("Service Unavailable", { status: 503 })),
		);
		await expect(downloadImage("7.22.1", "x86", TMP)).rejects.toMatchObject({
			code: "DOWNLOAD_FAILED",
			message: expect.stringContaining("3 attempts"),
		});
	}, 30_000);

	test("saves zip to cache dir on successful download", async () => {
		const content = new Uint8Array([1, 2, 3, 4]);
		globalThis.fetch = makeMockFetch(() =>
			Promise.resolve(new Response(content, { status: 200 })),
		);

		const result = await downloadImage("7.22.1", "x86", TMP);
		expect(result).toBe(join(TMP, "chr-7.22.1.img.zip"));
		expect(existsSync(result)).toBe(true);
	});
});

describe("copyImageToMachine", () => {
	test("copies source image to machine dir as disk.img", () => {
		const srcPath = join(TMP, "chr-7.22.1.img");
		writeFileSync(srcPath, "fake-chr-img-content");

		const machineDir = join(TMP, "machine");
		const dest = copyImageToMachine(srcPath, machineDir);

		expect(dest).toBe(join(machineDir, "disk.img"));
		expect(existsSync(dest)).toBe(true);
		expect(readFileSync(dest, "utf-8")).toBe("fake-chr-img-content");
	});
});

describe("extractImage", () => {
	test("returns cached extracted image without invoking unzip", async () => {
		const zipPath = join(TMP, "chr-7.22.1.img.zip");
		const imgPath = join(TMP, "chr-7.22.1.img");
		writeFileSync(zipPath, "fake zip");
		writeFileSync(imgPath, "already extracted");

		let unzipCalled = false;
		Bun.spawnSync = ((..._args) => {
			unzipCalled = true;
			return {
				exitCode: 0,
				success: true,
				stdout: new Uint8Array(),
				stderr: new Uint8Array(),
			} as ReturnType<typeof Bun.spawnSync>;
		}) as typeof Bun.spawnSync;

		const result = await extractImage(zipPath, TMP);
		expect(result).toBe(imgPath);
		expect(unzipCalled).toBe(false);
	});

	test("renames the extracted image when unzip output omits the arm64 suffix", async () => {
		const zipPath = join(TMP, "chr-7.22.1-arm64.img.zip");
		writeFileSync(zipPath, "fake zip");

		Bun.spawnSync = ((..._args) => {
			writeFileSync(join(TMP, "chr-7.22.1.img"), "arm64 image");
			return {
				exitCode: 0,
				success: true,
				stdout: new Uint8Array(),
				stderr: new Uint8Array(),
			} as ReturnType<typeof Bun.spawnSync>;
		}) as typeof Bun.spawnSync;

		const result = await extractImage(zipPath, TMP);
		expect(result).toBe(join(TMP, "chr-7.22.1-arm64.img"));
		expect(existsSync(result)).toBe(true);
		expect(existsSync(join(TMP, "chr-7.22.1.img"))).toBe(false);
		expect(existsSync(zipPath)).toBe(false);
	});

	test("throws PROCESS_FAILED when unzip exits non-zero", async () => {
		const zipPath = join(TMP, "chr-7.22.1.img.zip");
		writeFileSync(zipPath, "corrupt zip");

		Bun.spawnSync = ((..._args) => ({
			exitCode: 1,
			success: false,
			stdout: new Uint8Array(),
			stderr: new TextEncoder().encode("unzip: bad magic number"),
		}) as ReturnType<typeof Bun.spawnSync>) as typeof Bun.spawnSync;

		await expect(extractImage(zipPath, TMP)).rejects.toMatchObject({
			code: "PROCESS_FAILED",
			message: expect.stringContaining("unzip failed"),
		});
	});

	test("throws PROCESS_FAILED when unzip succeeds but the expected image is still missing", async () => {
		const zipPath = join(TMP, "chr-7.22.1-arm64.img.zip");
		writeFileSync(zipPath, "fake zip");

		Bun.spawnSync = ((..._args) => ({
			exitCode: 0,
			success: true,
			stdout: new Uint8Array(),
			stderr: new Uint8Array(),
		}) as ReturnType<typeof Bun.spawnSync>) as typeof Bun.spawnSync;

		await expect(extractImage(zipPath, TMP)).rejects.toMatchObject({
			code: "PROCESS_FAILED",
			message: expect.stringContaining("Expected"),
		});
	});
});

describe("ensureCachedImage", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("returns cached extracted image immediately when already present", async () => {
		const imgPath = join(TMP, "chr-7.22.1.img");
		writeFileSync(imgPath, "cached image");

		let fetchCalled = false;
		globalThis.fetch = makeMockFetch(() => {
			fetchCalled = true;
			return Promise.resolve(new Response(""));
		});

		const result = await ensureCachedImage("7.22.1", "x86", TMP);
		expect(result).toBe(imgPath);
		expect(fetchCalled).toBe(false);
	});

	test("uses a cached zip and extracts it when the image is missing", async () => {
		const zipPath = join(TMP, "chr-7.22.1.img.zip");
		writeFileSync(zipPath, "fake zip");

		let fetchCalled = false;
		globalThis.fetch = makeMockFetch(() => {
			fetchCalled = true;
			return Promise.resolve(new Response(""));
		});
		Bun.spawnSync = ((..._args) => {
			writeFileSync(join(TMP, "chr-7.22.1.img"), "fresh image");
			return {
				exitCode: 0,
				success: true,
				stdout: new Uint8Array(),
				stderr: new Uint8Array(),
			} as ReturnType<typeof Bun.spawnSync>;
		}) as typeof Bun.spawnSync;

		const result = await ensureCachedImage("7.22.1", "x86", TMP);
		expect(result).toBe(join(TMP, "chr-7.22.1.img"));
		expect(fetchCalled).toBe(false);
		expect(existsSync(zipPath)).toBe(false);
	});
});
