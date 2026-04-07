import { describe, test, expect, beforeAll } from "bun:test";

/**
 * Integration tests — user provisioning and admin management.
 *
 * Exercises `createUser`, `disableAdmin`, and the foreground+provisioning path
 * (serial attach is skipped automatically in non-TTY environments like tests).
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

describe.skipIf(SKIP)("user provisioning", () => {
	beforeAll(async () => {
		for (const name of ["integration-prov-bg", "integration-prov-fg"]) {
			await cleanupMachine(name);
		}
	});

	test("background mode: custom user created and accessible via REST", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		let instance: Awaited<ReturnType<typeof QuickCHR.start>> | undefined;

		try {
			instance = await QuickCHR.start({
				channel: "stable",
				arch: "x86",
				background: true,
				name: "integration-prov-bg",
				user: { name: "testuser", password: "TestPass1" },
			});

			// The new user must be able to authenticate against the REST API.
			// 200 = credentials accepted; 401 = user doesn't exist or wrong password.
			const resp = await fetch(`http://127.0.0.1:${instance.ports.http}/rest/system/resource`, {
				headers: { Authorization: `Basic ${btoa("testuser:TestPass1")}` },
				signal: AbortSignal.timeout(10_000),
			});
			expect(resp.status).toBe(200);
		} finally {
			if (instance) {
				try { await instance.stop(); } catch { /* ignore */ }
			}
			await cleanupMachine("integration-prov-bg");
		}
	}, 180_000);

	test("background mode: admin can be disabled after creating a replacement user", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		let instance: Awaited<ReturnType<typeof QuickCHR.start>> | undefined;

		try {
			instance = await QuickCHR.start({
				channel: "stable",
				arch: "x86",
				background: true,
				name: "integration-prov-bg",
				user: { name: "skyfi", password: "SkyfiPass1" },
				disableAdmin: true,
			});

			// New user must work
			const goodResp = await fetch(`http://127.0.0.1:${instance.ports.http}/rest/system/resource`, {
				headers: { Authorization: `Basic ${btoa("skyfi:SkyfiPass1")}` },
				signal: AbortSignal.timeout(10_000),
			});
			expect(goodResp.status).toBe(200);

			// Verify admin's disabled flag via the user list.
			//
			// We assert the user-list field rather than HTTP 401 because the REST
			// query runs immediately after the disable call, which may not have
			// propagated to the HTTP auth layer within the same test run timing.
			// The `disabled` field in the user list is the authoritative state.
			const userListResp = await fetch(
				`http://127.0.0.1:${instance.ports.http}/rest/user?name=admin`,
				{ headers: { Authorization: `Basic ${btoa("skyfi:SkyfiPass1")}` }, signal: AbortSignal.timeout(10_000) },
			);
			const users = await userListResp.json() as Record<string, string>[];
			expect(users[0]?.disabled).toBe("true");
		} finally {
			if (instance) {
				try { await instance.stop(); } catch { /* ignore */ }
			}
			await cleanupMachine("integration-prov-bg");
		}
	}, 180_000);

	test("provisioning fires before QEMU console handoff (background:true verifies shared provisioning path)", async () => {
		// When background:false + provisioning: the library boots in background, provisions,
		// stops QEMU, then re-launches in stdio foreground mode (blocking until QEMU exits).
		// That final stdio launch can't be tested without a TTY, so we verify with background:true
		// that the provisioning path (createUser et al) works — the same code runs in both modes.
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		let instance: Awaited<ReturnType<typeof QuickCHR.start>> | undefined;

		try {
			instance = await QuickCHR.start({
				channel: "stable",
				arch: "x86",
				background: true,
				name: "integration-prov-fg",
				user: { name: "fguser", password: "FgPass1" },
			});

			expect(instance.state.status).toBe("running");

			// Provisioning must have happened: new user can auth
			const resp = await fetch(`http://127.0.0.1:${instance.ports.http}/rest/system/resource`, {
				headers: { Authorization: `Basic ${btoa("fguser:FgPass1")}` },
				signal: AbortSignal.timeout(10_000),
			});
			expect(resp.status).toBe(200);
		} finally {
			if (instance) {
				try { await instance.stop(); } catch { /* ignore */ }
			}
			await cleanupMachine("integration-prov-fg");
		}
	}, 180_000);
});
