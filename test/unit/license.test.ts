/**
 * Unit tests for license types, credential utilities, and package lists.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { LICENSE_LEVELS, KNOWN_PACKAGES_X86, KNOWN_PACKAGES_ARM64, knownPackagesForArch } from "../../src/lib/types.ts";
import { credentialStorageLabel } from "../../src/lib/credentials.ts";
import { renewLicense, getLicenseInfo } from "../../src/lib/license.ts";

describe("LicenseLevel constants", () => {
	test("LICENSE_LEVELS contains all valid levels", () => {
		expect(LICENSE_LEVELS).toEqual(["p1", "p10", "unlimited"]);
	});
});

describe("KNOWN_PACKAGES_X86 (7.22.1 baseline)", () => {
	test("contains the correct 7.22.1 x86 package set", () => {
		const expected = [
			"calea",
			"container",
			"dude",
			"gps",
			"iot",
			"openflow",
			"rose-storage",
			"tr069-client",
			"ups",
			"user-manager",
			"wireless",
		];
		// Every string in the static known list must be present
		for (const pkg of expected) expect(([...KNOWN_PACKAGES_X86] as string[])).toContain(pkg);
		expect([...KNOWN_PACKAGES_X86]).toHaveLength(expected.length);
	});

	test("does NOT include zerotier (x86 7.22.1 zip has no zerotier)", () => {
		expect(KNOWN_PACKAGES_X86).not.toContain("zerotier");
	});

	test("does NOT include wifi-qcom (x86 has no wireless hardware packages)", () => {
		expect(KNOWN_PACKAGES_X86).not.toContain("wifi-qcom");
	});
});

describe("KNOWN_PACKAGES_ARM64 (7.22.1 baseline)", () => {
	test("contains the correct 7.22.1 arm64 package set", () => {
		const expected = [
			"calea",
			"container",
			"dude",
			"extra-nic",
			"gps",
			"iot",
			"iot-bt-extra",
			"openflow",
			"rose-storage",
			"switch-marvell",
			"tr069-client",
			"ups",
			"user-manager",
			"wifi-qcom",
			"wifi-qcom-be",
			"wireless",
			"zerotier",
		];
		// Every string in the static known list must be present
		for (const pkg of expected) expect(([...KNOWN_PACKAGES_ARM64] as string[])).toContain(pkg);
		expect([...KNOWN_PACKAGES_ARM64]).toHaveLength(expected.length);
	});

	test("includes zerotier (present in arm64 zip)", () => {
		expect(KNOWN_PACKAGES_ARM64).toContain("zerotier");
	});

	test("uses wifi-qcom-be NOT wifi-qcom-ac (7.22.1 changed the name)", () => {
		expect(KNOWN_PACKAGES_ARM64).toContain("wifi-qcom-be");
		expect(KNOWN_PACKAGES_ARM64).not.toContain("wifi-qcom-ac");
	});
});

describe("knownPackagesForArch", () => {
	test("x86 returns x86 list", () => {
		expect(knownPackagesForArch("x86")).toBe(KNOWN_PACKAGES_X86);
	});

	test("arm64 returns arm64 list", () => {
		expect(knownPackagesForArch("arm64")).toBe(KNOWN_PACKAGES_ARM64);
	});
});

describe("credentialStorageLabel", () => {
	test("returns a non-empty string for current platform", () => {
		const label = credentialStorageLabel();
		expect(typeof label).toBe("string");
		expect(label.length).toBeGreaterThan(0);
	});
});

// --- Error path tests via mocked fetch ---
// These test the network failure and HTTP error branches which are never
// reached in normal integration tests (cached image is always used).

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("renewLicense — error paths", () => {
	test("throws PROCESS_FAILED on network error", async () => {
		globalThis.fetch = (() => Promise.reject(new Error("Connection refused"))) as unknown as typeof fetch;
		const err = await renewLicense(9100, { account: "a@example.com", password: "pass", level: "p1" }).catch((e) => e);
		expect(err.code).toBe("PROCESS_FAILED");
		expect(err.message).toMatch(/Connection refused/);
	});

	test("throws PROCESS_FAILED on HTTP error response", async () => {
		globalThis.fetch = (() =>
			Promise.resolve(new Response("Bad credentials", { status: 401 }))) as unknown as typeof fetch;
		const err = await renewLicense(9100, { account: "a@example.com", password: "wrong" }).catch((e) => e);
		expect(err.code).toBe("PROCESS_FAILED");
		expect(err.message).toMatch(/401/);
	});
});

describe("getLicenseInfo — error paths", () => {
	test("throws PROCESS_FAILED on network error", async () => {
		globalThis.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
		const err = await getLicenseInfo(9100).catch((e) => e);
		expect(err.code).toBe("PROCESS_FAILED");
		expect(err.message).toMatch(/ECONNREFUSED/);
	});

	test("throws PROCESS_FAILED on HTTP error response", async () => {
		globalThis.fetch = (() =>
			Promise.resolve(new Response("Forbidden", { status: 403 }))) as unknown as typeof fetch;
		const err = await getLicenseInfo(9100).catch((e) => e);
		expect(err.code).toBe("PROCESS_FAILED");
		expect(err.message).toMatch(/403/);
	});

	test("normalises missing level field to 'free'", async () => {
		// RouterOS omits 'level' on fresh unlicensed CHRs — getLicenseInfo fills it in.
		globalThis.fetch = (() =>
			Promise.resolve(
				new Response(JSON.stringify({ "system-id": "ABCD1234" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)) as unknown as typeof fetch;
		const info = await getLicenseInfo(9100);
		expect(info.level).toBe("free");
		expect(info["system-id"]).toBe("ABCD1234");
	});

	test("preserves level when already present in response", async () => {
		globalThis.fetch = (() =>
			Promise.resolve(
				new Response(JSON.stringify({ level: "p1", deadline: "2026-12-31" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)) as unknown as typeof fetch;
		const info = await getLicenseInfo(9100);
		expect(info.level).toBe("p1");
	});
});
