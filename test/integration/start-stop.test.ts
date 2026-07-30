import { describe, test, expect, beforeAll } from "bun:test";
import { restGet } from "../../src/lib/rest.ts";
import { imageTarget } from "./image-target.ts";
import { bootTestTimeout } from "./timeouts.ts";

/**
 * Integration test — start and stop a CHR.
 *
 * Requires QEMU installed. Skipped in CI unless QUICKCHR_INTEGRATION=1.
 * On macOS arm64, tests arm64 CHR with TCG.
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
			// Let start() pick the process-native arch; detectAccel() applies the
			// physical-host policy (including Apple Silicon TCG fallback).
			instance = await QuickCHR.start({
				...imageTarget(),
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

			// Liveness check: REST API is responding with CHR identity.
			const resource = await instance.rest("/system/resource") as Record<string, unknown>;
			expect(String(resource["board-name"])).toContain("CHR");

			// Write-verify: RouterOS version matches what we requested to download.
			expect(resource.version).toContain(instance.state.version);
		} finally {
			if (instance) {
				await instance.stop();
				expect(instance.state.status).toBe("stopped");
			}
			await cleanupMachine("integration-test-1");
		}
	}, bootTestTimeout({ boots: 2 })); // start() may respawn a wedged boot once
});

describe.skipIf(SKIP)("package installation", () => {
	// Clean up in case a previous run failed mid-test (e.g. provisioning error)
	beforeAll(async () => {
		await cleanupMachine("integration-pkg-test");
	});

	test("start with extra package → package active after boot", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");

		// Use arm64 when the process is native arm64, x86 otherwise.
		const arch = process.arch === "arm64" ? "arm64" : "x86";
		let instance: Awaited<ReturnType<typeof QuickCHR.start>> | undefined;

		try {
			instance = await QuickCHR.start({
				...imageTarget(),
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
	}, bootTestTimeout({ withPackages: true }));
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
				...imageTarget(),
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
	}, bootTestTimeout());

	test("clean() resets disk to factory defaults — custom users disappear on next boot", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");

		const arch = process.arch === "arm64" ? "arm64" : "x86";
		let instance: Awaited<ReturnType<typeof QuickCHR.start>> | undefined;

		try {
			// Boot with a custom user
			instance = await QuickCHR.start({
				...imageTarget(),
				arch,
				background: true,
				name: "integration-clean-test",
				user: { name: "cleanuser", password: "CleanPass1" },
			});

			// Verify the custom user exists before clean
			const before = await restGet(
				`http://127.0.0.1:${instance.ports.http}/rest/system/resource`,
				`Basic ${btoa("cleanuser:CleanPass1")}`,
				10_000,
			);
			expect(before.status).toBe(200);

			// Clean while stopped (clean() handles stopping internally)
			await instance.stop();
			await instance.clean();

			// The disk that held `cleanuser` is gone and nothing re-provisions it,
			// so the credential facts must go with it — otherwise every REST call,
			// exec, and SCP after this authenticates as a user RouterOS erased (#79).
			expect(instance.state.user).toBeUndefined();
			expect(instance.state.managedSshKey).toBeUndefined();

			// Reboot from the fresh disk image
			const fresh = await QuickCHR.start({ name: "integration-clean-test" });
			instance = fresh;

				// _launchExisting (used on restart) does not wait for boot — do it explicitly.
				await instance.waitForBoot(120_000);

			// cleanuser must no longer exist — 401 expected
			const afterClean = await restGet(
				`http://127.0.0.1:${instance.ports.http}/rest/system/resource`,
				`Basic ${btoa("cleanuser:CleanPass1")}`,
				10_000,
			);
			expect(afterClean.status).toBe(401);

			// Factory admin with empty password must work
			const adminOk = await restGet(
				`http://127.0.0.1:${instance.ports.http}/rest/system/resource`,
				`Basic ${btoa("admin:")}`,
				10_000,
			);
			expect(adminOk.status).toBe(200);

			// …and quickchr's own credential resolution must land on it without being
			// told: rest() authenticates with resolveAuth(state), which is the path
			// that was still offering `cleanuser` before this state was cleared.
			// (`board-name` carries the emulated machine type on some releases —
			// 7.23.2/x86 answers "CHR QEMU Standard PC (i440FX + PIIX, 1996)" — so
			// match the prefix, not the whole string.)
			const resolved = await instance.rest("/system/resource") as { "board-name"?: string };
			expect(resolved["board-name"]).toStartWith("CHR");
		} finally {
			if (instance) {
				try { await instance.stop(); } catch { /* ignore */ }
			}
			await cleanupMachine("integration-clean-test");
		}
	}, bootTestTimeout({ boots: 2 })); // provisioned boot + post-clean() relaunch (#79)
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
				...imageTarget(),
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
	}, bootTestTimeout());
});

describe.skipIf(SKIP)("instance-level package methods", () => {
	beforeAll(async () => {
		await cleanupMachine("integration-pkg-instance");
	});

	test("availablePackages() lists packages, installPackage(first+last) activates them", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		const arch = process.arch === "arm64" ? "arm64" : "x86";
		let instance: Awaited<ReturnType<typeof QuickCHR.start>> | undefined;

		try {
			instance = await QuickCHR.start({
				...imageTarget(),
				arch,
				background: true,
				name: "integration-pkg-instance",
				secureLogin: false,
			});

			expect(instance.state.status).toBe("running");

			// --- availablePackages() ---
			const pkgs = await instance.availablePackages();
			expect(Array.isArray(pkgs)).toBe(true);
			expect(pkgs.length).toBeGreaterThan(0);
			// Must be sorted and contain at least one well-known extra package
			expect(pkgs).toContain("container");
			// Verify sort order
			const sorted = [...pkgs].sort();
			expect(pkgs).toEqual(sorted);

			// Second call must return from the local cache — same result, no network
			const cached = await instance.availablePackages();
			expect(cached).toEqual(pkgs);

			// Pick the first and last package (alphabetical) as representative extremes
			const first = pkgs[0];
			const last = pkgs[pkgs.length - 1];
			expect(first).toBeDefined();
			expect(last).toBeDefined();
			if (!first || !last) throw new Error("pkgs array was unexpectedly empty");
			const toInstall: string[] = first === last ? [first] : [first, last];

			// --- installPackage() ---
			// This uploads via SCP, reboots, and waits for REST to come back up.
			const installed = await instance.installPackage(toInstall);
			expect(installed.length).toBe(toInstall.length);
			expect(installed).toContain(first);
			if (first !== last) expect(installed).toContain(last);

			// Verify state persistence — machine.json must reflect installed packages
			expect(instance.state.packages).toContain(first);
			if (first !== last) expect(instance.state.packages).toContain(last);

			// Verify against /system/package that each package is actually active
			const systemPkgs = await instance.rest("/system/package") as Array<Record<string, unknown>>;
			expect(Array.isArray(systemPkgs)).toBe(true);

			for (const pkg of installed) {
				const entry = systemPkgs.find((p) => p.name === pkg);
				expect(entry, `package "${pkg}" should appear in /system/package`).toBeDefined();
				expect(entry?.disabled, `package "${pkg}" should not be disabled`).not.toBe("true");
			}
		} finally {
			if (instance) {
				// destroy() = stop() + remove() in one call
				try { await instance.destroy(); } catch { /* ignore */ }
			}
			await cleanupMachine("integration-pkg-instance");
		}
	}, bootTestTimeout({ withPackages: true, extraMs: 120_000 })); // + SCP upload and a reboot
});
