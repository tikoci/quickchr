/**
 * Extra package download and installation for CHR instances.
 */

import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { QuickCHRError, type Arch } from "./types.ts";
import { packagesDownloadUrl } from "./versions.ts";
import { downloadToFile } from "./download.ts";
import { getCacheDir, ensureDir } from "./state.ts";
import { createLogger, type ProgressLogger } from "./log.ts";
import { restPost } from "./rest.ts";
import { scpPush } from "./scp.ts";
import { extractZip } from "./zip.ts";

const PACKAGE_CACHE_MANIFEST = ".quickchr-complete.json";

interface PackageCacheManifest {
	version: string;
	arch: Arch;
	archiveSize: number;
	packages: Array<{ name: string; size: number }>;
}

function packageFiles(extractDir: string): Array<{ name: string; size: number }> {
	try {
		return readdirSync(extractDir)
			.filter((name) => name.endsWith(".npk"))
			.map((name) => ({ name, size: statSync(join(extractDir, name)).size }))
			.filter((entry) => entry.size > 0)
			.sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		return [];
	}
}

/** Verify the archive and every package recorded after atomic extraction. */
export async function isCompletePackageCache(
	version: string,
	arch: Arch,
	cacheDir?: string,
): Promise<boolean> {
	const cache = cacheDir ?? getCacheDir();
	const zipPath = join(cache, `all_packages-${arch}-${version}.zip`);
	const extractDir = join(cache, `packages-${arch}-${version}`);
	try {
		const archiveSize = statSync(zipPath).size;
		if (archiveSize <= 0) return false;
		const manifest = await Bun.file(join(extractDir, PACKAGE_CACHE_MANIFEST)).json() as PackageCacheManifest;
		const packages = packageFiles(extractDir);
		return manifest.version === version &&
			manifest.arch === arch &&
			manifest.archiveSize === archiveSize &&
			packages.length > 0 &&
			JSON.stringify(manifest.packages) === JSON.stringify(packages);
	} catch {
		return false;
	}
}

/** Download and extract the all-packages ZIP for a version/arch. Returns the extract dir. */
export async function downloadPackages(
	version: string,
	arch: Arch,
	cacheDir?: string,
	logger?: ProgressLogger,
): Promise<string> {
	const cache = cacheDir ?? getCacheDir();
	ensureDir(cache);

	const url = packagesDownloadUrl(version, arch);
	const zipName = `all_packages-${arch}-${version}.zip`;
	const zipPath = join(cache, zipName);
	const extractDir = join(cache, `packages-${arch}-${version}`);

	if (await isCompletePackageCache(version, arch, cache)) {
		const log = logger ?? createLogger();
		log.status(`  Using cached packages: ${version} (${arch})`);
		return extractDir;
	}

	// Download if needed. Same bounded path as the image download (#116) — this
	// call site previously had neither a deadline nor retries, so its only bound
	// was whatever the calling test happened to impose.
	if (!existsSync(zipPath)) {
		const log = logger ?? createLogger();
		log.status(`Downloading packages for ${version} (${arch})...`);
		log.status(`  ${url}`);
		await downloadToFile(url, zipPath, { logger: log });
	}

	// Extract into a sibling directory, record the exact complete set, then
	// rename it into place. A killed extraction can never look like a cache hit.
	const tempDir = mkdtempSync(join(cache, ".quickchr-packages-"));
	try {
		extractZip(zipPath, tempDir);
		const packages = packageFiles(tempDir);
		if (packages.length === 0) {
			throw new Error(`No non-empty .npk files found in ${zipName}`);
		}
		const manifest: PackageCacheManifest = {
			version,
			arch,
			archiveSize: statSync(zipPath).size,
			packages,
		};
		await Bun.write(join(tempDir, PACKAGE_CACHE_MANIFEST), `${JSON.stringify(manifest, null, "\t")}\n`);
		if (existsSync(extractDir)) rmSync(extractDir, { recursive: true, force: true });
		renameSync(tempDir, extractDir);
	} catch (error) {
		rmSync(tempDir, { recursive: true, force: true });
		if (error instanceof Error && error.message.startsWith("No non-empty")) {
			throw new QuickCHRError("PROCESS_FAILED", error.message);
		}
		throw error;
	}

	if (!(await isCompletePackageCache(version, arch, cache))) {
		throw new QuickCHRError(
			"PROCESS_FAILED",
			`Package cache verification failed for ${version} (${arch})`,
		);
	}

	return extractDir;
}

