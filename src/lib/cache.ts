/**
 * Cache retention policy for downloaded CHR images and package archives.
 *
 * - Default cap: 2 GB total cache size (size-based eviction), counting images, package
 *   archives with their extractions, and interrupted downloads.
 * - Eviction order: oldest RouterOS version first, mtime tiebreaker.
 * - Never evicts an image referenced by any machine (running or stopped).
 * - Callers can pin extra versions via `protectVersions` (e.g. current long-term).
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { directorySize, getCacheDir, loadAllMachines } from "./state.ts";
import { chrImageBasename, compareRouterOsVersion, isValidVersion } from "./versions.ts";
import { QuickCHRError, type Arch } from "./types.ts";

export const DEFAULT_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/** Free space quickchr keeps on the data dir's filesystem beyond what an operation
 *  writes — the `storage-reserve` setting's default. Lives here beside the cache cap
 *  so settings.ts can read both without importing storage.ts (which imports settings). */
export const DEFAULT_STORAGE_RESERVE_BYTES = 2 * 1024 * 1024 * 1024;

/** Parse a human size string (NK/NM/NG/NT, IEC binary, case-insensitive) to bytes. */
export function parseSizeString(s: string): number {
	const m = s.match(/^(\d+(?:\.\d+)?)([KMGT]?)i?B?$/i);
	if (!m) throw new QuickCHRError("INVALID_SIZE_STRING", `Invalid size "${s}" (use NK/NM/NG/NT, e.g. 2G)`);
	const n = Number.parseFloat(m[1] ?? "0");
	const unit = (m[2] ?? "").toUpperCase();
	const mult: Record<string, number> = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
	return Math.floor(n * (mult[unit] ?? 1));
}

/** "1 entry" / "3 entries". */
export function countEntries(n: number): string {
	return `${n} ${n === 1 ? "entry" : "entries"}`;
}

/** Format a byte count as a human size (IEC binary), matching cache list's display. */
export function formatSizeBytes(b: number): string {
	if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GiB`;
	if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MiB`;
	if (b >= 1024) return `${(b / 1024).toFixed(1)} KiB`;
	return `${b} B`;
}

/** What a cache entry is. `packages` is one archive + its extraction, counted and
 *  deleted together: the extraction is only a cache hit while the archive it was
 *  made from is still there. `partial` is an interrupted download or extraction. */
export type CacheEntryKind = "image" | "image-zip" | "packages" | "partial";

export interface CacheEntry {
	/** The entry's main file or directory. */
	path: string;
	/** Everything deleting this entry removes. */
	paths: string[];
	basename: string;
	kind: CacheEntryKind;
	version: string;
	arch: Arch | "unknown";
	sizeBytes: number;
	/** Last write, or last use: a cache hit touches the image or package archive. */
	mtimeMs: number;
	inUse: boolean;
}

export interface CacheInventory {
	entries: CacheEntry[];
	/** Bytes in files quickchr did not write. Listed, never deleted. */
	unmanagedBytes: number;
}

export interface PruneOptions {
	cacheDir?: string;
	maxSizeBytes?: number;
	maxAgeMs?: number;
	olderThan?: string;
	protectVersions?: string[];
	/** Evict eligible entries, oldest version first, until this many bytes are gone. */
	reclaimBytes?: number;
	/** Keep entries written or used this recently: another create may be reading them. */
	skipRecentMs?: number;
	dryRun?: boolean;
}

export interface PruneResult {
	evicted: CacheEntry[];
	kept: CacheEntry[];
	/** Entries chosen for eviction whose delete failed. Neither evicted nor kept, and not
	 *  counted in `freedBytes`. */
	failed: Array<{ entry: CacheEntry; error: string }>;
	/** Logical size of what was deleted. Not a measured change in free space: sparse
	 *  files, clones and concurrent writers all make the two differ. */
	freedBytes: number;
	reasons: Record<string, string>;
}

/** Anything an automatic eviction leaves alone because another operation may be using
 *  it right now — a create converting from the image, a first boot installing packages. */
