import { describe, test, expect, beforeAll } from "bun:test";

/**
 * Integration tests for license and package install functionality.
 *
 * Core tests (QUICKCHR_INTEGRATION=1): boot a real CHR, query license info,
 * verify getLicenseInfo returns a free-tier result.
 *
 * License renewal tests (additionally require MIKROTIK_ACCOUNT + MIKROTIK_PASSWORD):
 * actually calls /system/license/renew against MikroTik.com servers.
 *
 * Package enumeration tests require only QUICKCHR_INTEGRATION=1 and network access.
 */

const SKIP = !process.env.QUICKCHR_INTEGRATION;
const HAS_CREDS = !!process.env.MIKROTIK_ACCOUNT && !!process.env.MIKROTIK_PASSWORD;

describe.skipIf(SKIP)("license — getLicenseInfo on fresh CHR", () => {
	beforeAll(async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		const existing = QuickCHR.get("integration-license-test");
		if (existing) {
			try { await existing.stop(); } catch { /* ignore */ }
			try { await existing.remove(); } catch { /* ignore */ }
		}
	});

	test("fresh CHR reports free license", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		const { getLicenseInfo } = await import("../../src/lib/license.ts");

		const arch = process.arch === "arm64" ? "arm64" : "x86";
		let instance: Awaited<ReturnType<typeof QuickCHR.start>> | undefined;

		try {
			instance = await QuickCHR.start({
				channel: "stable",
				arch,
				background: true,
				name: "integration-license-test",
			});

			const bootTimeout = arch === "arm64" ? 120_000 : 300_000;
			const booted = await instance.waitForBoot(bootTimeout);
			expect(booted).toBe(true);

			const info = await getLicenseInfo(instance.ports.http);
			// A fresh CHR has no registered license — level must be "free".
			// getLicenseInfo normalises absent level to "free" because RouterOS REST
			// omits default/empty fields.
			expect(info.level).toBe("free");
			expect(typeof info["system-id"]).toBe("string");
		} finally {
			if (instance) {
				await instance.stop();
				await instance.remove();
			}
		}
	}, 300_000);
});

describe.skipIf(SKIP || !HAS_CREDS)("license — renewLicense with real credentials", () => {
	beforeAll(async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		const existing = QuickCHR.get("integration-license-renew");
		if (existing) {
			try { await existing.stop(); } catch { /* ignore */ }
			try { await existing.remove(); } catch { /* ignore */ }
		}
	});

	test("renewLicense upgrades from free to p1", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		const { getLicenseInfo } = await import("../../src/lib/license.ts");

		const arch = process.arch === "arm64" ? "arm64" : "x86";
		const account = process.env.MIKROTIK_ACCOUNT ?? "";
			const password = process.env.MIKROTIK_PASSWORD ?? "";
		let instance: Awaited<ReturnType<typeof QuickCHR.start>> | undefined;

		try {
			instance = await QuickCHR.start({
				channel: "stable",
				arch,
				background: true,
				name: "integration-license-renew",
				license: { account, password, level: "p1" },
			});

			const bootTimeout = arch === "arm64" ? 120_000 : 300_000;
			const booted = await instance.waitForBoot(bootTimeout);
			expect(booted).toBe(true);

			// License was already applied during start() — verify state
			expect(instance.state.licenseLevel).toBe("p1");

			// Confirm via REST
			const info = await getLicenseInfo(instance.ports.http);
			expect(info.level).toBe("p1");
		} finally {
			if (instance) {
				await instance.stop();
				await instance.remove();
			}
		}
	}, 300_000);

	test("instance.license() applies license to running CHR", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		const { getLicenseInfo } = await import("../../src/lib/license.ts");

		const arch = process.arch === "arm64" ? "arm64" : "x86";
		const account = process.env.MIKROTIK_ACCOUNT ?? "";
			const password = process.env.MIKROTIK_PASSWORD ?? "";
		let instance: Awaited<ReturnType<typeof QuickCHR.start>> | undefined;

		try {
			// Start WITHOUT license option
			instance = await QuickCHR.start({
				channel: "stable",
				arch,
				background: true,
				name: "integration-license-renew",
			});

			const bootTimeout = arch === "arm64" ? 120_000 : 300_000;
			await instance.waitForBoot(bootTimeout);

			// Apply license via instance method after boot
			await instance.license({ account, password, level: "p10" });
			expect(instance.state.licenseLevel).toBe("p10");

			const info = await getLicenseInfo(instance.ports.http);
			expect(info.level).toBe("p10");
		} finally {
			if (instance) {
				await instance.stop();
				await instance.remove();
			}
		}
	}, 300_000);
});

describe.skipIf(SKIP)("downloadAndListPackages — enumerate from zip", () => {
	test("arm64 packages match 7.22.1 known list", async () => {
		const { downloadAndListPackages } = await import("../../src/lib/packages.ts");
		const { KNOWN_PACKAGES_ARM64 } = await import("../../src/lib/types.ts");

		const packages = await downloadAndListPackages("7.22.1", "arm64");
		expect(packages.length).toBeGreaterThan(0);

		// Every package in the static known list should be in the zip
		for (const pkg of KNOWN_PACKAGES_ARM64) {
			expect(packages).toContain(pkg);
		}
	}, 120_000);

	test("x86 packages match 7.22.1 known list", async () => {
		const { downloadAndListPackages } = await import("../../src/lib/packages.ts");
		const { KNOWN_PACKAGES_X86 } = await import("../../src/lib/types.ts");

		const packages = await downloadAndListPackages("7.22.1", "x86");
		expect(packages.length).toBeGreaterThan(0);

		for (const pkg of KNOWN_PACKAGES_X86) {
			expect(packages).toContain(pkg);
		}
	}, 120_000);

	test("arm64 has more packages than x86", async () => {
		const { downloadAndListPackages } = await import("../../src/lib/packages.ts");

		const arm64 = await downloadAndListPackages("7.22.1", "arm64");
		const x86 = await downloadAndListPackages("7.22.1", "x86");

		expect(arm64.length).toBeGreaterThan(x86.length);
	}, 120_000);
});
