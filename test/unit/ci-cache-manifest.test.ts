import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { zipSync } from "fflate";
import {
	integrationCacheManifest,
	prefetchIntegrationCacheManifest,
	reconcileIntegrationCacheManifest,
	verifyIntegrationCacheManifest,
} from "../../scripts/ci-cache-manifest.ts";
import { chrImageBasename } from "../../src/lib/versions.ts";
import { downloadPackages } from "../../src/lib/packages.ts";

const TMP = join(import.meta.dir, ".tmp-ci-cache-manifest-test");

function validRawImage(): Uint8Array {
	const image = Buffer.alloc(1024);
	image[510] = 0x55;
	image[511] = 0xaa;
	image.writeUInt32LE(1, 454);
	image.writeUInt32LE(1, 458);
	return image;
}

async function writeCompletePackageCache(version: string, arch: "x86" | "arm64"): Promise<void> {
	const packages = {
		[`container-${version}-${arch}.npk`]: new TextEncoder().encode("container package"),
		[`dude-${version}-${arch}.npk`]: new TextEncoder().encode("dude package"),
	};
	await Bun.write(join(TMP, `all_packages-${arch}-${version}.zip`), zipSync(packages));
	await downloadPackages(version, arch, TMP);
}

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
	test("requires every structurally valid image and complete package extraction", async () => {
		const manifest = integrationCacheManifest("7.24.4", "x86");
		for (const artifact of manifest) {
			if (artifact.kind === "image") {
				await Bun.write(join(TMP, `${chrImageBasename(artifact.version, artifact.arch)}.img`), validRawImage());
				continue;
			}
			await writeCompletePackageCache(artifact.version, artifact.arch);
		}

		expect(await verifyIntegrationCacheManifest(manifest, TMP)).toEqual({
			matches: true,
			missing: [],
			present: manifest.map((artifact) => `${artifact.kind}:${artifact.arch}:${artifact.version}`),
		});
	});

	test("reports a truncated image instead of blessing a partial cache", async () => {
		const manifest = [{ kind: "image" as const, version: "7.24.4", arch: "x86" as const }];
		await Bun.write(join(TMP, "chr-7.24.4.img"), validRawImage().subarray(0, 700));
		expect(await verifyIntegrationCacheManifest(manifest, TMP)).toEqual({
			matches: false,
			missing: ["image:x86:7.24.4"],
			present: [],
		});
	});

	test("reports a package extraction missing one recorded NPK", async () => {
		const manifest = [{ kind: "packages" as const, version: "7.24.4", arch: "x86" as const }];
		await writeCompletePackageCache("7.24.4", "x86");
		unlinkSync(join(TMP, "packages-x86-7.24.4", "dude-7.24.4-x86.npk"));

		expect(await verifyIntegrationCacheManifest(manifest, TMP)).toEqual({
			matches: false,
			missing: ["packages:x86:7.24.4"],
			present: [],
		});
	});
});

describe("reconcileIntegrationCacheManifest", () => {
	test("removes recognized prior-target artifacts but preserves unrelated files", async () => {
		const manifest = [{ kind: "image" as const, version: "7.24.4", arch: "x86" as const }];
		await Bun.write(join(TMP, "chr-7.24.4.img"), validRawImage());
		await Bun.write(join(TMP, "chr-7.23.1.img"), validRawImage());
		await Bun.write(join(TMP, "all_packages-x86-7.23.1.zip"), "old zip");
		mkdirSync(join(TMP, "packages-x86-7.23.1"), { recursive: true });
		await Bun.write(join(TMP, "packages-x86-7.23.1", "container.npk"), "old package");
		await Bun.write(join(TMP, "README.txt"), "unrelated");

		expect(reconcileIntegrationCacheManifest(manifest, TMP)).toEqual([
			"all_packages-x86-7.23.1.zip",
			"chr-7.23.1.img",
			"packages-x86-7.23.1",
		]);
		expect(Bun.file(join(TMP, "chr-7.24.4.img")).size).toBeGreaterThan(0);
		expect(Bun.file(join(TMP, "README.txt")).size).toBeGreaterThan(0);
		expect((await verifyIntegrationCacheManifest(manifest, TMP)).matches).toBe(true);
	});
});
