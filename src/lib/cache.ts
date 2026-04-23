/**
 * Cache retention policy for downloaded CHR images.
 *
 * - Default cap: 2 GB total cache size (size-based eviction).
 * - Eviction order: oldest RouterOS version first, mtime tiebreaker.
 * - Never evicts an image referenced by any machine (running or stopped).
 * - Callers can pin extra versions via `protectVersions` (e.g. current long-term).
 */

import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getCacheDir, loadAllMachines } from "./state.ts";
import { chrImageBasename, compareRouterOsVersion, isValidVersion } from "./versions.ts";
import type { Arch } from "./types.ts";

export const DEFAULT_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024;

export interface CacheEntry {
	path: string;
	basename: string;
	version: string;
	arch: Arch | "unknown";
	sizeBytes: number;
	mtimeMs: number;
	inUse: boolean;
}

export interface PruneOptions {
	cacheDir?: string;
	maxSizeBytes?: number;
	maxAgeMs?: number;
	olderThan?: string;
	protectVersions?: string[];
	dryRun?: boolean;
}

export interface PruneResult {
	evicted: CacheEntry[];
	kept: CacheEntry[];
	freedBytes: number;
	reasons: Record<string, string>;
}

/** Parse a cached file basename into version + arch. Returns "unknown" parts when unparseable. */
export function parseCacheBasename(basename: string): { version: string; arch: Arch | "unknown" } {
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
	}
	return set;
}

/** List cache entries with parsed metadata and in-use status. */
export function listCacheEntries(cacheDir?: string): CacheEntry[] {
	const dir = cacheDir ?? getCacheDir();
	if (!existsSync(dir)) return [];
	const used = inUseSet();
	const out: CacheEntry[] = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		let stat: ReturnType<typeof statSync>;
		try {
			stat = statSync(full);
		} catch {
			continue;
		}
		if (!stat.isFile()) continue;
		if (!name.endsWith(".img") && !name.endsWith(".img.zip")) continue;
		const { version, arch } = parseCacheBasename(name);
		out.push({
			path: full,
			basename: name,
			version,
			arch,
			sizeBytes: stat.size,
			mtimeMs: stat.mtimeMs,
			inUse: used.has(name),
		});
	}
	return out;
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
 *
 * In-use entries and `protectVersions` entries are never evicted.
 */
export function pruneCache(opts: PruneOptions = {}): PruneResult {
	const entries = listCacheEntries(opts.cacheDir);
	const protect = new Set(opts.protectVersions ?? []);
	const dryRun = opts.dryRun ?? false;
	const now = Date.now();

	const reasons: Record<string, string> = {};
	const evicted: CacheEntry[] = [];
	const kept: CacheEntry[] = [];

	const protectedEntries: CacheEntry[] = [];
	const candidates: CacheEntry[] = [];

	for (const e of entries) {
		if (e.inUse) {
			protectedEntries.push(e);
			continue;
		}
		if (protect.has(e.version)) {
			protectedEntries.push(e);
			continue;
		}
		candidates.push(e);
	}

	candidates.sort((a, b) => {
		const v = compareVersionsSafe(a.version, b.version);
		if (v !== 0) return v;
		return a.mtimeMs - b.mtimeMs;
	});

	const evict = (e: CacheEntry, reason: string) => {
		evicted.push(e);
		reasons[e.basename] = reason;
		if (!dryRun) {
			try { unlinkSync(e.path); } catch { /* best-effort */ }
		}
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

	if (opts.maxSizeBytes !== undefined) {
		const cap = opts.maxSizeBytes;
		const totalSize = (es: CacheEntry[]) => es.reduce((s, x) => s + x.sizeBytes, 0);
		let total = totalSize(protectedEntries) + totalSize(keptSoFar);
		while (total > cap && keptSoFar.length > 0) {
			const victim = keptSoFar.shift();
			if (!victim) break;
			evict(victim, `size cap ${cap} exceeded (oldest version)`);
			total -= victim.sizeBytes;
		}
	}

	for (const e of protectedEntries) {
		kept.push(e);
		if (e.inUse) reasons[e.basename] ??= "in use";
		else reasons[e.basename] ??= `protected (version ${e.version})`;
	}
	for (const e of keptSoFar) {
		kept.push(e);
		reasons[e.basename] ??= "kept";
	}

	const freedBytes = evicted.reduce((s, e) => s + e.sizeBytes, 0);
	return { evicted, kept, freedBytes, reasons };
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
			return { evicted: [], kept: entries, freedBytes: 0, reasons: {} };
		}
		const result = pruneCache({
			cacheDir: opts.cacheDir,
			maxSizeBytes: cap,
			protectVersions: opts.protectVersions,
		});
		if (opts.logger && result.evicted.length > 0) {
			opts.logger(`cache: evicted ${result.evicted.length} image(s), freed ${(result.freedBytes / 1024 / 1024).toFixed(1)} MiB`);
		}
		return result;
	} catch (e) {
		if (opts.logger) {
			opts.logger(`cache: auto-prune skipped: ${e instanceof Error ? e.message : String(e)}`);
		}
		return { evicted: [], kept: [], freedBytes: 0, reasons: {} };
	}
}
