import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listCachedImages } from "../../src/lib/images.ts";

const TMP = join(import.meta.dir, ".tmp-images-test");

beforeEach(() => {
	mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
	rmSync(TMP, { recursive: true, force: true });
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