export const RECENT_USE_MS = 30 * 60 * 1000;

/** Parse a cached file basename into version + arch. Returns "unknown" parts when unparseable. */
export function parseCacheBasename(basename: string): { version: string; arch: Arch | "unknown" } {
	const packages = basename.match(/^(?:all_)?packages-(x86|arm64)-(.+?)(?:\.zip)?$/);
	if (packages) {
		const version = packages[2] ?? "unknown";
		return { version: isValidVersion(version) ? version : "unknown", arch: packages[1] as Arch };
	}

	// Strip recognized cache extensions (.img, .img.zip).
	let stem = basename;
	if (stem.endsWith(".img.zip")) stem = stem.slice(0, -".img.zip".length);
	else if (stem.endsWith(".zip")) stem = stem.slice(0, -".zip".length);
	else if (stem.endsWith(".img")) stem = stem.slice(0, -".img".length);

	// chr-<version>[-arm64]
	const m = stem.match(/^chr-(\d+\.\d+(?:\.\d+)?(?:beta\d+|rc\d+)?)(-arm64)?$/);
	if (!m) return { version: "unknown", arch: "unknown" };
	const version = m[1] ?? "unknown";
	const arch: Arch = m[2] ? "arm64" : "x86";
	if (!isValidVersion(version)) return { version: "unknown", arch };
	return { version, arch };
}

/** Cache names machines still need. Every machine keeps its factory image: `clean` and a
 *  failed first boot's rollback rebuild from it. A machine keeps its package cache only
 *  until its first-boot provisioning is stamped done. */
function inUseSet(): Set<string> {
	const set = new Set<string>();
	let machines: ReturnType<typeof loadAllMachines>;
	try {
		machines = loadAllMachines();
	} catch {
		return set;
	}
	for (const m of machines) {
		if (!m.version || !m.arch) continue;
		set.add(`${chrImageBasename(m.version, m.arch)}.img`);
		set.add(`${chrImageBasename(m.version, m.arch)}.img.zip`);
		const wantsPackages = m.installAllPackages === true || (m.packages?.length ?? 0) > 0;
		if (wantsPackages && !m.provisioning) set.add(`packages-${m.arch}-${m.version}`);
	}
	return set;
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Inventory the cache: every entry quickchr manages, plus the bytes it does not. */
export function cacheInventory(cacheDir?: string): CacheInventory {
	const dir = cacheDir ?? getCacheDir();
	if (!existsSync(dir)) return { entries: [], unmanagedBytes: 0 };
	const used = inUseSet();
	const now = Date.now();
	const entries: CacheEntry[] = [];
	const packageGroups = new Map<string, CacheEntry>();
	let unmanagedBytes = 0;

	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		let stat: ReturnType<typeof statSync>;
		try {
			stat = statSync(full);
		} catch {
			continue;
		}
		const sizeBytes = stat.isDirectory() ? directorySize(full) : stat.size;

		const packages = name.match(/^(?:all_)?packages-(x86|arm64)-(.+?)(\.zip)?$/);
		if (packages && (stat.isDirectory() !== Boolean(packages[3]))) {
			const key = `packages-${packages[1]}-${packages[2]}`;
			const group = packageGroups.get(key);
			if (group) {
				group.paths.push(full);
				group.sizeBytes += sizeBytes;
				group.mtimeMs = Math.max(group.mtimeMs, stat.mtimeMs);
			} else {
				const { version, arch } = parseCacheBasename(key);
				packageGroups.set(key, {
					path: join(dir, key),
					paths: [full],
					basename: key,
					kind: "packages",
					version,
					arch,
					sizeBytes,
					mtimeMs: stat.mtimeMs,
					inUse: used.has(key),
				});
			}
			continue;
		}

		// `<target>.<pid>-<id>.part` (download.ts) is live while its writer is.
		// `.quickchr-image-*` / `.quickchr-packages-*` extraction dirs have no owner
		// recorded, so they count as live for RECENT_USE_MS after their last write.
		const part = name.match(/^(.+)\.(\d+)-[0-9a-f]+\.part$/);
		const extraction = name.startsWith(".quickchr-image-") || name.startsWith(".quickchr-packages-");
		if (part || extraction) {
			const { version, arch } = parseCacheBasename(part?.[1] ?? name);
			entries.push({
				path: full,
				paths: [full],
				basename: name,
				kind: "partial",
				version,
				arch,
				sizeBytes,
				mtimeMs: stat.mtimeMs,
				inUse: part ? isPidAlive(Number(part[2])) : now - stat.mtimeMs < RECENT_USE_MS,
			});
			continue;
		}

		const kind: CacheEntryKind | undefined = !stat.isFile()
			? undefined
			: name.endsWith(".img.zip") ? "image-zip" : name.endsWith(".img") ? "image" : undefined;
		const { version, arch } = parseCacheBasename(name);
		if (!kind || version === "unknown") {
			unmanagedBytes += sizeBytes;
			continue;
		}
		entries.push({
			path: full,
			paths: [full],
			basename: name,
			kind,
			version,
			arch,
			sizeBytes,
			mtimeMs: stat.mtimeMs,
			inUse: used.has(name),
		});
	}

	entries.push(...packageGroups.values());
	return { entries, unmanagedBytes };
}

