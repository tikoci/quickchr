/**
 * Image download, ZIP extraction, and cache management.
 */

import { existsSync, copyFileSync, readdirSync, renameSync } from "node:fs";
import { join, basename } from "node:path";
import type { Arch } from "./types.ts";
import { QuickCHRError } from "./types.ts";
import { chrDownloadUrl, chrImageBasename } from "./versions.ts";
import { getCacheDir, ensureDir } from "./state.ts";

/** Download a CHR image ZIP if not already cached. Returns path to the ZIP. */
export async function downloadImage(
	version: string,
	arch: Arch,
	cacheDir?: string,
): Promise<string> {
	const cache = cacheDir ?? getCacheDir();
	ensureDir(cache);

	const url = chrDownloadUrl(version, arch);
	const zipName = `${chrImageBasename(version, arch)}.img.zip`;
	const zipPath = join(cache, zipName);

	if (existsSync(zipPath)) {
		return zipPath;
	}

	console.log(`Downloading CHR ${version} (${arch})...`);
	console.log(`  ${url}`);

	const MAX_RETRIES = 3;
	let lastError: Error | undefined;

	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
			// Non-retriable: client errors except 408 (request timeout) and 429
			// (rate limited), which can be transient on CDNs.
			if (response.status >= 400 && response.status < 500
					&& response.status !== 408 && response.status !== 429) {
				throw new QuickCHRError(
					"DOWNLOAD_FAILED",
					`Download failed: HTTP ${response.status} for ${url}`,
				);
			}
			if (!response.ok) {
				lastError = new Error(`HTTP ${response.status}`);
			} else {
				// Stream to disk via arrayBuffer (Bun.write with Response can hang on large files)
				const buf = await response.arrayBuffer();
				await Bun.write(zipPath, buf);
				console.log(`  Saved (${(buf.byteLength / 1024 / 1024).toFixed(1)} MB)`);
				return zipPath;
			}
		} catch (e) {
			if (e instanceof QuickCHRError) throw e;
			lastError = e instanceof Error ? e : new Error(String(e));
		}
		if (attempt < MAX_RETRIES) {
			console.log(`  Download failed (attempt ${attempt}/${MAX_RETRIES}), retrying in ${attempt * 2}s...`);
			await Bun.sleep(attempt * 2000);
		}
	}

	throw new QuickCHRError(
		"DOWNLOAD_FAILED",
		`Download failed after ${MAX_RETRIES} attempts: ${lastError?.message ?? "unknown error"}`,
	);
}

/** Extract the .img from the ZIP. Returns path to the raw .img file. */
export async function extractImage(
	zipPath: string,
	cacheDir?: string,
): Promise<string> {
	const cache = cacheDir ?? getCacheDir();
	ensureDir(cache);

	const imgName = basename(zipPath, ".zip");
	const imgPath = join(cache, imgName);

	if (existsSync(imgPath)) {
		return imgPath;
	}

	console.log(`Extracting: ${basename(zipPath)}`);

	const result = Bun.spawnSync(["unzip", "-o", zipPath, "-d", cache], {
		stdout: "pipe",
		stderr: "pipe",
	});

	if (result.exitCode !== 0) {
		const stderr = new TextDecoder().decode(result.stderr);
		throw new QuickCHRError("PROCESS_FAILED", `unzip failed: ${stderr}`, "Install unzip");
	}

	// MikroTik x86 ZIPs contain chr-X.Y.Z.img (no arch suffix).
	// Our ZIP is named chr-X.Y.Z.img.zip (without -x86 for x86). Check if we need to
	// find the extracted file.
	if (!existsSync(imgPath)) {
		const files = readdirSync(cache).filter(
			(f) => f.endsWith(".img") && f.startsWith("chr-"),
		);
		// Find the one that was just extracted (matching version)
		const expected = files.find((f) => {
			const base = basename(zipPath, ".img.zip");
			// chr-7.22.1.img matches chr-7.22.1.img.zip
			return f === base + ".img" || f.replace("-arm64", "") === base.replace("-arm64", "") + ".img";
		});
		if (expected) {
			const extractedPath = join(cache, expected);
			if (extractedPath !== imgPath) {
				renameSync(extractedPath, imgPath);
			}
		} else {
			throw new QuickCHRError(
				"PROCESS_FAILED",
				`Expected ${imgPath} after unzip, but not found. Files: ${files.join(", ")}`,
			);
		}
	}

	return imgPath;
}

/** Download and extract a CHR image. Returns path to the raw .img in cache. */
export async function ensureCachedImage(
	version: string,
	arch: Arch,
	cacheDir?: string,
): Promise<string> {
	const cache = cacheDir ?? getCacheDir();
	const imgPath = join(cache, `${chrImageBasename(version, arch)}.img`);
	if (existsSync(imgPath)) {
		console.log(`  Using cached image: ${chrImageBasename(version, arch)}`);
		return imgPath;
	}
	const zipPath = await downloadImage(version, arch, cacheDir);
	return extractImage(zipPath, cacheDir);
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
