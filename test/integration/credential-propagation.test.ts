import { describe, test, expect } from "bun:test";
import { imageTarget } from "./image-target.ts";
import { bootTestTimeout } from "./timeouts.ts";
import { basicAuth, chrGet } from "./chr-rest.ts";
import { createUser } from "../../src/lib/provision.ts";
import { restGet, restPost } from "../../src/lib/rest.ts";

/**
 * Integration tests — RouterOS credential propagation (#69).
 *
 * Four Windows CI legs (runs 35135008624, 35386692051) failed with a 401 on the
 * first request made with freshly created credentials, always on the path that
 * passes an explicit `user:` and so does nothing between `createUser()` and
 * that request. The cause is **not established**: locally, on an Intel host
 * against CHR 7.24.4 (x86 guest), a fresh user authenticated on attempt #1,
 * 6/6, under both TCG and HVF — there was no window to lose. So this file does
 * not encode a mechanism it cannot demonstrate.
 *
 * Two jobs here:
 *
 * 1. **The anchor.** `createUser()` must not resolve while its own credentials
 *    are still rejected. Regression guard for the contract.
 * 2. **The measurement.** Record, per platform and per run, how many attempts a
 *    brand-new credential needs before RouterOS accepts it. Attempt counts, not
 *    elapsed time: a first authentication costs a few hundred ms of ordinary
 *    request latency on an emulated guest, and an earlier version of this probe
 *    read that latency as a propagation delay. Reported, never asserted on —
 *    the number is evidence for #69/#110, and pinning a threshold would turn
 *    guest timing drift into an unrelated red test.
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


describe.skipIf(SKIP)("credential propagation", () => {
	test("createUser() does not resolve until its credentials authenticate", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		const name = "integration-cred-prop";
		let instance: Awaited<ReturnType<typeof QuickCHR.start>> | undefined;

		await cleanupMachine(name);
		try {
			instance = await QuickCHR.start({
				...imageTarget(),
				arch: process.arch === "arm64" ? "arm64" : "x86",
				background: true,
				name,
				secureLogin: false,
			});

			const port = instance.ports.http;

			// --- 1. The anchor -------------------------------------------------
			// No sleep, no intervening work: the request goes out as soon as
			// createUser() resolves. That is precisely the shape of the four CI
			// failures, so it is the shape worth holding green.
			await createUser(port, "anchoruser", "AnchorPass1");
			const immediate = await chrGet(
				instance,
				"/rest/system/resource",
				basicAuth("anchoruser", "AnchorPass1"),
				{ after: "createUser(anchoruser) — no delay before first use" },
			);
			expect(immediate.status).toBe(200);

			// --- 2. The measurement --------------------------------------------
			// Add a second user underneath createUser() and count how many
			// attempts its credentials need. Sequential and attempt-counted on
			// purpose: request latency cannot inflate an attempt count, and two
			// concurrent pollers on an emulated guest slow each other down enough
			// to manufacture a "delay" that is not there.
			const admin = basicAuth("admin", "");
			const add = await restPost(
				`http://127.0.0.1:${port}/rest/user/add`,
				admin,
				{ name: "windowuser", password: "WindowPass1", group: "full" },
				10_000,
			);
			expect(add.status).toBeGreaterThanOrEqual(200);
			expect(add.status).toBeLessThan(300);

			const started = Date.now();
			let attempts = 0;
			const firstStatuses: (number | string)[] = [];
			let accepted = false;
			while (Date.now() - started < 30_000) {
				attempts++;
				let status: number | string;
				try {
					status = (await restGet(
						`http://127.0.0.1:${port}/rest/system/resource`,
						basicAuth("windowuser", "WindowPass1"),
						5_000,
					)).status;
				} catch (e) {
					status = (e as Error).name;
				}
				if (firstStatuses.length < 5) firstStatuses.push(status);
				if (status === 200) { accepted = true; break; }
			}

			console.log(
				`[#69] fresh credential accepted after ${attempts} attempt(s) in ` +
				`${Date.now() - started}ms (statuses: ${firstStatuses.join(",")}) — ` +
				`attempts>1 means a real window exists on this platform`,
			);

			expect(accepted).toBe(true);
		} finally {
			if (instance) {
				try { await instance.stop(); } catch { /* ignore */ }
			}
			await cleanupMachine(name);
		}
	}, bootTestTimeout());
});
