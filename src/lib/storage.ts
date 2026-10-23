/**
 * Storage admission and usage helpers for quickchr-managed files.
 *
 * An operation that writes is admitted when the data dir's filesystem has room for
 * what the operation itself will write (its estimated peak) plus the configured host
 * reserve. When it does not, eligible cache entries are evicted first and free space
 * is measured again; only then is the operation refused (#199).
 */

import { existsSync, statfsSync } from "node:fs";
import { dirname, join } from "node:path";
import { countEntries, describePrune, pruneCache, RECENT_USE_MS } from "./cache.ts";
import { formatDiskSize } from "./disk.ts";
import { resolveSetting } from "./settings.ts";
import { directorySize, getCacheDir, getDataDir, getMachinesDir } from "./state.ts";
import { chrImageBasename } from "./versions.ts";
import { type Arch, QuickCHRError } from "./types.ts";

const MiB = 1024 ** 2;

/**
 * Peak new bytes per stage, rounded up from one host's measurements (#199, macOS x86,
 * CHR 7.20–7.26): a 128 MiB extracted image from a ~45 MiB ZIP, a qcow2 boot disk of
 * ~50 MiB after first boot (never more than the raw image it is converted from), and
 * 29–52 MiB package archives that extract to about their own size. Estimates, not
 * bounds: they are what admission charges, and the reserve absorbs the error.
 */
export const STORAGE_ESTIMATES = {
	/** Image ZIP plus its extraction, which coexist until the ZIP is removed. */
	imageDownload: 256 * MiB,
	/** A raw copy or a qcow2 conversion of the image, plus first-boot writes. */
	bootDisk: 192 * MiB,
	/** The all-packages archive plus its extraction; both are kept. */
	packagesDownload: 192 * MiB,
} as const;

/** doctor warns while free space is under the reserve plus this much. */
const WARN_MARGIN_BYTES = 2 * 1024 ** 3;

export interface QuickchrStorageReport {
	/** The data dir: where the cache and machines are written. */
	path: string;
	/** The nearest existing directory to `path`, whose filesystem is measured. */
	statPath: string;
	freeBytes: number;
	quickchrBytes: number;
	cacheBytes: number;
	machinesBytes: number;
	otherBytes: number;
	reserveBytes: number;
	warningFreeBytes: number;
	status: "ok" | "warn" | "error";
}

