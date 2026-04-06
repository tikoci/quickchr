import { describe, test, expect, beforeAll } from "bun:test";

/**
 * Integration test — start and stop a CHR.
 *
 * Requires QEMU installed. Skipped in CI unless QUICKCHR_INTEGRATION=1.
 * On macOS arm64, tests arm64 CHR with HVF.
 * On Linux x86_64, tests x86 CHR with KVM.
 */

const SKIP = !process.env.QUICKCHR_INTEGRATION;

describe.skipIf(SKIP)("start-stop lifecycle", () => {
	// Clean up in case a previous run failed mid-test
	beforeAll(async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		const existing = QuickCHR.get("integration-test-1");
		if (existing) {
			try { await existing.stop(); } catch { /* ignore */ }
			try { await existing.remove(); } catch { /* ignore */ }
		}
	});

	test("start → wait for boot → stop", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		let instance: Awaited<ReturnType<typeof QuickCHR.start>> | undefined;

		try {
			// Always use native arch so QEMU has hardware acceleration (HVF/KVM).
			// Without this, a leftover x86 machine could be relaunched via TCG
			// emulation on an ARM64 host, making boot take minutes instead of seconds.
			const arch = process.arch === "arm64" ? "arm64" : "x86";
			instance = await QuickCHR.start({
				channel: "stable",
				arch,
				background: true,
				name: "integration-test-1",
			});

			expect(instance.name).toBe("integration-test-1");
			expect(instance.state.status).toBe("running");
			expect(instance.ports.http).toBeGreaterThan(0);

			// Wait for boot
			const booted = await instance.waitForBoot(120_000);
			expect(booted).toBe(true);

			// Test REST API
			const resource = await instance.rest("/system/resource") as Record<string, unknown>;
			expect(resource["board-name"]).toMatch(/^CHR/);

			// Test version matches
			expect(resource.version).toContain(instance.state.version);
		} finally {
			if (instance) {
				await instance.stop();
				expect(instance.state.status).toBe("stopped");
				await instance.remove();
			}
		}
	}, 180_000); // 3 minute timeout
});

describe.skipIf(SKIP)("package installation", () => {
	// Clean up in case a previous run failed mid-test (e.g. provisioning error)
	beforeAll(async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		const existing = QuickCHR.get("integration-pkg-test");
		if (existing) {
			try { await existing.stop(); } catch { /* ignore */ }
			try { await existing.remove(); } catch { /* ignore */ }
		}
	});

	test("start with extra package → package active after boot", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");

		// Use arm64 if on macOS arm64 (native HVF), x86 otherwise
		const arch = process.arch === "arm64" ? "arm64" : "x86";
		let instance: Awaited<ReturnType<typeof QuickCHR.start>> | undefined;

		try {
			instance = await QuickCHR.start({
				channel: "stable",
				arch,
				background: true,
				name: "integration-pkg-test",
				packages: ["container"],
			});

			expect(instance.name).toBe("integration-pkg-test");
			expect(instance.state.status).toBe("running");
			expect(instance.state.packages).toContain("container");

			// start() already waited for boot and installed packages before returning.
			// Wait for the second boot (post package install reboot).
			const bootTimeout = arch === "arm64" ? 120_000 : 300_000;
			const booted = await instance.waitForBoot(bootTimeout);
			expect(booted).toBe(true);

			// Verify the package is active via REST API
			const packages = await instance.rest("/system/package") as Array<Record<string, unknown>>;
			expect(Array.isArray(packages)).toBe(true);
			const containerPkg = packages.find((p) => p.name === "container");
			expect(containerPkg).toBeDefined();
			// RouterOS REST returns booleans as strings ("true"/"false")
			expect(containerPkg?.disabled).not.toBe("true");
		} finally {
			if (instance) {
				await instance.stop();
				await instance.remove();
			}
		}
	}, 600_000); // 10 min: download + two boots + package install
});
