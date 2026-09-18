import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { promises as dns } from "node:dns";
import { zipSync } from "fflate";
import {
	listCachedImages,
	downloadImage,
	extractImage,
	ensureCachedImage,
	copyImageToMachine,
	isUsableCachedImage,
} from "../../src/lib/images.ts";

const TMP = join(import.meta.dir, ".tmp-images-test");

function validRawImage(): Buffer {
	const image = Buffer.alloc(1024);
	image[510] = 0x55;
	image[511] = 0xaa;
	image.writeUInt32LE(1, 454);
	image.writeUInt32LE(1, 458);
	return image;
}

beforeEach(() => {
	mkdirSync(TMP, { recursive: true });
	// Network-free: fail the public-DNS A-record lookup so fetchResilient uses
	// its fallback (a normal fetch on the original URL), which the mocked
	// globalThis.fetch stands in for. IPv4-direct fetching is covered in net.test.ts.
	spyOn(dns.Resolver.prototype, "resolve4").mockRejectedValue(
		Object.assign(new Error("test: DNS disabled"), { code: "ESERVFAIL" }),
	);
});

afterEach(() => {
	rmSync(TMP, { recursive: true, force: true });
	mock.restore();
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
	test("returns cached extracted image without invoking extraction", async () => {
		const zipPath = join(TMP, "chr-7.22.1.img.zip");
		const imgPath = join(TMP, "chr-7.22.1.img");
		writeFileSync(zipPath, "fake zip");
		writeFileSync(imgPath, validRawImage());

		const result = await extractImage(zipPath, TMP);
		expect(result).toBe(imgPath);
	});

	test("renames the extracted image when zip contains file without arm64 suffix", async () => {
		const zipPath = join(TMP, "chr-7.22.1-arm64.img.zip");
		// MikroTik sometimes ships arm64 ZIPs with chr-X.Y.Z.img (no -arm64 suffix) inside
		const image = validRawImage();
		const zipData = zipSync({ "chr-7.22.1.img": image });
		writeFileSync(zipPath, zipData);

		const result = await extractImage(zipPath, TMP);
		expect(result).toBe(join(TMP, "chr-7.22.1-arm64.img"));
		expect(existsSync(result)).toBe(true);
		expect(Array.from(readFileSync(result))).toEqual(Array.from(image));
		expect(existsSync(join(TMP, "chr-7.22.1.img"))).toBe(false);
		expect(existsSync(zipPath)).toBe(false);
	});

	test("throws PROCESS_FAILED on corrupt ZIP data", async () => {
		const zipPath = join(TMP, "chr-7.22.1.img.zip");
		writeFileSync(zipPath, "this is not a valid zip");

		await expect(extractImage(zipPath, TMP)).rejects.toMatchObject({
			code: "PROCESS_FAILED",
			message: expect.stringContaining("ZIP extraction failed"),
		});
	});

	test("throws PROCESS_FAILED when zip extracts but expected image is missing", async () => {
		const zipPath = join(TMP, "chr-7.22.1-arm64.img.zip");
		// ZIP contains a file with a completely unrelated name
		const zipData = zipSync({ "unrelated-file.txt": new TextEncoder().encode("wrong content") });
		writeFileSync(zipPath, zipData);

		await expect(extractImage(zipPath, TMP)).rejects.toMatchObject({
			code: "PROCESS_FAILED",
			message: expect.stringContaining("Expected"),
		});
	});

	test("rejects an extracted image whose partition extends beyond the file", async () => {
		const zipPath = join(TMP, "chr-7.22.1.img.zip");
		const truncated = validRawImage().subarray(0, 700);
		writeFileSync(zipPath, zipSync({ "chr-7.22.1.img": truncated }));

		await expect(extractImage(zipPath, TMP)).rejects.toMatchObject({
			code: "PROCESS_FAILED",
			message: expect.stringContaining("incomplete or invalid"),
		});
		expect(existsSync(join(TMP, "chr-7.22.1.img"))).toBe(false);
		expect(existsSync(zipPath)).toBe(true);
	});
});

describe("isUsableCachedImage", () => {
	test("requires a DOS signature and in-bounds partition", async () => {
		const path = join(TMP, "chr-7.22.1.img");
		writeFileSync(path, validRawImage());
		expect(await isUsableCachedImage(path)).toBe(true);

		writeFileSync(path, validRawImage().subarray(0, 700));
		expect(await isUsableCachedImage(path)).toBe(false);
	});
});

describe("ensureCachedImage", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("returns cached extracted image immediately when already present", async () => {
		const imgPath = join(TMP, "chr-7.22.1.img");
		writeFileSync(imgPath, validRawImage());

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
		const zipData = zipSync({ "chr-7.22.1.img": validRawImage() });
		writeFileSync(zipPath, zipData);

		let fetchCalled = false;
		globalThis.fetch = makeMockFetch(() => {
			fetchCalled = true;
			return Promise.resolve(new Response(""));
		});

		const result = await ensureCachedImage("7.22.1", "x86", TMP);
		expect(result).toBe(join(TMP, "chr-7.22.1.img"));
		expect(fetchCalled).toBe(false);
		expect(existsSync(zipPath)).toBe(false);
	});

	test("replaces a truncated image from a cached zip", async () => {
		const imgPath = join(TMP, "chr-7.22.1.img");
		const zipPath = join(TMP, "chr-7.22.1.img.zip");
		writeFileSync(imgPath, validRawImage().subarray(0, 700));
		writeFileSync(zipPath, zipSync({ "chr-7.22.1.img": validRawImage() }));
		globalThis.fetch = makeMockFetch(() => {
			throw new Error("fetch should not be called when the image ZIP is cached");
		});

		expect(await ensureCachedImage("7.22.1", "x86", TMP)).toBe(imgPath);
		expect(await isUsableCachedImage(imgPath)).toBe(true);
	});
});