/** List cache entries with parsed metadata and in-use status. */
export function listCacheEntries(cacheDir?: string): CacheEntry[] {
	return cacheInventory(cacheDir).entries;
}

function compareVersionsSafe(a: string, b: string): number {
	if (a === b) return 0;
	if (a === "unknown") return -1;
	if (b === "unknown") return 1;
	try {
		return compareRouterOsVersion(a, b);
	} catch {
		return 0;
	}
}

/**
 * Apply the cache retention policy. Returns what was (or would be) evicted.
 *
 * Eviction proceeds only when at least one of these conditions is set and met:
 *   - `maxSizeBytes`: total bytes exceed cap
 *   - `maxAgeMs`: any entry older than threshold
 *   - `olderThan`: any entry's parsed version older than threshold
 *   - `reclaimBytes`: evict until this many bytes are gone
 *
 * In-use entries, `protectVersions` entries and (with `skipRecentMs`) recently used
 * entries are never evicted. Interrupted downloads go first, then oldest version.
 */
export function pruneCache(opts: PruneOptions = {}): PruneResult {
	const entries = listCacheEntries(opts.cacheDir);
	const protect = new Set(opts.protectVersions ?? []);
	const dryRun = opts.dryRun ?? false;
	const now = Date.now();

	const reasons: Record<string, string> = {};
	const evicted: CacheEntry[] = [];
	const kept: CacheEntry[] = [];
	const failed: PruneResult["failed"] = [];

	const protectedEntries: CacheEntry[] = [];
	const candidates: CacheEntry[] = [];

	for (const e of entries) {
		if (e.inUse) {
			protectedEntries.push(e);
			reasons[e.basename] = e.kind === "partial" ? "in progress" : "in use";
		} else if (protect.has(e.version)) {
			protectedEntries.push(e);
			reasons[e.basename] = `protected (version ${e.version})`;
		} else if (opts.skipRecentMs !== undefined && now - e.mtimeMs < opts.skipRecentMs) {
			protectedEntries.push(e);
			reasons[e.basename] = "used recently";
		} else {
			candidates.push(e);
		}
	}

	candidates.sort((a, b) => {
		const partial = Number(b.kind === "partial") - Number(a.kind === "partial");
		if (partial !== 0) return partial;
		const v = compareVersionsSafe(a.version, b.version);
		if (v !== 0) return v;
		return a.mtimeMs - b.mtimeMs;
	});

	/** True when the entry is gone (or, in a dry run, would be). */
	const evict = (e: CacheEntry, reason: string): boolean => {
		if (!dryRun) {
			try {
				for (const path of e.paths) rmSync(path, { recursive: true, force: true });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				failed.push({ entry: e, error: message });
				reasons[e.basename] = `delete failed: ${message}`;
				return false;
			}
		}
		evicted.push(e);
		reasons[e.basename] = reason;
		return true;
	};

	const remaining: CacheEntry[] = [];

	if (opts.olderThan) {
		const threshold = opts.olderThan;
		for (const e of candidates) {
			if (e.version !== "unknown" && compareVersionsSafe(e.version, threshold) < 0) {
				evict(e, `version ${e.version} < ${threshold}`);
			} else {
				remaining.push(e);
			}
		}
	} else {
		remaining.push(...candidates);
	}

	const remainingAfterAge: CacheEntry[] = [];
	if (opts.maxAgeMs !== undefined) {
		const maxAge = opts.maxAgeMs;
		for (const e of remaining) {
			if (now - e.mtimeMs > maxAge) {
				evict(e, `age ${(Math.floor((now - e.mtimeMs) / 1000))}s > ${Math.floor(maxAge / 1000)}s`);
			} else {
				remainingAfterAge.push(e);
			}
		}
	} else {
		remainingAfterAge.push(...remaining);
	}

	const keptSoFar: CacheEntry[] = [...remainingAfterAge];
	const totalSize = (es: CacheEntry[]) => es.reduce((s, x) => s + x.sizeBytes, 0);

	if (opts.maxSizeBytes !== undefined) {
		const cap = opts.maxSizeBytes;
		let total = totalSize(protectedEntries) + totalSize(keptSoFar) + totalSize(failed.map((f) => f.entry));
		while (total > cap && keptSoFar.length > 0) {
			const victim = keptSoFar.shift();
			if (!victim) break;
			if (evict(victim, `size cap ${formatSizeBytes(cap)} exceeded (oldest version)`)) total -= victim.sizeBytes;
		}
	}

	if (opts.reclaimBytes !== undefined) {
		const target = opts.reclaimBytes;
		while (totalSize(evicted) < target && keptSoFar.length > 0) {
			const victim = keptSoFar.shift();
			if (!victim) break;
			evict(victim, `reclaimed for space (oldest version)`);
		}
	}

	for (const e of protectedEntries) kept.push(e);
	for (const e of keptSoFar) {
		kept.push(e);
		reasons[e.basename] ??= "kept";
	}

	return { evicted, kept, failed, freedBytes: totalSize(evicted), reasons };
}

