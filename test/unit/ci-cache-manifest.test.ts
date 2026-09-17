import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	integrationCacheManifest,
	prefetchIntegrationCacheManifest,
	reconcileIntegrationCacheManifest,
	verifyIntegrationCacheManifest,
} from "../../scripts/ci-cache-manifest.ts";
import { chrImageBasename } from "../../src/lib/versions.ts";

const TMP = join(import.meta.dir, ".tmp-ci-cache-manifest-test");

beforeEach(() => {
	rmSync(TMP, { recursive: true, force: true });
	mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
	rmSync(TMP, { recursive: true, force: true });
});

describe("integrationCacheManifest", () => {
	test("declares the target, fixed image fixtures, and every package archive", () => {
		expect(integrationCacheManifest("7.24.4", "x86")).toEqual([
			{ kind: "image", version: "7.24.4", arch: "x86" },
			{ kind: "image", version: "7.20.7", arch: "x86" },
			{ kind: "image", version: "7.20.8", arch: "x86" },
			{ kind: "packages", version: "7.24.4", arch: "x86" },
			{ kind: "packages", version: "7.22.1", arch: "arm64" },
			{ kind: "packages", version: "7.22.1", arch: "x86" },
		]);
	});

	test("deduplicates a target that is also a fixed package artifact", () => {
		const packages = integrationCacheManifest("7.22.1", "arm64").filter((artifact) => artifact.kind === "packages");
		expect(packages).toEqual([
			{ kind: "packages", version: "7.22.1", arch: "arm64" },
			{ kind: "packages", version: "7.22.1", arch: "x86" },
		]);
	});
});

describe("prefetchIntegrationCacheManifest", () => {
	test("routes images and packages through their production cache APIs", async () => {
		const calls: string[] = [];
		const manifest = integrationCacheManifest("7.24.4", "x86");
		await prefetchIntegrationCacheManifest(manifest, TMP, {
			cacheImage: async (options) => {
				calls.push(`image:${options?.arch}:${options?.version}`);
				return { dir: TMP, version: options?.version ?? "", arch: "x86", path: "unused", cacheHit: false };
			},
			cachePackages: async (version, arch) => {
				calls.push(`packages:${arch}:${version}`);
				return "unused";
			},
		});
		expect(calls).toEqual(manifest.map((artifact) => `${artifact.kind}:${artifact.arch}:${artifact.version}`));
	});
});

describe("verifyIntegrationCacheManifest", () => {
	test("requires every non-empty image, package zip, and extracted package set", () => {
		const manifest = integrationCacheManifest("7.24.4", "x86");
		for (const artifact of manifest) {
			if (artifact.kind === "image") {
				writeFileSync(join(TMP, `${chrImageBasename(artifact.version, artifact.arch)}.img`), "image");
				continue;
			}
			writeFileSync(join(TMP, `all_packages-${artifact.arch}-${artifact.version}.zip`), "zip");
			const dir = join(TMP, `packages-${artifact.arch}-${artifact.version}`);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, `container-${artifact.version}-${artifact.arch}.npk`), "package");
		}

		expect(verifyIntegrationCacheManifest(manifest, TMP)).toEqual({
			matches: true,
			missing: [],
			present: manifest.map((artifact) => `${artifact.kind}:${artifact.arch}:${artifact.version}`),
		});
	});

	test("reports an empty or incomplete artifact instead of blessing a partial cache", () => {
		const manifest = [{ kind: "image" as const, version: "7.24.4", arch: "x86" as const }];
		writeFileSync(join(TMP, "chr-7.24.4.img"), "");
		expect(verifyIntegrationCacheManifest(manifest, TMP)).toEqual({
			matches: false,
			missing: ["image:x86:7.24.4"],
			present: [],
		});
	});
});

describe("reconcileIntegrationCacheManifest", () => {
	test("removes recognized prior-target artifacts but preserves unrelated files", () => {
		const manifest = [{ kind: "image" as const, version: "7.24.4", arch: "x86" as const }];
		writeFileSync(join(TMP, "chr-7.24.4.img"), "keep");
		writeFileSync(join(TMP, "chr-7.23.1.img"), "old image");
		writeFileSync(join(TMP, "all_packages-x86-7.23.1.zip"), "old zip");
		mkdirSync(join(TMP, "packages-x86-7.23.1"), { recursive: true });
		writeFileSync(join(TMP, "packages-x86-7.23.1", "container.npk"), "old package");
		writeFileSync(join(TMP, "README.txt"), "unrelated");

		expect(reconcileIntegrationCacheManifest(manifest, TMP)).toEqual([
			"all_packages-x86-7.23.1.zip",
			"chr-7.23.1.img",
			"packages-x86-7.23.1",
		]);
		expect(Bun.file(join(TMP, "chr-7.24.4.img")).size).toBeGreaterThan(0);
		expect(Bun.file(join(TMP, "README.txt")).size).toBeGreaterThan(0);
		expect(verifyIntegrationCacheManifest(manifest, TMP).matches).toBe(true);
	});
});
