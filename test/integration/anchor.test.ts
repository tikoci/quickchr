import { describe, test, expect } from "bun:test";
import { accelTimeoutFactor, detectAccel, isCrossArchEmulation } from "../../src/lib/platform.ts";

/**
 * Anchor test — RouterOS REST API schema stability.
 *
 * Boots a reference CHR and verifies that key REST endpoints return
 * the expected field structure. Fails when RouterOS renames or removes
 * fields we depend on — surfaces schema changes before they break
 * production provisioning workflows.
 *
 * This is schema testing, not value testing: field values (versions,
 * timestamps, license IDs) are not asserted — only field presence.
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

describe.skipIf(SKIP)("RouterOS REST schema anchor", () => {
	const MACHINE_NAME = "integration-anchor";

	test("key REST endpoints have expected field structure", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		let instance: Awaited<ReturnType<typeof QuickCHR.start>> | undefined;

		try {
			await cleanupMachine(MACHINE_NAME);

			instance = await QuickCHR.start({
				channel: "stable",
				arch: "x86",
				background: true,
				name: MACHINE_NAME,
			});

			// background: true returns before boot — wait explicitly
			const accel = await detectAccel("x86");
			const crossArch = isCrossArchEmulation("x86");
			const bootTimeout = Math.round(120_000 * accelTimeoutFactor(accel, crossArch));
			const booted = await instance.waitForBoot(bootTimeout);
			expect(booted).toBe(true);

			const base = `http://127.0.0.1:${instance.ports.http}/rest`;
			const auth = `Basic ${btoa("admin:")}`;
			const headers = { Authorization: auth };

			// RouterOS non-resource endpoints (identity, license, device-mode) may briefly
			// return wrong data after boot even after waitForBoot declares the REST layer
			// stable — waitForBoot only guards /system/resource. Poll until each endpoint
			// returns valid fields (up to 20s per endpoint).
			async function fetchUntilHasKeys(path: string, keys: string[]): Promise<Record<string, unknown>> {
				const deadline = Date.now() + 20_000;
				let lastBody = "";
				while (Date.now() < deadline) {
					try {
						const resp = await fetch(`${base}/${path}`, {
							headers,
							signal: AbortSignal.timeout(5_000),
						});
						if (resp.ok) {
							const body = await resp.text();
							lastBody = body;
							const data = JSON.parse(body) as unknown;
							if (data && typeof data === "object" && !Array.isArray(data)) {
								const obj = data as Record<string, unknown>;
								if (keys.every((k) => k in obj)) return obj;
							}
						}
					} catch { /* retry */ }
					await Bun.sleep(1_000);
				}
				throw new Error(`/rest/${path} did not return expected keys [${keys.join(", ")}] within 20s (last: ${lastBody})`);
			}

			// --- /system/resource ---
			const resource = await fetchUntilHasKeys("system/resource", ["board-name", "version", "cpu-load", "uptime", "free-memory", "total-memory", "architecture-name"]);
			for (const field of ["board-name", "version", "cpu-load", "uptime", "free-memory", "total-memory", "architecture-name"]) {
				expect(resource).toHaveProperty(field, expect.anything());
			}

			// --- /system/identity ---
			const identity = await fetchUntilHasKeys("system/identity", ["name"]);
			expect(identity).toHaveProperty("name");

			// --- /system/license ---
			const license = await fetchUntilHasKeys("system/license", ["system-id"]);
			expect(license).toHaveProperty("system-id");

			// --- /user ---
			const userResp = await fetch(`${base}/user`, { headers, signal: AbortSignal.timeout(10_000) });
			expect(userResp.status).toBe(200);
			const users = await userResp.json() as Array<Record<string, unknown>>;
			expect(Array.isArray(users)).toBe(true);
			// Each user must have name + group
			for (const u of users) {
				expect(u).toHaveProperty("name");
				expect(u).toHaveProperty("group");
				expect(u).toHaveProperty("disabled");
			}
			// admin user must exist on a fresh CHR
			expect(users.some((u) => u.name === "admin")).toBe(true);

			// --- /system/device-mode ---
			const dm = await fetchUntilHasKeys("system/device-mode", ["mode"]);
			expect(dm).toHaveProperty("mode");

			// --- /ip/address ---
			const ipResp = await fetch(`${base}/ip/address`, { headers, signal: AbortSignal.timeout(10_000) });
			expect(ipResp.status).toBe(200);
			const ips = await ipResp.json() as Array<Record<string, unknown>>;
			expect(Array.isArray(ips)).toBe(true);
			if (ips.length > 0) {
				expect(ips[0]).toHaveProperty("address");
				expect(ips[0]).toHaveProperty("interface");
			}

			// --- /interface ---
			const ifResp = await fetch(`${base}/interface`, { headers, signal: AbortSignal.timeout(10_000) });
			expect(ifResp.status).toBe(200);
			const ifaces = await ifResp.json() as Array<Record<string, unknown>>;
			expect(Array.isArray(ifaces)).toBe(true);
			expect(ifaces.length).toBeGreaterThan(0);
			for (const iface of ifaces) {
				expect(iface).toHaveProperty("name");
				expect(iface).toHaveProperty("type");
				expect(iface).toHaveProperty("running");
			}
		} finally {
			if (instance) {
				try { await instance.stop(); } catch { /* ignore */ }
			}
			await cleanupMachine(MACHINE_NAME);
		}
	}, 300_000);
});
