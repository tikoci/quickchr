import { describe, test, expect } from "bun:test";
import { isValidVersion, chrDownloadUrl, packagesDownloadUrl, chrImageBasename, generateMachineName } from "../../src/lib/versions.ts";

describe("isValidVersion", () => {
	test("accepts standard versions", () => {
		expect(isValidVersion("7.22.1")).toBe(true);
		expect(isValidVersion("7.22")).toBe(true);
		expect(isValidVersion("8.0.1")).toBe(true);
	});

	test("accepts beta/rc versions", () => {
		expect(isValidVersion("7.23beta1")).toBe(true);
		expect(isValidVersion("7.23rc2")).toBe(true);
	});

	test("rejects invalid versions", () => {
		expect(isValidVersion("")).toBe(false);
		expect(isValidVersion("abc")).toBe(false);
		expect(isValidVersion("7")).toBe(false);
		expect(isValidVersion("7.22.1.2")).toBe(false);
		expect(isValidVersion("v7.22.1")).toBe(false);
	});
});

describe("chrDownloadUrl", () => {
	test("generates x86 URL", () => {
		expect(chrDownloadUrl("7.22.1", "x86")).toBe(
			"https://download.mikrotik.com/routeros/7.22.1/chr-7.22.1.img.zip",
		);
	});

	test("generates arm64 URL", () => {
		expect(chrDownloadUrl("7.22.1", "arm64")).toBe(
			"https://download.mikrotik.com/routeros/7.22.1/chr-7.22.1-arm64.img.zip",
		);
	});

	test("defaults to x86", () => {
		expect(chrDownloadUrl("7.22.1")).toBe(
			"https://download.mikrotik.com/routeros/7.22.1/chr-7.22.1.img.zip",
		);
	});
});

describe("packagesDownloadUrl", () => {
	test("generates x86 packages URL", () => {
		expect(packagesDownloadUrl("7.22.1", "x86")).toBe(
			"https://download.mikrotik.com/routeros/7.22.1/all_packages-x86-7.22.1.zip",
		);
	});

	test("generates arm64 packages URL", () => {
		expect(packagesDownloadUrl("7.22.1", "arm64")).toBe(
			"https://download.mikrotik.com/routeros/7.22.1/all_packages-arm64-7.22.1.zip",
		);
	});
});

describe("chrImageBasename", () => {
	test("x86 has no suffix", () => {
		expect(chrImageBasename("7.22.1", "x86")).toBe("chr-7.22.1");
	});

	test("arm64 has suffix", () => {
		expect(chrImageBasename("7.22.1", "arm64")).toBe("chr-7.22.1-arm64");
	});
});

describe("generateMachineName", () => {
	test("generates first instance name", () => {
		expect(generateMachineName("7.22.1", "arm64", [])).toBe("7.22.1-arm64-1");
	});

	test("increments when existing names present", () => {
		expect(
			generateMachineName("7.22.1", "arm64", ["7.22.1-arm64-1"]),
		).toBe("7.22.1-arm64-2");
	});

	test("fills gaps", () => {
		expect(
			generateMachineName("7.22.1", "x86", ["7.22.1-x86-1", "7.22.1-x86-2", "7.22.1-x86-3"]),
		).toBe("7.22.1-x86-4");
	});
});
