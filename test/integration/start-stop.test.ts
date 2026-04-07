import { describe, test, expect, beforeAll } from "bun:test";

/**
 * Integration test — start and stop a CHR.
 *
 * Requires QEMU installed. Skipped in CI unless QUICKCHR_INTEGRATION=1.
 * On macOS arm64, tests arm64 CHR with HVF.
 * On Linux x86_64, tests x86 CHR with KVM.
 */

const SKIP = !process.env.QUICKCHR_INTEGRATION;

async function cleanupMachine(name: string): Promise<void> {
	const { QuickCHR } = await import("../../src/lib/quickchr.ts");
	const existing = QuickCHR.get(name);
	if (!existing) return;
	try { await existing.stop(); } catch { /* ignore */ }
	try { await existing.remove(); } catch { /* ignore */ }
}

describe.skipIf(SKIP)("start-stop lifecycle", () => {
	// Clean up in case a previous run left a machine behind.
	// Use remove() to ensure a fresh disk image — a dirty disk from
	// an incomplete previous boot can slow recovery significantly.
	beforeAll(async () => {
		await cleanupMachine("integration-test-1");
	});

	test("start → wait for boot → stop", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		let instance: Awaited<ReturnType<typeof QuickCHR.start>> | undefined;

		try {
			// Let start() pick the native arch (x86 + HVF on Rosetta, arm64 + HVF on native)
			// so QEMU uses hardware acceleration and boots quickly.
			instance = await QuickCHR.start({
				channel: "stable",
				background: true,
				name: "integration-test-1",
			});

			expect(instance.name).toBe("integration-test-1");
			expect(instance.state.status).toBe("running");
			expect(instance.ports.http).toBeGreaterThan(0);

			// start() already waited for first boot internally. This second call
			// should return true immediately (CHR is already up).
			const booted = await instance.waitForBoot(60_000);
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
			}
			await cleanupMachine("integration-test-1");
		}
	}, 180_000); // 3 minute timeout
});

describe.skipIf(SKIP)("package installation", () => {
	// Clean up in case a previous run failed mid-test (e.g. provisioning error)
	beforeAll(async () => {
		await cleanupMachine("integration-pkg-test");
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
			}
			await cleanupMachine("integration-pkg-test");
		}
	}, 600_000); // 10 min: download + two boots + package install
});