/**
 * Best-effort auto-prune used by `start()` after a successful boot.
 * Never throws — failures are swallowed and logged.
 */
export function autoPruneIfOverCap(opts: { logger?: (msg: string) => void; cacheDir?: string; maxSizeBytes?: number; protectVersions?: string[] } = {}): PruneResult {
	const cap = opts.maxSizeBytes ?? DEFAULT_CACHE_MAX_BYTES;
	try {
		const entries = listCacheEntries(opts.cacheDir);
		const total = entries.reduce((s, e) => s + e.sizeBytes, 0);
		if (total <= cap) {
			return { evicted: [], kept: entries, failed: [], freedBytes: 0, reasons: {} };
		}
		const result = pruneCache({
			cacheDir: opts.cacheDir,
			maxSizeBytes: cap,
			protectVersions: opts.protectVersions,
			skipRecentMs: RECENT_USE_MS,
		});
		if (opts.logger) {
			for (const line of describePrune(result)) opts.logger(line);
		}
		return result;
	} catch (e) {
		if (opts.logger) {
			opts.logger(`cache: auto-prune skipped: ${e instanceof Error ? e.message : String(e)}`);
		}
		return { evicted: [], kept: [], failed: [], freedBytes: 0, reasons: {} };
	}
}

/** One-line log summary of an eviction, naming what went, plus one line per failure. */
export function describePrune(result: PruneResult): string[] {
	const lines: string[] = [];
	if (result.evicted.length > 0) {
		lines.push(`cache: evicted ${result.evicted.map((e) => e.basename).join(", ")} — freed ${formatSizeBytes(result.freedBytes)}`);
	}
	for (const { entry, error } of result.failed) {
		lines.push(`cache: could not delete ${entry.basename}: ${error}`);
	}
	return lines;
}
