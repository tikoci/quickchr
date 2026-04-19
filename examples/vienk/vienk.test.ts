import { describe, test, expect, afterAll } from "bun:test";
import type { ChrInstance } from "../../src/index.ts";
import { QuickCHR } from "../../src/index.ts";

/**
 * vienk — Simplest Possible CHR Integration Test
 *
 * Boots a single CHR instance (native arch, stable RouterOS), waits for the
 * REST API to become ready, queries system info, and removes the instance.
 *
 * This is the minimal quickchr example: one machine, one test, no provisioning.
 * Useful as a smoke-test to verify QEMU + KVM/HVF setup is working.
 *
 * Run:
 *   QUICKCHR_INTEGRATION=1 bun test examples/vienk/vienk.test.ts
 *
 * Expected run time:
 *   - Linux with KVM: ~20–40 s
 *   - macOS with HVF: ~20–40 s
 *   - TCG (no acceleration): ~2–4 min
 */

const SKIP = !process.env.QUICKCHR_INTEGRATION;

const CHR_ARCH = process.arch === "arm64" ? ("arm64" as const) : ("x86" as const);

describe.skipIf(SKIP)("vienk — single CHR smoke test", () => {
	let instance: ChrInstance | undefined;

	afterAll(async () => {
		try {
			await instance?.remove();
		} catch {
			/* ignore cleanup errors */
		}
	});

	test(
		"CHR boots and REST API responds",
		async () => {
			instance = await QuickCHR.start({
				name: "vienk",
				version: "stable",
				arch: CHR_ARCH,
				background: true,
				secureLogin: false,
				cpu: 1,
				mem: 256,
			});

			const ready = await instance.waitForBoot(180_000);
			expect(ready).toBe(true);

			const resource = await instance.rest("/system/resource") as Record<string, string>;
			expect(resource).toBeObject();
			expect(resource["board-name"]).toContain("CHR");
			expect(resource["architecture-name"]).toBeDefined();

			console.log(
				`  RouterOS ${resource.version} (${resource["architecture-name"]}) — uptime: ${resource.uptime}`,
			);
		},
		240_000,
	);

	test("system identity is readable", async () => {
		expect(instance).toBeDefined();
		const id = await instance!.rest("/system/identity") as Record<string, string>;
		expect(id.name).toBeDefined();
		expect(typeof id.name).toBe("string");
	});

	test("interface list has at least one ethernet", async () => {
		expect(instance).toBeDefined();
		const ifaces = await instance!.rest("/interface?type=ether") as unknown[];
		expect(Array.isArray(ifaces)).toBe(true);
		expect(ifaces.length).toBeGreaterThan(0);
	});
});
