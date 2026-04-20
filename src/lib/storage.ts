/**
 * Storage health and usage helpers for quickchr-managed files.
 */

import { existsSync, lstatSync, readdirSync, statfsSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatDiskSize } from "./disk.ts";
import { getCacheDir, getDataDir, getMachinesDir } from "./state.ts";
import { QuickCHRError } from "./types.ts";

export const QUICKCHR_MIN_FREE_BYTES = 10 * 1024 ** 3;
export const QUICKCHR_WARN_FREE_BYTES = 20 * 1024 ** 3;

export interface QuickchrStorageReport {
	label: ".local" | "data dir";
	path: string;
	statPath: string;
	freeBytes: number;
	quickchrBytes: number;
	cacheBytes: number;
	machinesBytes: number;
	otherBytes: number;
	recommendedFreeBytes: number;
	warningFreeBytes: number;
	status: "ok" | "warn" | "error";
}

function resolveStorageRoot(): { label: QuickchrStorageReport["label"]; path: string } {
	if (process.env.QUICKCHR_DATA_DIR || process.platform === "win32") {
		return { label: "data dir", path: getDataDir() };
	}

	const home = process.env.HOME || process.env.USERPROFILE || "";
	if (!home) {
		return { label: "data dir", path: getDataDir() };
	}

	return { label: ".local", path: join(home, ".local") };
}

function nearestExistingPath(path: string): string {
	let current = path || ".";
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) return ".";
		current = parent;
	}
	return current;
}

function directorySize(path: string): number {
	if (!existsSync(path)) return 0;

	const stat = lstatSync(path);
	if (!stat.isDirectory()) {
		return stat.size;
	}

	let total = 0;
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		const fullPath = join(path, entry.name);
		if (entry.isDirectory()) {
			total += directorySize(fullPath);
		} else {
			try {
				total += lstatSync(fullPath).size;
			} catch {
				// Skip entries that can't be stat'd (e.g. Windows named pipes throw EACCES)
			}
		}
	}
	return total;
}

function freeBytesForPath(path: string): number {
	if (process.platform !== "win32") {
		const result = Bun.spawnSync(["df", "-kP", path], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (result.exitCode === 0) {
			const output = new TextDecoder().decode(result.stdout).trim().split("\n");
			const dataLine = output[1];
			if (dataLine) {
				const columns = dataLine.trim().split(/\s+/);
				const availableKb = Number.parseInt(columns[3] ?? "", 10);
				if (Number.isFinite(availableKb)) {
					return availableKb * 1024;
				}
			}
		}
	}

	const fsStats = statfsSync(path);
	return fsStats.bavail * (fsStats.bsize || 4096);
}

export function getQuickchrStorageReport(
	recommendedFreeBytes: number = QUICKCHR_MIN_FREE_BYTES,
	warningFreeBytes: number = QUICKCHR_WARN_FREE_BYTES,
): QuickchrStorageReport {
	const storageRoot = resolveStorageRoot();
	const statPath = nearestExistingPath(storageRoot.path);
	const freeBytes = freeBytesForPath(statPath);

	const dataDir = getDataDir();
	const cacheBytes = directorySize(getCacheDir());
	const machinesBytes = directorySize(getMachinesDir());
	const dataDirBytes = directorySize(dataDir);
	const quickchrBytes = Math.max(dataDirBytes, cacheBytes + machinesBytes);
	const otherBytes = Math.max(0, dataDirBytes - cacheBytes - machinesBytes);

	let status: QuickchrStorageReport["status"] = "ok";
	if (freeBytes < recommendedFreeBytes) {
		status = "error";
	} else if (freeBytes < warningFreeBytes) {
		status = "warn";
	}

	return {
		label: storageRoot.label,
		path: storageRoot.path,
		statPath,
		freeBytes,
		quickchrBytes,
		cacheBytes,
		machinesBytes,
		otherBytes,
		recommendedFreeBytes,
		warningFreeBytes,
		status,
	};
}

export function formatQuickchrUsage(report: QuickchrStorageReport): string {
	const parts = [
		`cache ${formatDiskSize(report.cacheBytes)}`,
		`machines ${formatDiskSize(report.machinesBytes)}`,
	];
	if (report.otherBytes > 0) {
		parts.push(`other ${formatDiskSize(report.otherBytes)}`);
	}
	return `quickchr uses ${formatDiskSize(report.quickchrBytes)} (${parts.join(", ")})`;
}

export function assertSufficientQuickchrStorage(
	action: string,
	minimumFreeBytes: number = QUICKCHR_MIN_FREE_BYTES,
): QuickchrStorageReport {
	const report = getQuickchrStorageReport(
		minimumFreeBytes,
		Math.max(QUICKCHR_WARN_FREE_BYTES, minimumFreeBytes),
	);

	if (report.freeBytes < minimumFreeBytes) {
		throw new QuickCHRError(
			"INSUFFICIENT_DISK_SPACE",
			`Not enough free space to ${action} in ${report.path}: ${formatDiskSize(report.freeBytes)} available, need at least ${formatDiskSize(minimumFreeBytes)}. ${formatQuickchrUsage(report)}.`,
		);
	}

	return report;
}