/** What an operation is about to write, for admission. */
export interface StorageNeed {
	/** Estimated peak new bytes, before the reserve. */
	bytes: number;
	/** What the estimate is made of, for the refusal message. */
	detail: string;
	/** Versions the operation reads from the cache: reclamation never evicts them. */
	protectVersions?: string[];
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

/** The free-space measurement, as an object so tests can replace it. */
export const storageProbe = { freeBytes: freeBytesForPath };

/** The configured host reserve: the `storage-reserve` setting (default 2 GiB). */
export function resolveStorageReserve(): number {
	return resolveSetting("storage-reserve").value as number;
}

export function getQuickchrStorageReport(
	reserveBytes: number = resolveStorageReserve(),
	warningFreeBytes: number = reserveBytes + WARN_MARGIN_BYTES,
): QuickchrStorageReport {
	const dataDir = getDataDir();
	const statPath = nearestExistingPath(dataDir);
	const freeBytes = storageProbe.freeBytes(statPath);

	const cacheBytes = directorySize(getCacheDir());
	const machinesBytes = directorySize(getMachinesDir());
	const dataDirBytes = directorySize(dataDir);
	const quickchrBytes = Math.max(dataDirBytes, cacheBytes + machinesBytes);
	const otherBytes = Math.max(0, dataDirBytes - cacheBytes - machinesBytes);

	let status: QuickchrStorageReport["status"] = "ok";
	if (freeBytes < reserveBytes) {
		status = "error";
	} else if (freeBytes < warningFreeBytes) {
		status = "warn";
	}

	return {
		path: dataDir,
		statPath,
		freeBytes,
		quickchrBytes,
		cacheBytes,
		machinesBytes,
		otherBytes,
		reserveBytes,
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

/** What creating a machine will write: its boot disk, plus the image and package
 *  downloads it still needs. Extra disks are sparse qcow2 and start near zero. */
export function estimateMachineCreation(opts: { version: string; arch: Arch; packages: boolean }): StorageNeed {
	const cache = getCacheDir();
	const parts: Array<[string, number]> = [["boot disk", STORAGE_ESTIMATES.bootDisk]];
	if (!existsSync(join(cache, `${chrImageBasename(opts.version, opts.arch)}.img`))) {
		parts.push(["image download", STORAGE_ESTIMATES.imageDownload]);
	}
	if (opts.packages && !existsSync(join(cache, `packages-${opts.arch}-${opts.version}`))) {
		parts.push(["packages download", STORAGE_ESTIMATES.packagesDownload]);
	}
	return {
		bytes: parts.reduce((sum, [, bytes]) => sum + bytes, 0),
		detail: parts.map(([label, bytes]) => `${label} ${formatDiskSize(bytes)}`).join(" + "),
		protectVersions: [opts.version],
	};
}

/**
 * Admit an operation that will write `need.bytes`, or throw `INSUFFICIENT_DISK_SPACE`.
 *
 * Admitted when free space ≥ `need.bytes` + the reserve. Otherwise, unless `reclaim` is
 * false, eligible cache entries are evicted (oldest version first; never in-use,
 * protected or recently used ones) and free space is measured again. Logical sizes are
 * not trusted as proof of room: only the new measurement admits. When everything
 * eligible for eviction could not cover the shortage, nothing is evicted.
 */
export function assertSufficientQuickchrStorage(
	action: string,
	need: StorageNeed = { bytes: 0, detail: "" },
	opts: { reclaim?: boolean; logger?: (message: string) => void } = {},
): QuickchrStorageReport {
	let report = getQuickchrStorageReport();
	const required = need.bytes + report.reserveBytes;
	if (report.freeBytes >= required) return report;

	let reclaimed: ReturnType<typeof pruneCache> | undefined;
	let wouldNotCover = false;
	if (opts.reclaim !== false) {
		const reclaim = {
			reclaimBytes: required - report.freeBytes,
			protectVersions: need.protectVersions,
			skipRecentMs: RECENT_USE_MS,
		};
		// Evicting cannot close a gap larger than everything eligible: refuse with the
		// cache intact rather than empty it for nothing.
		const plan = pruneCache({ ...reclaim, dryRun: true });
		if (plan.freedBytes < reclaim.reclaimBytes) {
			reclaimed = plan;
			wouldNotCover = true;
		} else {
			reclaimed = pruneCache(reclaim);
			for (const line of describePrune(reclaimed)) opts.logger?.(line);
			report = getQuickchrStorageReport(report.reserveBytes, report.warningFreeBytes);
			if (report.freeBytes >= required) return report;
		}
	}

	const needs = need.detail
		? `${need.detail} + ${formatDiskSize(report.reserveBytes)} reserve`
		: `${formatDiskSize(report.reserveBytes)} reserve`;
	const sentences = [
		`Not enough free space to ${action} in ${report.statPath}: ${formatDiskSize(report.freeBytes)} available, need ${formatDiskSize(required)} (${needs}), ${formatDiskSize(required - report.freeBytes)} short.`,
	];
	if (reclaimed) {
		const kept = reclaimed.kept.filter((e) => reclaimed.reasons[e.basename] !== "kept");
		const keptBytes = kept.reduce((sum, e) => sum + e.sizeBytes, 0);
		let line = wouldNotCover
			? reclaimed.evicted.length > 0
				? `The cache could spare only ${formatDiskSize(reclaimed.freedBytes)} (${countEntries(reclaimed.evicted.length)}), not enough, so nothing was evicted.`
				: "Nothing in the cache could be evicted."
			: `Evicted ${countEntries(reclaimed.evicted.length)} from the cache (${formatDiskSize(reclaimed.freedBytes)}) first.`;
		if (reclaimed.failed.length > 0) line += ` ${reclaimed.failed.length} delete(s) failed.`;
		if (keptBytes > 0) line += ` ${formatDiskSize(keptBytes)} is kept: in use by a machine, needed by this operation, or used in the last ${RECENT_USE_MS / 60_000} minutes.`;
		sentences.push(line);
	}
	sentences.push(`${formatQuickchrUsage(report)}.`);
	throw new QuickCHRError(
		"INSUFFICIENT_DISK_SPACE",
		sentences.join(" "),
		"Free space on that filesystem, remove machines you no longer need, or lower the reserve with 'quickchr settings set storage-reserve <size>' (QUICKCHR_STORAGE_RESERVE).",
	);
}