/** Find the .npk file for a specific package in the extracted packages dir. */
export function findPackageFile(
	extractDir: string,
	packageName: string,
): string | undefined {
	if (!existsSync(extractDir)) return undefined;

	const files = readdirSync(extractDir);
	// Package files are named like: container-7.22.1-arm64.npk or iot-7.22.1-arm64.npk
	// Check that the char after "name-" is a digit (version), not more name letters.
	// e.g. "iot-" must NOT match "iot-bt-extra-7.22.1-arm64.npk"
	const prefix = packageName + "-";
	const match = files.find(
		(f) => f.startsWith(prefix) && f.endsWith(".npk") && /^\d/.test(f.slice(prefix.length)),
	);
	return match ? join(extractDir, match) : undefined;
}

/** Upload packages to a running CHR via SCP. Uploads each file to flash root (`/<basename>`). */
export async function uploadPackages(
	packagePaths: string[],
	sshPort: number,
	user: string = "admin",
	password: string = "",
	logger?: ProgressLogger,
): Promise<void> {
	const log = logger ?? createLogger();
	for (const pkgPath of packagePaths) {
		const filename = basename(pkgPath);
		log.status(`Uploading: ${filename}`);
		await scpPush(pkgPath, undefined, { sshPort, user, password });
	}
}

/** Install extra packages: download, extract, upload, reboot.
 *  Returns the names of packages that were actually found and uploaded. */
export async function installPackages(
	packages: string[],
	version: string,
	arch: Arch,
	sshPort: number,
	httpPort: number,
	logger?: ProgressLogger,
): Promise<string[]> {
	if (packages.length === 0) return [];


	const log = logger ?? createLogger();
	const extractDir = await downloadPackages(version, arch, undefined, logger);

	const packagePaths: string[] = [];
	const installed: string[] = [];
	for (const pkg of packages) {
		const pkgPath = findPackageFile(extractDir, pkg);
		if (!pkgPath) {
			log.warn(`Package "${pkg}" not found in all_packages for ${version} (${arch})`);
			continue;
		}
		packagePaths.push(pkgPath);
		installed.push(pkg);
	}

	if (packagePaths.length === 0) return [];

	await uploadPackages(packagePaths, sshPort, undefined, undefined, logger);

	// Reboot to activate packages
	log.status("Rebooting CHR to activate packages...");
	try {
		await restPost(
			`http://127.0.0.1:${httpPort}/rest/system/reboot`,
			`Basic ${btoa("admin:")}`,
			{},
			5000,
		);
	} catch {
		// Expected — connection drops during reboot
	}

	return installed;
}

/** List all package names available in an extracted all_packages directory.
 *  Parses .npk filenames: "container-7.22.1-arm64.npk" → "container". */
export function listAvailablePackages(extractDir: string): string[] {
	if (!existsSync(extractDir)) return [];
	const nameRe = /^(.+?)-\d+\.\d+/;
	return readdirSync(extractDir)
		.filter((f) => f.endsWith(".npk"))
		.map((f) => nameRe.exec(f)?.[1] ?? "")
		.filter(Boolean)
		.sort();
}

/** Download the all_packages ZIP and return the list of available packages.
 *  Caches the extraction — subsequent calls return immediately. */
export async function downloadAndListPackages(
	version: string,
	arch: Arch,
): Promise<string[]> {
	const extractDir = await downloadPackages(version, arch);
	return listAvailablePackages(extractDir);
}

/** Download all packages and install every one of them. Useful for API schema generation.
 *  Returns the names of packages that were installed. */
export async function installAllPackages(
	version: string,
	arch: Arch,
	sshPort: number,
	httpPort: number,
	logger?: ProgressLogger,
): Promise<string[]> {
	const log = logger ?? createLogger();
	const extractDir = await downloadPackages(version, arch, undefined, logger);
	const allPkgs = listAvailablePackages(extractDir);
	if (allPkgs.length === 0) return [];
	log.status(`Installing all ${allPkgs.length} packages: ${allPkgs.join(", ")}`);
	return installPackages(allPkgs, version, arch, sshPort, httpPort, logger);
}
