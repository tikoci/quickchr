import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { zipSync } from "fflate";
import {
	CACHE_VERSION_UNRESOLVED,
	cacheAdd,
	cacheKey,
} from "../../src/lib/cache-api.ts";
import * as publicApi from "../../src/index.ts";
import { QuickCHRError } from "../../src/lib/types.ts";

const TMP = join(import.meta.dir, ".tmp-cache-api-test");

function validRawImage(): Uint8Array {
	const image = Buffer.alloc(1024);
	image[510] = 0x55;
	image[511] = 0xaa;
	image.writeUInt32LE(1, 454);
	image.writeUInt32LE(1, 458);
	return image;
}

beforeEach(() => {
	rmSync(TMP, { recursive: true, force: true });
	mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
	rmSync(TMP, { recursive: true, force: true });
});

test("cache helpers are exported from the package entry point", () => {
	expect(publicApi.cacheAdd).toBe(cacheAdd);
	expect(publicApi.cacheKey).toBe(cacheKey);
	expect(publicApi.CACHE_VERSION_UNRESOLVED).toBe(CACHE_VERSION_UNRESOLVED);
});

describe("cacheKey", () => {
	test("an explicit version never calls the resolver", async () => {
		const fail = async () => {
			throw new Error("resolver must not be called");
		};
		expect(await cacheKey({ version: "7.24.4", arch: "x86", cacheDir: TMP }, fail)).toEqual({
			dir: TMP,
			version: "7.24.4",
			arch: "x86",
		});
	});

	test("a channel resolves to a concrete, cache-key-safe version", async () => {
		expect(await cacheKey({ channel: "stable", arch: "x86", cacheDir: TMP }, async () => "7.25beta4")).toEqual({
			dir: TMP,
			version: "7.25beta4",
			arch: "x86",
		});
	});

	test("an offline channel lookup degrades to the documented sentinel", async () => {
		expect(await cacheKey({ channel: "stable", arch: "x86", cacheDir: TMP }, async () => {
			throw new QuickCHRError("DOWNLOAD_FAILED", "offline");
		})).toEqual({ dir: TMP, version: CACHE_VERSION_UNRESOLVED, arch: "x86" });
	});

	test("an unexpected resolver bug is not hidden as a cache miss", async () => {
		await expect(cacheKey({ channel: "stable", cacheDir: TMP }, async () => {
			throw new Error("programmer bug");
		})).rejects.toThrow("programmer bug");
	});

	test("a valid-looking but oversized version cannot escape into a CI cache key", async () => {
		const oversized = `7.24.${"1".repeat(40)}`;
		expect(await cacheKey({ version: oversized, arch: "x86", cacheDir: TMP })).toEqual({
			dir: TMP,
			version: CACHE_VERSION_UNRESOLVED,
			arch: "x86",
		});
	});

	test("invalid input still fails instead of degrading", async () => {
		await expect(cacheKey({ version: "not-a-version", cacheDir: TMP })).rejects.toMatchObject({
			code: "INVALID_VERSION",
		});
		await expect(cacheKey({ version: "7.24.4", channel: "stable", cacheDir: TMP })).rejects.toThrow(/either/);
		await expect(cacheKey({ version: "", cacheDir: TMP })).rejects.toMatchObject({ code: "INVALID_VERSION" });
		await expect(cacheKey({ channel: "" as "stable", cacheDir: TMP })).rejects.toMatchObject({ code: "INVALID_VERSION" });
	});

	test("an invalid resolved version is not hidden as an offline cache miss", async () => {
		await expect(cacheKey({ channel: "stable", cacheDir: TMP }, async () => "not-a-version")).rejects.toMatchObject({
			code: "INVALID_VERSION",
		});
	});
});

describe("cacheAdd", () => {
	test("uses an existing image without QEMU, boot, or network", async () => {
		const path = join(TMP, "chr-7.24.4.img");
		await Bun.write(path, validRawImage());
		const fail = async () => {
			throw new Error("resolver must not be called");
		};

		expect(await cacheAdd({ version: "7.24.4", arch: "x86", cacheDir: TMP }, fail)).toEqual({
			dir: TMP,
			version: "7.24.4",
			arch: "x86",
			path,
			cacheHit: true,
		});
	});

	test("downloads and extracts a fresh pinned image without QEMU", async () => {
		const originalFetch = globalThis.fetch;
		const image = validRawImage();
		const zip = zipSync({ "chr-7.24.4.img": image });
		globalThis.fetch = Object.assign(
			() => Promise.resolve(new Response(zip, { status: 200 })),
			{ preconnect: (_url: string | URL) => {} },
		) as typeof fetch;
		try {
			const result = await cacheAdd({ version: "7.24.4", arch: "x86", cacheDir: TMP });
			expect(result.cacheHit).toBe(false);
			expect(Array.from(new Uint8Array(await Bun.file(result.path).arrayBuffer()))).toEqual(Array.from(image));
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("rejects an oversized version before constructing cache paths", async () => {
		await expect(cacheAdd({ version: `7.24.${"1".repeat(40)}`, cacheDir: TMP })).rejects.toMatchObject({
			code: "INVALID_VERSION",
		});
	});

	test("download errors name the resolved channel mapping", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = Object.assign(
			() => Promise.resolve(new Response("Not Found", { status: 404 })),
			{ preconnect: (_url: string | URL) => {} },
		) as typeof fetch;
		try {
			await expect(cacheAdd({ channel: "stable", arch: "x86", cacheDir: TMP }, async () => "0.0.0")).rejects.toMatchObject({
				code: "DOWNLOAD_FAILED",
				message: expect.stringContaining('channel "stable" -> 0.0.0'),
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
