import { describe, test, expect, beforeAll } from "bun:test";

/**
 * Integration tests — device-mode provisioning.
 *
 * Verifies that QuickCHR.start() correctly issues a device-mode update
 * and hard power-cycles the CHR to confirm the change. After restart,
 * the mode reported by RouterOS REST must match the requested value.
 *
 * Requires QEMU. Skipped unless QUICKCHR_INTEGRATION=1.
 */

const SKIP = !process.env.QUICKCHR_INTEGRATION;

async function cleanupMachine(name: string): Promise<void> {
	const { QuickCHR } = await import("../../src/lib/quickchr.ts");
	const existing = QuickCHR.get(name);
	if (!existing) return;
	try { await existing.stop(); } catch { /* ignore */ }
	try { await existing.remove(); } catch { /* ignore */ }
}

describe.skipIf(SKIP)("device-mode provisioning", () => {
	beforeAll(async () => {
		for (const name of ["integration-dm-rose", "integration-dm-skip", "integration-dm-features"]) {
			await cleanupMachine(name);
		}
	});

	test("mode=rose is applied and verified after hard power-cycle", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		const { readDeviceMode } = await import("../../src/lib/device-mode.ts");

		// Use native arch for HVF acceleration (fast boot)
		const arch = process.arch === "arm64" ? "arm64" : "x86";
		let instance: Awaited<ReturnType<typeof QuickCHR.start>> | undefined;

		try {
			// start() will: boot CHR, fire device-mode update, hard power-cycle,
			// restart, verify mode=rose, then return.
			instance = await QuickCHR.start({
				channel: "stable",
				arch,
				background: true,
				name: "integration-dm-rose",
				deviceMode: { mode: "rose" },
			});

			expect(instance.state.status).toBe("running");

			// The internal verifyDeviceMode call inside start() already confirmed the
			// mode — if it were wrong, start() would have thrown. Double-check via REST
			// to ensure the readback path also works end-to-end.
			const actual = await readDeviceMode(instance.ports.http);
			expect(actual.mode).toBe("rose");
		} finally {
			if (instance) {
				try { await instance.stop(); } catch { /* ignore */ }
			}
			await cleanupMachine("integration-dm-rose");
		}
	}, 300_000);

	test("deviceMode=skip boots without device-mode provisioning", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");

		const arch = process.arch === "arm64" ? "arm64" : "x86";
		let instance: Awaited<ReturnType<typeof QuickCHR.start>> | undefined;

		try {
			// With skip, no hard reboot should happen — the CHR boots once and returns.
			instance = await QuickCHR.start({
				channel: "stable",
				arch,
				background: true,
				name: "integration-dm-skip",
				deviceMode: { mode: "skip" },
				secureLogin: false,
			});

			expect(instance.state.status).toBe("running");

			// CHR default mode before any device-mode update is "advanced" on fresh images.
			// We do NOT assert the mode value here — the point is that start() succeeded
			// without triggering a device-mode power-cycle.
			const resource = await instance.rest("/system/resource") as Record<string, unknown>;
			expect(String(resource["board-name"])).toContain("CHR");
		} finally {
			if (instance) {
				try { await instance.stop(); } catch { /* ignore */ }
			}
			await cleanupMachine("integration-dm-skip");
		}
	}, 180_000);

	test("mode=basic with enable/disable feature flags is applied and verified", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		const { readDeviceMode, resolveDeviceModeOptions, verifyDeviceMode } = await import("../../src/lib/device-mode.ts");
		const arch = process.arch === "arm64" ? "arm64" : "x86";
		let instance: Awaited<ReturnType<typeof QuickCHR.start>> | undefined;

		// Explicitly enable bandwidth-test and ipsec; disable smb.
		// This exercises the enable[] + disable[] paths on top of a non-rose mode.
		// verifyDeviceMode() then confirms every requested field matches the actual
		// RouterOS REST state — the same logic used internally by start().
		const deviceMode = {
			mode: "basic",
			enable: ["bandwidth-test", "ipsec"],
			disable: ["smb"],
		};

		try {
			instance = await QuickCHR.start({
				channel: "stable",
				arch,
				background: true,
				name: "integration-dm-features",
				deviceMode,
			});

			expect(instance.state.status).toBe("running");

			// Read back the full device-mode record via REST.
			const actual = await readDeviceMode(instance.ports.http);

			// Mode must match.
			expect(actual.mode).toBe("basic");

			// Explicitly enabled features must be "yes".
			expect(actual["bandwidth-test"]).toBe("yes");
			expect(actual.ipsec).toBe("yes");

			// Explicitly disabled feature must be "no".
			expect(actual.smb).toBe("no");

			// verifyDeviceMode must agree with no mismatches — same path start() uses.
			const resolved = resolveDeviceModeOptions(deviceMode);
			const verification = verifyDeviceMode(resolved, actual);
			expect(verification.ok).toBe(true);
			expect(verification.mismatches).toHaveLength(0);
		} finally {
			if (instance) {
				try { await instance.stop(); } catch { /* ignore */ }
			}
			await cleanupMachine("integration-dm-features");
		}
	}, 300_000);
});
