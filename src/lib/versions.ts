/**
 * RouterOS version resolution and download URL generation.
 */

import type { Arch, Channel } from "./types.ts";
import { QuickCHRError } from "./types.ts";

const UPGRADE_BASE = "https://upgrade.mikrotik.com/routeros/NEWESTa7";
const DOWNLOAD_BASE = "https://download.mikrotik.com/routeros";
export const MIN_PROVISION_VERSION = "7.20.8";
export const PROVISIONING_FEATURE_LABEL = "post-boot provisioning";
export const PROVISIONING_FEATURE_SUMMARY = "packages, login/user changes, license, and device-mode";
export const PROVISIONING_BOOT_ONLY_SUMMARY = "Boot-only features such as disks, networks, and other QEMU-local setup remain available on older 7.x releases.";

export interface RouterOsCompatibilityRow {
	feature: string;
	minimumVersion: string;
	notes: string;
}

export const ROUTEROS_COMPATIBILITY_MATRIX: RouterOsCompatibilityRow[] = [
	{
		feature: "Boot / start / stop",
		minimumVersion: "any RouterOS 7.x",
		notes: "Boot-only path. QEMU-local only; no RouterOS mutations required.",
	},
	{
		feature: "Disk resize / extra disks / disk inspection",
		minimumVersion: "any RouterOS 7.x",
		notes: "Host-side qemu-img features. Requires qemu-img, not RouterOS provisioning support.",
	},
	{
		feature: "Network attachment / port mappings",
		minimumVersion: "any RouterOS 7.x",
		notes: "QEMU networking setup before or during boot.",
	},
	{
		feature: "Managed login, custom user, disable-admin",
		minimumVersion: MIN_PROVISION_VERSION,
		notes: "Mutates RouterOS after boot; handled as quickchr provisioning.",
	},
	{
		feature: "Package install / install-all-packages",
		minimumVersion: MIN_PROVISION_VERSION,
		notes: "Uploads packages and reboots after boot-time provisioning starts.",
	},
	{
		feature: "License apply / renew",
		minimumVersion: MIN_PROVISION_VERSION,
		notes: "RouterOS license workflow varies by version; quickchr validates this path on the baseline and newer.",
	},
	{
		feature: "Device-mode changes",
		minimumVersion: MIN_PROVISION_VERSION,
		notes: "Explicitly unsupported below the baseline even if older RouterOS builds expose some attributes.",
	},
];

export function provisioningSupportSummary(minimumVersion = MIN_PROVISION_VERSION): string {
	return `quickchr validates ${PROVISIONING_FEATURE_LABEL} on RouterOS ${minimumVersion}+ only; older 7.x remains boot-only.`;
}

export function provisioningSupportHint(minimumVersion = MIN_PROVISION_VERSION): string {
	return `Use --channel long-term or --version ${minimumVersion}+ for ${PROVISIONING_FEATURE_SUMMARY}, or keep the older version without provisioning options.`;
}

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

/** Parse a RouterOS version into numeric parts. beta/rc suffixes are ignored for ordering. */
export function parseVersionParts(version: string): [number, number, number] {
	const match = version.match(/^(\d+)\.(\d+)(?:\.(\d+))?(?:beta\d+|rc\d+)?$/);
	if (!match) {
		throw new QuickCHRError("INVALID_VERSION", `Invalid version: ${version}`);
	}

	const major = Number.parseInt(match[1] ?? "0", 10);
	const minor = Number.parseInt(match[2] ?? "0", 10);
	const patch = Number.parseInt(match[3] ?? "0", 10);
	return [major, minor, patch];
}

/** Compare two RouterOS versions semantically. */
export function compareRouterOsVersion(left: string, right: string): number {
	const [leftMajor, leftMinor, leftPatch] = parseVersionParts(left);
	const [rightMajor, rightMinor, rightPatch] = parseVersionParts(right);

	if (leftMajor !== rightMajor) return leftMajor - rightMajor;
	if (leftMinor !== rightMinor) return leftMinor - rightMinor;
	return leftPatch - rightPatch;
}

/** True if RouterOS version is supported for quickchr provisioning mutations. */
export function isProvisioningSupportedVersion(
	version: string,
	minimumVersion = MIN_PROVISION_VERSION,
): boolean {
	return compareRouterOsVersion(version, minimumVersion) >= 0;
}

/** Guard provisioning operations to reduce version-dependent failure modes. */
export function assertProvisioningSupportedVersion(
	version: string,
	operation: string,
	minimumVersion = MIN_PROVISION_VERSION,
): void {
	if (isProvisioningSupportedVersion(version, minimumVersion)) return;

	throw new QuickCHRError(
		"PROVISIONING_VERSION_UNSUPPORTED",
		`Cannot ${operation} on RouterOS ${version}. ${provisioningSupportSummary(minimumVersion)} ${PROVISIONING_BOOT_ONLY_SUMMARY}`,
		provisioningSupportHint(minimumVersion),
	);
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
