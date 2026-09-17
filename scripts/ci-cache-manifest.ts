#!/usr/bin/env bun
/** Declarative cache content for a full quickchr integration leg (#144). */

import { appendFileSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { cacheAdd } from "../src/lib/cache-api.ts";
import { downloadPackages } from "../src/lib/packages.ts";
import { getCacheDir } from "../src/lib/state.ts";
import { ARCHES, type Arch } from "../src/lib/types.ts";
import { chrImageBasename, isValidVersion } from "../src/lib/versions.ts";

export const PINNED_IMAGE_VERSIONS = ["7.20.7", "7.20.8"] as const;
export const PINNED_PACKAGE_VERSION = "7.22.1";

export interface CacheArtifact {
	kind: "image" | "packages";
	version: string;
	arch: Arch;
}

/**
 * The complete external-download set used by a full integration leg.
 *
 * Keep this list aligned with test/integration. Changing it changes the cache
 * content contract and therefore requires a CACHE_KEY_GENERATION bump.
 */
export function integrationCacheManifest(targetVersion: string, targetArch: Arch): CacheArtifact[] {
	const artifacts: CacheArtifact[] = [
		{ kind: "image", version: targetVersion, arch: targetArch },
		...PINNED_IMAGE_VERSIONS.map((version) => ({ kind: "image" as const, version, arch: targetArch })),
		{ kind: "packages", version: targetVersion, arch: targetArch },
		...ARCHES.map((arch) => ({ kind: "packages" as const, version: PINNED_PACKAGE_VERSION, arch })),
	];
	return artifacts.filter(
		(artifact, index) => artifacts.findIndex(
			(candidate) => candidate.kind === artifact.kind && candidate.version === artifact.version && candidate.arch === artifact.arch,
		) === index,
	);
}

export interface ManifestVerification {
	matches: boolean;
	missing: string[];
	present: string[];
}

function nonEmptyFile(path: string): boolean {
	try {
		const stat = statSync(path);
		return stat.isFile() && stat.size > 0;
	} catch {
		return false;
	}
}

function packagesComplete(cacheDir: string, artifact: CacheArtifact): boolean {
	const zip = join(cacheDir, `all_packages-${artifact.arch}-${artifact.version}.zip`);
	const dir = join(cacheDir, `packages-${artifact.arch}-${artifact.version}`);
	if (!nonEmptyFile(zip) || !existsSync(dir)) return false;
	try {
		return readdirSync(dir).some((name) => name.endsWith(".npk") && nonEmptyFile(join(dir, name)));
	} catch {
		return false;
	}
}

/** Verify every declared image, package archive, and extracted package set. */
export function verifyIntegrationCacheManifest(
	manifest: CacheArtifact[],
	cacheDir: string = getCacheDir(),
): ManifestVerification {
	const missing: string[] = [];
	const present: string[] = [];
	for (const artifact of manifest) {
		const label = `${artifact.kind}:${artifact.arch}:${artifact.version}`;
		const ok = artifact.kind === "image"
			? nonEmptyFile(join(cacheDir, `${chrImageBasename(artifact.version, artifact.arch)}.img`))
			: packagesComplete(cacheDir, artifact);
		(ok ? present : missing).push(label);
	}
	return { matches: missing.length === 0, missing, present };
}

export interface CachePrefetchDependencies {
	cacheImage?: typeof cacheAdd;
	cachePackages?: typeof downloadPackages;
}

function artifactCachePaths(manifest: CacheArtifact[]): Set<string> {
	const paths = new Set<string>();
	for (const artifact of manifest) {
		if (artifact.kind === "image") {
			paths.add(`${chrImageBasename(artifact.version, artifact.arch)}.img`);
		} else {
			paths.add(`all_packages-${artifact.arch}-${artifact.version}.zip`);
			paths.add(`packages-${artifact.arch}-${artifact.version}`);
		}
	}
	return paths;
}

function isManagedArtifactPath(name: string): boolean {
	return /^chr-.+\.img(?:\.zip)?$/.test(name) ||
		/^all_packages-(?:x86|arm64)-.+\.zip$/.test(name) ||
		/^packages-(?:x86|arm64)-.+$/.test(name);
}

/**
 * Remove prior-target artifacts inherited through an actions/cache restore key.
 *
 * Without reconciliation each new resolved version would carry every older
 * target forward. Eventually quickchr's 2 GiB image cap would evict the old
 * 7.20.7/7.20.8 fixtures during the suite and put their downloads back inside
 * a test file. This script owns the CI cache, so only recognized quickchr cache
 * paths outside the declared manifest are removed; unrelated files are kept.
 */
export function reconcileIntegrationCacheManifest(
	manifest: CacheArtifact[],
	cacheDir: string = getCacheDir(),
): string[] {
	if (!existsSync(cacheDir)) return [];
	const keep = artifactCachePaths(manifest);
	const removed: string[] = [];
	for (const entry of readdirSync(cacheDir, { withFileTypes: true })) {
		if (!isManagedArtifactPath(entry.name) || keep.has(entry.name)) continue;
		rmSync(join(cacheDir, entry.name), { recursive: entry.isDirectory(), force: true });
		removed.push(entry.name);
	}
	return removed.sort();
}

/** Download every artifact in a manifest through quickchr's production paths. */
export async function prefetchIntegrationCacheManifest(
	manifest: CacheArtifact[],
	cacheDir: string = getCacheDir(),
	deps: CachePrefetchDependencies = {},
): Promise<void> {
	const cacheImage = deps.cacheImage ?? cacheAdd;
	const cachePackages = deps.cachePackages ?? downloadPackages;
	for (const artifact of manifest) {
		if (artifact.kind === "image") {
			await cacheImage({ version: artifact.version, arch: artifact.arch, cacheDir });
		} else {
			await cachePackages(artifact.version, artifact.arch, cacheDir);
		}
	}
}

function flag(args: string[], name: string): string | undefined {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : undefined;
}

function emit(outputs: Record<string, string>): void {
	const text = Object.entries(outputs).map(([key, value]) => `${key}=${value}`).join("\n");
	const file = process.env.GITHUB_OUTPUT;
	if (file) appendFileSync(file, `${text}\n`);
	console.log(text);
}

if (import.meta.main) {
	const [mode, ...args] = process.argv.slice(2);
	try {
		const version = flag(args, "version") ?? "";
		const arch = flag(args, "arch") ?? "";
		if (!isValidVersion(version)) throw new Error(`--version must be a concrete RouterOS version, got "${version}"`);
		if (!(ARCHES as readonly string[]).includes(arch)) throw new Error(`--arch must be one of ${ARCHES.join(", ")}, got "${arch}"`);
		const manifest = integrationCacheManifest(version, arch as Arch);

		if (mode === "prefetch") {
			console.log(`Prefetching ${manifest.length} declared cache artifacts:`);
			for (const artifact of manifest) console.log(`  - ${artifact.kind}:${artifact.arch}:${artifact.version}`);
			await prefetchIntegrationCacheManifest(manifest);
			const removed = reconcileIntegrationCacheManifest(manifest);
			console.log(`cache manifest removed obsolete artifacts: ${removed.join(", ") || "(none)"}`);
		} else if (mode !== "verify") {
			throw new Error("usage: ci-cache-manifest.ts prefetch|verify --version <v> --arch <x86|arm64>");
		}

		const result = verifyIntegrationCacheManifest(manifest);
		console.log(`cache manifest present: ${result.present.join(", ") || "(none)"}`);
		if (result.missing.length > 0) console.error(`cache manifest missing: ${result.missing.join(", ")}`);
		emit({ matches: String(result.matches) });
		if (!result.matches) process.exit(1);
	} catch (error) {
		console.error(`::error::ci-cache-manifest${mode ? ` ${mode}` : ""}: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}
