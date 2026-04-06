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

describe.skipIf(SKIP)("user provisioning", () => {
	beforeAll(async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		for (const name of ["integration-prov-bg", "integration-prov-fg"]) {
			const existing = QuickCHR.get(name);
			if (existing) {
				try { await existing.stop(); } catch { /* ignore */ }
				try { await existing.remove(); } catch { /* ignore */ }
			}
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
			if (instance) await instance.remove();
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
			if (instance) await instance.remove();
		}
	}, 180_000);

	test("foreground mode with provisioning: library returns running provisioned instance (serial attach is CLI concern)", async () => {
		// When background:false + provisioning options are set, the library boots in background,
		// provisions, and returns a running instance WITHOUT attaching the serial socket.
		// The serial attach happens at the CLI layer (index.ts / wizard.ts).
		// This test verifies the library's behaviour in a non-TTY environment (which is always
		// the case in tests).
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		let instance: Awaited<ReturnType<typeof QuickCHR.start>> | undefined;

		try {
			instance = await QuickCHR.start({
				channel: "stable",
				arch: "x86",
				background: false, // foreground requested — library handles via bg boot + provision
				name: "integration-prov-fg",
				user: { name: "fguser", password: "FgPass1" },
			});

			// Instance stays running (serial attach is CLI-layer concern, not invoked here)
			expect(instance.state.status).toBe("running");

			// Provisioning must have happened: new user can auth
			const resp = await fetch(`http://127.0.0.1:${instance.ports.http}/rest/system/resource`, {
				headers: { Authorization: `Basic ${btoa("fguser:FgPass1")}` },
				signal: AbortSignal.timeout(10_000),
			});
			expect(resp.status).toBe(200);
		} finally {
			if (instance) await instance.remove();
		}
	}, 180_000);
});
