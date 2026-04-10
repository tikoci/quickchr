/**
 * Unit tests for package listing functionality.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listAvailablePackages, findPackageFile, downloadPackages } from "../../src/lib/packages.ts";

describe("listAvailablePackages", () => {
	let dir: string;

	beforeEach(() => {
		dir = join(tmpdir(), `quickchr-test-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("parses arm64 .npk filenames to package names", () => {
		// Mimic actual filenames from all_packages-arm64-7.22.1.zip
		const files = [
			"calea-7.22.1-arm64.npk",
			"container-7.22.1-arm64.npk",
			"dude-7.22.1-arm64.npk",
			"extra-nic-7.22.1-arm64.npk",
			"iot-7.22.1-arm64.npk",
			"iot-bt-extra-7.22.1-arm64.npk",
			"wifi-qcom-7.22.1-arm64.npk",
			"wifi-qcom-be-7.22.1-arm64.npk",
			"zerotier-7.22.1-arm64.npk",
		];
		for (const f of files) writeFileSync(join(dir, f), "");

		const names = listAvailablePackages(dir);
		expect(names).toEqual([
			"calea",
			"container",
			"dude",
			"extra-nic",
			"iot",
			"iot-bt-extra",
			"wifi-qcom",
			"wifi-qcom-be",
			"zerotier",
		]);
	});

	test("parses x86 .npk filenames (no arch suffix)", () => {
		const files = [
			"container-7.22.1.npk",
			"dude-7.22.1.npk",
			"openflow-7.22.1.npk",
			"wireless-7.22.1.npk",
		];
		for (const f of files) writeFileSync(join(dir, f), "");

		const names = listAvailablePackages(dir);
		expect(names).toEqual(["container", "dude", "openflow", "wireless"]);
	});

	test("returns empty array for missing directory", () => {
		const names = listAvailablePackages(join(tmpdir(), "does-not-exist-999"));
		expect(names).toEqual([]);
	});

	test("ignores non-.npk files", () => {
		writeFileSync(join(dir, "README.txt"), "");
		writeFileSync(join(dir, "container-7.22.1-arm64.npk"), "");
		writeFileSync(join(dir, "something.zip"), "");

		const names = listAvailablePackages(dir);
		expect(names).toEqual(["container"]);
	});

	test("returns sorted names", () => {
		const files = [
			"zerotier-7.22.1-arm64.npk",
			"calea-7.22.1-arm64.npk",
			"iot-7.22.1-arm64.npk",
		];
		for (const f of files) writeFileSync(join(dir, f), "");

		const names = listAvailablePackages(dir);
		expect(names).toEqual(["calea", "iot", "zerotier"]);
	});

	test("handles beta version filenames", () => {
		writeFileSync(join(dir, "container-7.23beta5-arm64.npk"), "");
		writeFileSync(join(dir, "dude-7.23beta5.npk"), "");

		const names = listAvailablePackages(dir);
		expect(names).toEqual(["container", "dude"]);
	});
});

describe("findPackageFile", () => {
	let dir: string;

	beforeEach(() => {
		dir = join(tmpdir(), `quickchr-find-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("finds exact package by name", () => {
		writeFileSync(join(dir, "container-7.22.1-arm64.npk"), "");
		const result = findPackageFile(dir, "container");
		expect(result).toContain("container-7.22.1-arm64.npk");
	});

	test("iot does NOT match iot-bt-extra (prefix collision fix)", () => {
		// Both files present — iot must resolve to the iot file, not iot-bt-extra
		writeFileSync(join(dir, "iot-7.22.1-arm64.npk"), "");
		writeFileSync(join(dir, "iot-bt-extra-7.22.1-arm64.npk"), "");

		const iotResult = findPackageFile(dir, "iot");
		expect(iotResult).toContain("iot-7.22.1-arm64.npk");
		expect(iotResult).not.toContain("iot-bt-extra");

		const iotBtResult = findPackageFile(dir, "iot-bt-extra");
		expect(iotBtResult).toContain("iot-bt-extra-7.22.1-arm64.npk");
	});

	test("wifi-qcom does NOT match wifi-qcom-be (prefix collision fix)", () => {
		writeFileSync(join(dir, "wifi-qcom-7.22.1-arm64.npk"), "");
		writeFileSync(join(dir, "wifi-qcom-be-7.22.1-arm64.npk"), "");

		const qcomResult = findPackageFile(dir, "wifi-qcom");
		expect(qcomResult).toContain("wifi-qcom-7.22.1-arm64.npk");
		expect(qcomResult).not.toContain("wifi-qcom-be");

		const qcomBeResult = findPackageFile(dir, "wifi-qcom-be");
		expect(qcomBeResult).toContain("wifi-qcom-be-7.22.1-arm64.npk");
	});

	test("returns undefined for missing package", () => {
		writeFileSync(join(dir, "container-7.22.1-arm64.npk"), "");
		expect(findPackageFile(dir, "dude")).toBeUndefined();
	});

	test("returns undefined for missing directory", () => {
		expect(findPackageFile(join(tmpdir(), "no-such-dir-999"), "iot")).toBeUndefined();
	});
});

// --- Mock-fetch helper ---

function makeMockFetch(fn: (url: string | URL | Request, init?: RequestInit) => Promise<Response>) {
	return Object.assign(fn, { preconnect: (_url: string | URL) => {} }) as typeof fetch;
}

describe("downloadPackages", () => {
	let cacheDir: string;
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		cacheDir = join(tmpdir(), `quickchr-pkgs-${Date.now()}`);
		mkdirSync(cacheDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(cacheDir, { recursive: true, force: true });
		globalThis.fetch = originalFetch;
	});

	test("returns cached extractDir immediately without fetching", async () => {
		const extractDir = join(cacheDir, "packages-x86-7.22.1");
		mkdirSync(extractDir, { recursive: true });

		let fetchCalled = false;
		globalThis.fetch = makeMockFetch(() => {
			fetchCalled = true;
			return Promise.resolve(new Response(""));
		});

		const result = await downloadPackages("7.22.1", "x86", cacheDir);
		expect(result).toBe(extractDir);
		expect(fetchCalled).toBe(false);
	});

	test("throws DOWNLOAD_FAILED when server returns non-ok status", async () => {
		globalThis.fetch = makeMockFetch(() =>
			Promise.resolve(new Response("Not Found", { status: 404 })),
		);
		await expect(downloadPackages("7.22.1", "x86", cacheDir)).rejects.toMatchObject({
			code: "DOWNLOAD_FAILED",
		});
	});

	test("throws PROCESS_FAILED when zip extraction fails (corrupt zip)", async () => {
		// Pre-create a corrupt zip file so the download step is skipped
		const zipPath = join(cacheDir, "all_packages-x86-7.22.1.zip");
		writeFileSync(zipPath, "this is not a valid zip");

		await expect(downloadPackages("7.22.1", "x86", cacheDir)).rejects.toMatchObject({
			code: "PROCESS_FAILED",
			message: expect.stringContaining("Failed to extract packages"),
		});
	});
});
