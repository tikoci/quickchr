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

			// RouterOS REST endpoints may briefly return stale/empty data for
			// non-resource endpoints even after resource is stable. Brief pause
			// ensures all endpoints have settled.
			await Bun.sleep(3_000);

			const base = `http://127.0.0.1:${instance.ports.http}/rest`;
			const auth = `Basic ${btoa("admin:")}`;
			const headers = { Authorization: auth };
			const t = () => AbortSignal.timeout(10_000);

			// --- /system/resource ---
			const resResp = await fetch(`${base}/system/resource`, { headers, signal: t() });
			expect(resResp.status).toBe(200);
			const resource = await resResp.json() as Record<string, unknown>;
			// Fields quickchr reads directly
			for (const field of ["board-name", "version", "cpu-load", "uptime", "free-memory", "total-memory", "architecture-name"]) {
				expect(resource).toHaveProperty(field, expect.anything());
			}

			// --- /system/identity ---
			const idResp = await fetch(`${base}/system/identity`, { headers, signal: t() });
			expect(idResp.status).toBe(200);
			const identity = await idResp.json() as Record<string, unknown>;
			expect(identity).toHaveProperty("name");

			// --- /system/license ---
			const licResp = await fetch(`${base}/system/license`, { headers, signal: t() });
			expect(licResp.status).toBe(200);
			const license = await licResp.json() as Record<string, unknown>;
			expect(license).toHaveProperty("system-id");

			// --- /user ---
			const userResp = await fetch(`${base}/user`, { headers, signal: t() });
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
			const dmResp = await fetch(`${base}/system/device-mode`, { headers, signal: t() });
			expect(dmResp.status).toBe(200);
			const dm = await dmResp.json() as Record<string, unknown>;
			// mode is the primary field we read
			expect(dm).toHaveProperty("mode");

			// --- /ip/address ---
			const ipResp = await fetch(`${base}/ip/address`, { headers, signal: t() });
			expect(ipResp.status).toBe(200);
			const ips = await ipResp.json() as Array<Record<string, unknown>>;
			expect(Array.isArray(ips)).toBe(true);
			if (ips.length > 0) {
				expect(ips[0]).toHaveProperty("address");
				expect(ips[0]).toHaveProperty("interface");
			}

			// --- /interface ---
			const ifResp = await fetch(`${base}/interface`, { headers, signal: t() });
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
