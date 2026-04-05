/**
 * RouterOS version resolution and download URL generation.
 */

import type { Arch, Channel } from "./types.ts";
import { QuickCHRError } from "./types.ts";

const UPGRADE_BASE = "https://upgrade.mikrotik.com/routeros/NEWESTa7";
const DOWNLOAD_BASE = "https://download.mikrotik.com/routeros";

/** Fetch the latest version for a given channel from MikroTik's upgrade server. */
export async function resolveVersion(channel: Channel): Promise<string> {
	const url = `${UPGRADE_BASE}.${channel}`;

	const response = await fetch(url);
	if (!response.ok) {
		throw new QuickCHRError(
			"DOWNLOAD_FAILED",
			`Failed to fetch version for channel "${channel}": HTTP ${response.status}`,
		);
	}

	const text = await response.text();
	// Response format: "7.22.1 1774276515" (version + unix timestamp)
	const version = text.trim().split(/\s+/)[0]?.trim();
	if (!version || !isValidVersion(version)) {
		throw new QuickCHRError(
			"INVALID_VERSION",
			`Unexpected version format for channel "${channel}": "${text.trim()}"`,
		);
	}

	return version;
}

/** Fetch latest versions for all channels in parallel. */
export async function resolveAllVersions(): Promise<Record<Channel, string>> {
	const channels: Channel[] = ["stable", "long-term", "testing", "development"];
	const results = await Promise.all(
		channels.map(async (ch) => [ch, await resolveVersion(ch)] as const),
	);
	return Object.fromEntries(results) as Record<Channel, string>;
}

/** Validate a version string matches RouterOS format: MAJOR.MINOR[.PATCH][betaN|rcN] */
export function isValidVersion(version: string): boolean {
	return /^\d+\.\d+(\.\d+)?(beta\d+|rc\d+)?$/.test(version);
}

/** Build the MikroTik download URL for a CHR .img.zip. */
export function chrDownloadUrl(version: string, arch: Arch = "x86"): string {
	const suffix = arch === "arm64" ? "-arm64" : "";
	return `${DOWNLOAD_BASE}/${version}/chr-${version}${suffix}.img.zip`;
}

/** Build the download URL for the all-packages zip. */
export function packagesDownloadUrl(version: string, arch: Arch): string {
	const mtArch = arch === "arm64" ? "arm64" : "x86";
	return `${DOWNLOAD_BASE}/${version}/all_packages-${mtArch}-${version}.zip`;
}

/** Build the expected image filename (without extension). */
export function chrImageBasename(version: string, arch: Arch): string {
	return arch === "arm64" ? `chr-${version}-arm64` : `chr-${version}`;
}

/** Generate a default machine name from version + arch, with incrementing suffix. */
export function generateMachineName(
	version: string,
	arch: Arch,
	existingNames: string[],
): string {
	const base = `${version}-${arch}`;
	let n = 1;
	while (existingNames.includes(`${base}-${n}`)) {
		n++;
	}
	return `${base}-${n}`;
}
