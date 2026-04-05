import { describe, test, expect } from "bun:test";

/**
 * Integration test — start and stop a CHR.
 *
 * Requires QEMU installed. Skipped in CI unless QUICKCHR_INTEGRATION=1.
 * On macOS arm64, tests arm64 CHR with HVF.
 * On Linux x86_64, tests x86 CHR with KVM.
 */

const SKIP = !process.env.QUICKCHR_INTEGRATION;

describe.skipIf(SKIP)("start-stop lifecycle", () => {
	test("start → wait for boot → stop", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");

		const instance = await QuickCHR.start({
			channel: "stable",
			background: true,
			name: "integration-test-1",
		});

		try {
			expect(instance.name).toBe("integration-test-1");
			expect(instance.state.status).toBe("running");
			expect(instance.ports.http).toBeGreaterThan(0);

			// Wait for boot
			const booted = await instance.waitForBoot(120_000);
			expect(booted).toBe(true);

			// Test REST API
			const resource = await instance.rest("/system/resource") as Record<string, unknown>;
			expect(resource["board-name"]).toBe("CHR");

			// Test version matches
			expect(resource.version).toContain(instance.state.version);
		} finally {
			await instance.stop();
			expect(instance.state.status).toBe("stopped");

			// Clean up
			await instance.remove();
		}
	}, 180_000); // 3 minute timeout
});
