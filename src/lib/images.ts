/**
 * Image download, ZIP extraction, and cache management.
 */

import { existsSync, copyFileSync, mkdtempSync, readdirSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";
import type { Arch } from "./types.ts";
import { QuickCHRError } from "./types.ts";
import { chrDownloadUrl, chrImageBasename } from "./versions.ts";
import { downloadToFile } from "./download.ts";
import { getCacheDir, ensureDir } from "./state.ts";
import { createLogger, type ProgressLogger } from "./log.ts";
import { extractZip } from "./zip.ts";
import { assertSufficientQuickchrStorage } from "./storage.ts";

function finalizeExtractedImage(zipPath: string, imgPath: string): string {
	if (existsSync(imgPath) && existsSync(zipPath)) {
		unlinkSync(zipPath);
	}
	return imgPath;
}

/**
 * Check that a cached raw image has a complete DOS partition table.
 *
 * RouterOS CHR images for both supported architectures use a DOS partition
 * table. Checking its signature and partition extents catches empty and
 * truncated files while avoiding a version-specific image-size assumption.
 */
export async function isUsableCachedImage(imgPath: string): Promise<boolean> {
	const file = Bun.file(imgPath);
	if (!(await file.exists()) || file.size < 512) return false;

	try {
		const sector = new Uint8Array(await file.slice(0, 512).arrayBuffer());
		if (sector[510] !== 0x55 || sector[511] !== 0xaa) return false;

		let hasPartition = false;
		for (let offset = 446; offset < 510; offset += 16) {
			const start = new DataView(sector.buffer, sector.byteOffset + offset + 8, 8);
			const firstSector = start.getUint32(0, true);
			const sectorCount = start.getUint32(4, true);
			if (sectorCount === 0) continue;
			hasPartition = true;
			const end = (firstSector + sectorCount) * 512;
			if (!Number.isSafeInteger(end) || end > file.size) return false;
		}
		return hasPartition;
	} catch {
		return false;
	}
}

/** Download a CHR image ZIP if not already cached. Returns path to the ZIP. */
export async function downloadImage(
	version: string,
	arch: Arch,
	cacheDir?: string,
	logger?: ProgressLogger,
): Promise<string> {
	const cache = cacheDir ?? getCacheDir();
	ensureDir(cache);

	const url = chrDownloadUrl(version, arch);
	const zipName = `${chrImageBasename(version, arch)}.img.zip`;
	const zipPath = join(cache, zipName);

	if (existsSync(zipPath)) {
		return zipPath;
	}

	const log = logger ?? createLogger();
	log.status(`Downloading CHR ${version} (${arch})...`);
	log.status(`  ${url}`);

	await downloadToFile(url, zipPath, { logger: log });
	return zipPath;
}

/** Extract the .img from the ZIP. Returns path to the raw .img file. */
export async function extractImage(
	zipPath: string,
	cacheDir?: string,
	logger?: ProgressLogger,
): Promise<string> {
	const cache = cacheDir ?? getCacheDir();
	ensureDir(cache);

	const imgName = basename(zipPath, ".zip");
	const imgPath = join(cache, imgName);

	if (await isUsableCachedImage(imgPath)) {
		return finalizeExtractedImage(zipPath, imgPath);
	}
	if (existsSync(imgPath)) unlinkSync(imgPath);

	const log = logger ?? createLogger();
	log.status(`Extracting: ${basename(zipPath)}`);

	const tempDir = mkdtempSync(join(cache, ".quickchr-image-"));
	try {
		extractZip(zipPath, tempDir);

		// MikroTik arm64 ZIPs may contain chr-X.Y.Z.img without the arch suffix.
		const files = readdirSync(tempDir).filter((file) => file.endsWith(".img") && file.startsWith("chr-"));
		const base = basename(zipPath, ".img.zip");
		const expected = files.find(
			(file) => file === `${base}.img` || file.replace("-arm64", "") === `${base.replace("-arm64", "")}.img`,
		);
		if (!expected) {
			throw new QuickCHRError(
				"PROCESS_FAILED",
				`Expected ${imgPath} after unzip, but not found. Files: ${files.join(", ")}`,
			);
		}

		const extractedPath = join(tempDir, expected);
		if (!(await isUsableCachedImage(extractedPath))) {
			throw new QuickCHRError("PROCESS_FAILED", `Extracted CHR image is incomplete or invalid: ${expected}`);
		}
		renameSync(extractedPath, imgPath);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}

	return finalizeExtractedImage(zipPath, imgPath);
}

/** Download and extract a CHR image. Returns path to the raw .img in cache. */
export async function ensureCachedImage(
	version: string,
	arch: Arch,
	cacheDir?: string,
	logger?: ProgressLogger,
): Promise<string> {
	const cache = cacheDir ?? getCacheDir();
	const imgPath = join(cache, `${chrImageBasename(version, arch)}.img`);
	if (await isUsableCachedImage(imgPath)) {
		const log = logger ?? createLogger();
		log.status(`  Using cached image: ${chrImageBasename(version, arch)}`);
		return imgPath;
	}
	if (existsSync(imgPath)) unlinkSync(imgPath);
	assertSufficientQuickchrStorage(`cache CHR ${version} (${arch})`);
	const zipPath = await downloadImage(version, arch, cacheDir, logger);
	const extractedImgPath = await extractImage(zipPath, cacheDir, logger);
	return finalizeExtractedImage(zipPath, extractedImgPath);
}

/** Copy a cached image to a machine's working directory as disk.img. */
export function copyImageToMachine(cachedImgPath: string, machineDir: string): string {
	ensureDir(machineDir);
	const dest = join(machineDir, "disk.img");
	copyFileSync(cachedImgPath, dest);
	return dest;
}

/** List cached images. */
export function listCachedImages(cacheDir?: string): string[] {
	const cache = cacheDir ?? getCacheDir();
	if (!existsSync(cache)) return [];
	return readdirSync(cache).filter((f) => f.endsWith(".img"));
}
