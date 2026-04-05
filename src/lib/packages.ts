/**
 * Extra package download and installation for CHR instances.
 */

import { existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import type { Arch } from "./types.ts";
import { QuickCHRError } from "./types.ts";
import { packagesDownloadUrl } from "./versions.ts";
import { getCacheDir, ensureDir } from "./state.ts";

/** Download and extract the all-packages ZIP for a version/arch. Returns the extract dir. */
export async function downloadPackages(
	version: string,
	arch: Arch,
	cacheDir?: string,
): Promise<string> {
	const cache = cacheDir ?? getCacheDir();
	ensureDir(cache);

	const url = packagesDownloadUrl(version, arch);
	const zipName = `all_packages-${arch}-${version}.zip`;
	const zipPath = join(cache, zipName);
	const extractDir = join(cache, `packages-${arch}-${version}`);

	if (existsSync(extractDir)) {
		return extractDir;
	}

	// Download if needed
	if (!existsSync(zipPath)) {
		console.log(`Downloading packages for ${version} (${arch})...`);
		const response = await fetch(url);
		if (!response.ok) {
			throw new QuickCHRError(
				"DOWNLOAD_FAILED",
				`Failed to download packages: HTTP ${response.status} for ${url}`,
			);
		}
		const buf = await response.arrayBuffer();
		await Bun.write(zipPath, buf);
	}

	// Extract
	ensureDir(extractDir);
	const result = Bun.spawnSync(["unzip", "-o", zipPath, "-d", extractDir], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new QuickCHRError(
			"PROCESS_FAILED",
			`Failed to extract packages: ${new TextDecoder().decode(result.stderr)}`,
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
	const match = files.find(
		(f) => f.startsWith(packageName + "-") && f.endsWith(".npk"),
	);
	return match ? join(extractDir, match) : undefined;
}

/** Upload packages to a running CHR via SCP. */
export async function uploadPackages(
	packagePaths: string[],
	sshPort: number,
	user: string = "admin",
	password: string = "",
): Promise<void> {
	for (const pkgPath of packagePaths) {
		const filename = basename(pkgPath);
		console.log(`Uploading: ${filename}`);

		// Use sshpass for password auth, or plain scp for key auth
		const scpArgs = password
			? [
				"sshpass", "-p", password,
				"scp", "-P", String(sshPort),
				"-o", "StrictHostKeyChecking=accept-new",
				"-o", "UserKnownHostsFile=/dev/null",
				pkgPath, `${user}@127.0.0.1:/`,
			]
			: [
				"scp", "-P", String(sshPort),
				"-o", "StrictHostKeyChecking=accept-new",
				"-o", "UserKnownHostsFile=/dev/null",
				"-o", "BatchMode=yes",
				pkgPath, `${user}@127.0.0.1:/`,
			];

		const result = Bun.spawnSync(scpArgs, {
			stdout: "pipe",
			stderr: "pipe",
		});

		if (result.exitCode !== 0) {
			const stderr = new TextDecoder().decode(result.stderr);
			throw new QuickCHRError(
				"PROCESS_FAILED",
				`SCP upload failed for ${filename}: ${stderr}`,
			);
		}
	}
}

/** Install extra packages: download, extract, upload, reboot. */
export async function installPackages(
	packages: string[],
	version: string,
	arch: Arch,
	sshPort: number,
	httpPort: number,
): Promise<void> {
	if (packages.length === 0) return;

	const extractDir = await downloadPackages(version, arch);

	const packagePaths: string[] = [];
	for (const pkg of packages) {
		const pkgPath = findPackageFile(extractDir, pkg);
		if (!pkgPath) {
			console.warn(`Package "${pkg}" not found in all_packages for ${version} (${arch})`);
			continue;
		}
		packagePaths.push(pkgPath);
	}

	if (packagePaths.length === 0) return;

	await uploadPackages(packagePaths, sshPort);

	// Reboot to activate packages
	console.log("Rebooting CHR to activate packages...");
	try {
		await fetch(`http://127.0.0.1:${httpPort}/rest/system/reboot`, {
			method: "POST",
			headers: { Authorization: `Basic ${btoa("admin:")}` },
			signal: AbortSignal.timeout(5000),
		});
	} catch {
		// Expected — connection drops during reboot
	}
}
