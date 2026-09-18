/** Public cache operations for CI consumers and the quickchr CLI. */

import { join } from "node:path";
import { ensureCachedImage, isUsableCachedImage } from "./images.ts";
import type { ProgressLogger } from "./log.ts";
import { getCacheDir } from "./state.ts";
import { ARCHES, CHANNELS, QuickCHRError, type Arch, type Channel } from "./types.ts";
import { chrImageBasename, isValidVersion, resolveVersion } from "./versions.ts";

export const CACHE_VERSION_UNRESOLVED = "unresolved";
const CACHE_VERSION_MAX_LENGTH = 32;

export interface CacheTargetOptions {
	/** Resolve this RouterOS channel. Mutually exclusive with `version`. */
	channel?: Channel;
	/** Use this concrete RouterOS version without a network resolution request. */
	version?: string;
	/** Override the cache directory. Defaults to quickchr's platform-correct cache. */
	cacheDir?: string;
	/** CHR architecture. `auto` and omission select the Bun process architecture. */
	arch?: Arch | "auto";
}

export interface CacheKeyResult {
	dir: string;
	/** Concrete RouterOS version, or `unresolved` when channel resolution is offline. */
	version: string;
	arch: Arch;
}

export interface CacheAddOptions extends CacheTargetOptions {
	logger?: ProgressLogger;
}

export interface CacheAddResult extends CacheKeyResult {
	path: string;
	cacheHit: boolean;
}

export type CacheVersionResolver = (channel: Channel) => Promise<string>;

function validateTarget(options: CacheTargetOptions): { channel?: Channel; version?: string } {
	if (options.channel !== undefined && options.version !== undefined) {
		throw new QuickCHRError("INVALID_VERSION", "Choose either a RouterOS channel or a concrete version, not both");
	}
	if (options.channel !== undefined && !(CHANNELS as readonly string[]).includes(options.channel)) {
		throw new QuickCHRError(
			"INVALID_VERSION",
			`Invalid RouterOS channel "${options.channel}" — expected one of ${CHANNELS.join(", ")}`,
		);
	}
	if (options.version !== undefined && !isValidVersion(options.version)) {
		throw new QuickCHRError("INVALID_VERSION", `Invalid RouterOS version: ${options.version}`);
	}
	return { channel: options.channel, version: options.version };
}

async function concreteVersion(
	options: CacheTargetOptions,
	resolver: CacheVersionResolver,
): Promise<{ channel?: Channel; version: string }> {
	const target = validateTarget(options);
	if (target.version !== undefined) return { version: target.version };
	const channel = target.channel ?? "stable";
	const version = await resolver(channel);
	if (!isValidVersion(version)) {
		throw new QuickCHRError(
			"INVALID_VERSION",
			`Unexpected version "${version}" resolved for channel "${channel}"`,
		);
	}
	return { channel, version };
}

function concreteArch(arch: Arch | "auto" | undefined): Arch {
	if (arch === undefined || arch === "auto") return process.arch === "arm64" ? "arm64" : "x86";
	if (!(ARCHES as readonly string[]).includes(arch)) {
		throw new QuickCHRError("INVALID_ARCH", `Invalid architecture "${arch}" — expected one of ${ARCHES.join(", ")}, auto`);
	}
	return arch;
}

/**
 * Return quickchr's cache directory and the concrete version for a CI key.
 *
 * An explicit version is validated and returned without a network call. A
 * channel resolution failure degrades to the stable `unresolved` sentinel so
 * cache lookup cannot make an otherwise useful offline job fail.
 */
export async function cacheKey(
	options: CacheTargetOptions = {},
	resolver: CacheVersionResolver = resolveVersion,
): Promise<CacheKeyResult> {
	const target = validateTarget(options);
	const dir = options.cacheDir ?? getCacheDir();
	const arch = concreteArch(options.arch);
	if (target.version !== undefined) {
		return {
			dir,
			version: target.version.length <= CACHE_VERSION_MAX_LENGTH ? target.version : CACHE_VERSION_UNRESOLVED,
			arch,
		};
	}
	try {
		const resolved = await concreteVersion(options, resolver);
		return {
			dir,
			version: resolved.version.length <= CACHE_VERSION_MAX_LENGTH ? resolved.version : CACHE_VERSION_UNRESOLVED,
			arch,
		};
	} catch (error) {
		if (error instanceof QuickCHRError && error.code === "DOWNLOAD_FAILED") {
			return { dir, version: CACHE_VERSION_UNRESOLVED, arch };
		}
		throw error;
	}
}

/** Resolve and cache one CHR image without creating or booting a machine. */
export async function cacheAdd(
	options: CacheAddOptions = {},
	resolver: CacheVersionResolver = resolveVersion,
): Promise<CacheAddResult> {
	const resolved = await concreteVersion(options, resolver);
	if (resolved.version.length > CACHE_VERSION_MAX_LENGTH) {
		throw new QuickCHRError("INVALID_VERSION", `RouterOS version is too long: ${resolved.version}`);
	}
	const arch = concreteArch(options.arch);
	const dir = options.cacheDir ?? getCacheDir();
	const expectedPath = join(dir, `${chrImageBasename(resolved.version, arch)}.img`);
	const cacheHit = await isUsableCachedImage(expectedPath);

	try {
		const path = await ensureCachedImage(resolved.version, arch, dir, options.logger);
		return { dir, version: resolved.version, arch, path, cacheHit };
	} catch (error) {
		if (resolved.channel && error instanceof QuickCHRError) {
			throw new QuickCHRError(
				error.code,
				`Failed to cache channel "${resolved.channel}" -> ${resolved.version} (${arch}): ${error.message}`,
				error.installHint,
			);
		}
		throw error;
	}
}
