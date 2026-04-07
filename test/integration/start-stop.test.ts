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

describe.skipIf(SKIP)("instance lifecycle — remove and clean", () => {
	beforeAll(async () => {
		for (const name of ["integration-remove-running", "integration-clean-test"]) {
			await cleanupMachine(name);
		}
	});

	test("remove() on a running machine stops QEMU and deletes the directory", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		const { existsSync } = await import("node:fs");

		const arch = process.arch === "arm64" ? "arm64" : "x86";
		let instance: Awaited<ReturnType<typeof QuickCHR.start>> | undefined;
		let machineDir: string | undefined;

		try {
			instance = await QuickCHR.start({
				channel: "stable",
				arch,
				background: true,
				name: "integration-remove-running",
			});

			expect(instance.state.status).toBe("running");
			machineDir = instance.state.machineDir;

			// remove() while running — should stop QEMU first, then delete
			await instance.remove();

			// Machine should be gone from the state store
			expect(QuickCHR.get("integration-remove-running")).toBeNull();

			// Directory should be deleted
			if (machineDir) {
				expect(existsSync(machineDir)).toBe(false);
			}
		} finally {
			// remove() deletes the machine, so cleanupMachine is a no-op here
			await cleanupMachine("integration-remove-running");
		}
	}, 180_000);

	test("clean() resets disk to factory defaults — custom users disappear on next boot", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");

		const arch = process.arch === "arm64" ? "arm64" : "x86";
		let instance: Awaited<ReturnType<typeof QuickCHR.start>> | undefined;

		try {
			// Boot with a custom user
			instance = await QuickCHR.start({
				channel: "stable",
				arch,
				background: true,
				name: "integration-clean-test",
				user: { name: "cleanuser", password: "CleanPass1" },
			});

			// Verify the custom user exists before clean
			const before = await fetch(
				`http://127.0.0.1:${instance.ports.http}/rest/system/resource`,
				{ headers: { Authorization: `Basic ${btoa("cleanuser:CleanPass1")}` } },
			);
			expect(before.status).toBe(200);

			// Clean while stopped (clean() handles stopping internally)
			await instance.stop();
			await instance.clean();

			// Reboot from the fresh disk image
			const fresh = await QuickCHR.start({ name: "integration-clean-test" });
			instance = fresh;

				// _launchExisting (used on restart) does not wait for boot — do it explicitly.
				await instance.waitForBoot(120_000);

			// cleanuser must no longer exist — 401 expected
			const afterClean = await fetch(
				`http://127.0.0.1:${instance.ports.http}/rest/system/resource`,
				{ headers: { Authorization: `Basic ${btoa("cleanuser:CleanPass1")}` } },
			);
			expect(afterClean.status).toBe(401);

			// Factory admin with empty password must work
			const adminOk = await fetch(
				`http://127.0.0.1:${instance.ports.http}/rest/system/resource`,
				{ headers: { Authorization: `Basic ${btoa("admin:")}` } },
			);
			expect(adminOk.status).toBe(200);
		} finally {
			if (instance) {
				try { await instance.stop(); } catch { /* ignore */ }
			}
			await cleanupMachine("integration-clean-test");
		}
	}, 360_000); // 6 min: two full boots
});

describe.skipIf(SKIP)("instance channels — serial console", () => {
	beforeAll(async () => {
		await cleanupMachine("integration-serial-test");
	});

	test("serial() readable stream delivers bytes from RouterOS console", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");

		const arch = process.arch === "arm64" ? "arm64" : "x86";
		let instance: Awaited<ReturnType<typeof QuickCHR.start>> | undefined;

		try {
			instance = await QuickCHR.start({
				channel: "stable",
				arch,
				background: true,
				name: "integration-serial-test",
			});

			expect(instance.state.status).toBe("running");

			const { readable, writable } = instance.serial();
			const reader = readable.getReader();
			const writer = writable.getWriter();

			// The boot banner has already scrolled by the time we connect.
			// Send a CR to provoke RouterOS into re-printing the login prompt.
			await writer.write(new Uint8Array([0x0d]));
			writer.releaseLock();

			// Read the response with a 15 s timeout.
			const chunk = await Promise.race([
				reader.read(),
				Bun.sleep(15_000).then(() => ({ value: undefined, done: true as const })),
			]);

			reader.releaseLock();

			expect(chunk.value).toBeDefined();
			expect(chunk.value instanceof Uint8Array).toBe(true);
			expect((chunk.value as Uint8Array).length).toBeGreaterThan(0);
		} finally {
			if (instance) {
				try { await instance.stop(); } catch { /* ignore */ }
			}
			await cleanupMachine("integration-serial-test");
		}
	}, 180_000);
});
