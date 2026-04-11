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
		for (const name of ["integration-prov-bg", "integration-prov-disable", "integration-prov-fg", "integration-prov-managed"]) {
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
				name: "integration-prov-disable",
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
			await cleanupMachine("integration-prov-disable");
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

	test("default: quickchr managed account auto-created when no user specified", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		const { getInstanceCredentials } = await import("../../src/lib/credentials.ts");
		let instance: Awaited<ReturnType<typeof QuickCHR.start>> | undefined;

		try {
			instance = await QuickCHR.start({
				channel: "stable",
				arch: "x86",
				background: true,
				name: "integration-prov-managed",
			});

			// Instance credentials must have been saved to the secret store
			const creds = await getInstanceCredentials("integration-prov-managed");
			expect(creds).not.toBeNull();
			expect(creds?.user).toBe("quickchr");

			// The managed account must authenticate against the REST API
			const resp = await fetch(
				`http://127.0.0.1:${instance.ports.http}/rest/system/resource`,
				{
					headers: { Authorization: `Basic ${btoa(`${creds?.user}:${creds?.password}`)}` },
					signal: AbortSignal.timeout(10_000),
				},
			);
			expect(resp.status).toBe(200);
		} finally {
			if (instance) {
				try { await instance.stop(); } catch { /* ignore */ }
			}
			await cleanupMachine("integration-prov-managed");
		}
	}, 180_000);
});

describe.skipIf(SKIP)("provisioning corner cases", () => {
	beforeAll(async () => {
		await cleanupMachine("integration-prov-corner");
	});

	test("createUser with an invalid group throws PROCESS_FAILED", async () => {
		// RouterOS rejects /rest/user/add when the group name doesn't exist.
		// This verifies the library surfaces that RouterOS error as PROCESS_FAILED
		// rather than silently succeeding or crashing. Using an invalid group name
		// is a reliable trigger — RouterOS always rejects unknown groups.
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		const { createUser } = await import("../../src/lib/provision.ts");
		let instance: Awaited<ReturnType<typeof QuickCHR.start>> | undefined;

		try {
			instance = await QuickCHR.start({
				channel: "stable",
				arch: "x86",
				background: true,
				name: "integration-prov-corner",
			});

			// "no-such-group" is not a built-in RouterOS user group.
			// RouterOS returns HTTP 400 Bad Request — createUser must throw PROCESS_FAILED.
			await expect(createUser(
				instance.ports.http,
				"validname",
				"ValidPass1",
				"no-such-group",
			)).rejects.toMatchObject({ code: "PROCESS_FAILED" });
		} finally {
			if (instance) {
				try { await instance.stop(); } catch { /* ignore */ }
			}
			await cleanupMachine("integration-prov-corner");
		}
	}, 300_000);

	test("createUser sets the user group to 'full' by default", async () => {
		// RouterOS has a concept of user groups. The library must place the new user
		// in the "full" group, not the default read-only group.
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		let instance: Awaited<ReturnType<typeof QuickCHR.start>> | undefined;

		try {
			instance = await QuickCHR.start({
				channel: "stable",
				arch: "x86",
				background: true,
				name: "integration-prov-corner",
				user: { name: "groupcheck", password: "GroupPass1" },
			});

			// Confirm the user is in the "full" group by querying the user list as admin.
			const resp = await fetch(
				`http://127.0.0.1:${instance.ports.http}/rest/user?name=groupcheck`,
				{ headers: { Authorization: `Basic ${btoa("admin:")}` }, signal: AbortSignal.timeout(10_000) },
			);
			const users = await resp.json() as Record<string, string>[];
			expect(users[0]?.group).toBe("full");

			// The new user must authenticate and can read (full group gives read+write).
			// RouterOS returns 200 for any GET from a valid "full" group user.
			const readResp = await fetch(
				`http://127.0.0.1:${instance.ports.http}/rest/system/resource`,
				{
					headers: { Authorization: `Basic ${btoa("groupcheck:GroupPass1")}` },
					signal: AbortSignal.timeout(10_000),
				},
			);
			expect(readResp.status).toBe(200);
		} finally {
			if (instance) {
				try { await instance.stop(); } catch { /* ignore */ }
			}
			await cleanupMachine("integration-prov-corner");
		}
	}, 300_000);
});
