/**
 * Storage admission and usage helpers for quickchr-managed files.
 *
 * An operation that writes is admitted when each filesystem it writes to has room for
 * what the operation itself will write there (its estimated peak) plus the configured
 * host reserve. When one does not, eligible cache entries are evicted first and free
 * space is measured again; only then is the operation refused (#199).
 */

import { existsSync, statfsSync } from "node:fs";
import { dirname, join } from "node:path";
import { type CacheEntry, countEntries, describePrune, type PruneResult, pruneCacheUnderLock, RECENT_USE_MS } from "./cache.ts";
import { createLease, filesystemOf, liveLeases, type StorageLease, withStorageLock } from "./storage-lease.ts";
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

/** One stage of an operation's writes. */
export interface StoragePart {
	/** For the refusal message, e.g. "boot disk". */
	label: string;
	/** Estimated peak new bytes. */
	bytes: number;
	/** Where they are written: the part is checked on that path's filesystem. */
	path: string;
	/** Reserve the bytes in the operation's lease (the default). False for a stage that
	 *  admits and reserves for itself when it runs, such as a download a create will
	 *  trigger: checked now, so the create refuses early, but not held twice. */
	hold?: boolean;
}

/** What an operation is about to write and read, for admission. */
export interface StorageNeed {
	parts: StoragePart[];
	/** Versions the operation reads from the cache: reclamation never evicts them. */
	protectVersions?: string[];
	/** Cache entries the operation reads; pinned in its lease. */
	pins?: string[];
	/** The cache reclamation evicts from. Default: the data dir's cache. */
	cacheDir?: string;
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

/** The free-space measurement and filesystem identity, as an object so tests can
 *  replace them (a unit test cannot mount a second filesystem). */
export const storageProbe = { freeBytes: freeBytesForPath, filesystem: filesystemOf };

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
 *  downloads it still needs. Extra disks are sparse qcow2 and start near zero.
 *  Only the boot disk is held in the create's lease: each download admits and
 *  reserves for itself when it runs, so holding it here would count it twice. */
export function estimateMachineCreation(opts: { version: string; arch: Arch; packages: boolean }): StorageNeed {
	const cache = getCacheDir();
	const image = chrImageBasename(opts.version, opts.arch);
	const parts: StoragePart[] = [{ label: "boot disk", bytes: STORAGE_ESTIMATES.bootDisk, path: getMachinesDir() }];
	if (!existsSync(join(cache, `${image}.img`))) {
		parts.push({ label: "image download", bytes: STORAGE_ESTIMATES.imageDownload, path: cache, hold: false });
	}
	if (opts.packages && !existsSync(join(cache, `packages-${opts.arch}-${opts.version}`))) {
		parts.push({ label: "packages download", bytes: STORAGE_ESTIMATES.packagesDownload, path: cache, hold: false });
	}
	return { parts, protectVersions: [opts.version], pins: [`${image}.img`, `${image}.img.zip`] };
}

interface FilesystemGroup {
	dev: number;
	statPath: string;
	parts: StoragePart[];
	bytes: number;
}

function groupByFilesystem(parts: StoragePart[]): FilesystemGroup[] {
	const groups = new Map<number, FilesystemGroup>();
	for (const part of parts.length > 0 ? parts : [{ label: "", bytes: 0, path: getDataDir() }]) {
		const { dev, statPath } = storageProbe.filesystem(part.path);
		const group = groups.get(dev) ?? { dev, statPath, parts: [], bytes: 0 };
		if (part.label) group.parts.push(part);
		group.bytes += part.bytes;
		groups.set(dev, group);
	}
	return [...groups.values()];
}

/**
 * Admit an operation, or throw `INSUFFICIENT_DISK_SPACE`. Returns a lease the caller
 * releases once its writes are done (see storage-lease.ts).
 *
 * Each filesystem the operation writes to is checked on its own: free space, less
 * what other in-flight operations have reserved there, must cover that filesystem's
 * parts plus the reserve. When it does not, and the cache being reclaimed lives on that
 * filesystem, eligible entries are evicted (oldest version first; never in-use, pinned,
 * protected or recently used ones) and free space is measured again — repeatedly,
 * because logical sizes are no proof of room (sparse files, APFS clones), until the
 * measurement admits or nothing more can be evicted. When everything eligible could
 * not cover the shortage, nothing is evicted.
 *
 * The check and the lease are made under the storage lock, so two creators cannot
 * spend the same free bytes, and an eviction cannot remove what this operation pins.
 */
export function admitStorage(
	action: string,
	need: StorageNeed = { parts: [] },
	opts: { reclaim?: boolean; logger?: (message: string) => void } = {},
): StorageLease {
	return withStorageLock(() => {
		const reserveBytes = resolveStorageReserve();
		const leases = liveLeases();
		const pins = new Set([...leases.flatMap((lease) => lease.pins), ...(need.pins ?? [])]);
		const cacheDir = need.cacheDir ?? getCacheDir();
		const cacheDev = storageProbe.filesystem(cacheDir).dev;

		for (const group of groupByFilesystem(need.parts)) {
			const reservedByOthers = leases
				.flatMap((lease) => lease.reservations)
				.filter((r) => r.dev === group.dev)
				.reduce((sum, r) => sum + r.bytes, 0);
			const measure = () => storageProbe.freeBytes(group.statPath) - reservedByOthers;
			const required = group.bytes + reserveBytes;
			let free = measure();
			if (free >= required) continue;

			const reclaim = opts.reclaim !== false && cacheDev === group.dev;
			const evicted: CacheEntry[] = [];
			const failed: PruneResult["failed"] = [];
			let kept: PruneResult | undefined;
			let wouldNotCover = false;
			if (reclaim) {
				const policy = { cacheDir, protectVersions: need.protectVersions, skipRecentMs: RECENT_USE_MS };
				// Evicting cannot close a gap larger than everything eligible: refuse with the
				// cache intact rather than empty it for nothing.
				kept = pruneCacheUnderLock({ ...policy, reclaimBytes: required - free, dryRun: true }, pins);
				wouldNotCover = kept.freedBytes < required - free;
				while (!wouldNotCover && free < required) {
					const pass = pruneCacheUnderLock({
						...policy,
						reclaimBytes: required - free,
						skipEntries: failed.map((f) => f.entry.basename),
					}, pins);
					for (const line of describePrune(pass)) opts.logger?.(line);
					evicted.push(...pass.evicted);
					failed.push(...pass.failed);
					kept = pass;
					free = measure();
					if (pass.evicted.length === 0) break;
				}
				if (free >= required) continue;
			}

			throw insufficientSpace(action, group, { free, required, reserveBytes, reservedByOthers, reclaimed: kept && { evicted, failed, kept, wouldNotCover } });
		}

		const reservations = groupByFilesystem(need.parts.filter((part) => part.hold !== false))
			.filter((group) => group.bytes > 0)
			.map((group) => ({ dev: group.dev, bytes: group.bytes }));
		if (reservations.length === 0 && (need.pins ?? []).length === 0) return { record: { pid: process.pid, at: "", action, pins: [], reservations: [] }, release() {} };
		return createLease(action, need.pins ?? [], reservations);
	});
}

function insufficientSpace(
	action: string,
	group: FilesystemGroup,
	facts: {
		free: number;
		required: number;
		reserveBytes: number;
		reservedByOthers: number;
		reclaimed?: { evicted: CacheEntry[]; failed: PruneResult["failed"]; kept: PruneResult; wouldNotCover: boolean };
	},
): QuickCHRError {
	const detail = group.parts.map((part) => `${part.label} ${formatDiskSize(part.bytes)}`).join(" + ");
	const needs = detail ? `${detail} + ${formatDiskSize(facts.reserveBytes)} reserve` : `${formatDiskSize(facts.reserveBytes)} reserve`;
	const available = facts.reservedByOthers > 0
		? `${formatDiskSize(facts.free)} available after ${formatDiskSize(facts.reservedByOthers)} held by other operations in progress`
		: `${formatDiskSize(facts.free)} available`;
	const sentences = [
		`Not enough free space to ${action} in ${group.statPath}: ${available}, need ${formatDiskSize(facts.required)} (${needs}), ${formatDiskSize(facts.required - facts.free)} short.`,
	];
	const r = facts.reclaimed;
	if (r) {
		const freed = r.evicted.reduce((sum, e) => sum + e.sizeBytes, 0);
		let line = r.wouldNotCover
			? r.kept.evicted.length > 0
				? `The cache could spare only ${formatDiskSize(r.kept.freedBytes)} (${countEntries(r.kept.evicted.length)}), not enough, so nothing was evicted.`
				: "Nothing in the cache could be evicted."
			: `Evicted ${countEntries(r.evicted.length)} from the cache (${formatDiskSize(freed)}) first.`;
		if (r.failed.length > 0) line += ` ${r.failed.length} delete(s) failed.`;
		const keptBytes = r.kept.kept
			.filter((e) => r.kept.reasons[e.basename] !== "kept")
			.reduce((sum, e) => sum + e.sizeBytes, 0);
		if (keptBytes > 0) line += ` ${formatDiskSize(keptBytes)} is kept: in use by a machine or an operation in progress, needed by this operation, or used in the last ${RECENT_USE_MS / 60_000} minutes.`;
		sentences.push(line);
	}
	return new QuickCHRError(
		"INSUFFICIENT_DISK_SPACE",
		sentences.join(" "),
		"Free space on that filesystem, remove machines you no longer need, or lower the reserve with 'quickchr settings set storage-reserve <size>' (QUICKCHR_STORAGE_RESERVE).",
	);
}
