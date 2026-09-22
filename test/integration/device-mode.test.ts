import { describe, test, expect, beforeAll } from "bun:test";
import { imageTarget } from "./image-target.ts";
import { bootTestTimeout } from "./timeouts.ts";

/**
 * Integration tests — device-mode provisioning.
 *
 * Verifies that QuickCHR.start() correctly issues a device-mode update
 * and hard power-cycles the CHR to confirm the change. After restart,
 * the mode reported by RouterOS REST must match the requested value.
 *
 * Also covers the post-boot half (#176): once the provisioning window has shut,
 * `start()` refuses a device-mode option and names `quickchr set …`, and that route
 * applies it — power cycle, cumulative record, and the preconditions it inherits.
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
		for (const name of ["integration-dm-rose", "integration-dm-skip", "integration-dm-features", "integration-dm-setmode", "integration-dm-post-boot", "integration-dm-stopped", "integration-dm-cli", "integration-dm-no-skip"]) {
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
				...imageTarget(),
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
	}, bootTestTimeout({ boots: 2 })); // + hard power-cycle

	test("deviceMode=skip boots without device-mode provisioning", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");

		const arch = process.arch === "arm64" ? "arm64" : "x86";
		let instance: Awaited<ReturnType<typeof QuickCHR.start>> | undefined;

		try {
			// With skip, no hard reboot should happen — the CHR boots once and returns.
			instance = await QuickCHR.start({
				...imageTarget(),
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
			// Liveness check: REST API is responding with CHR identity.
			const resource = await instance.rest("/system/resource") as Record<string, unknown>;
			expect(String(resource["board-name"])).toContain("CHR");
		} finally {
			if (instance) {
				try { await instance.stop(); } catch { /* ignore */ }
			}
			await cleanupMachine("integration-dm-skip");
		}
	}, bootTestTimeout());

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
				...imageTarget(),
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
	}, bootTestTimeout({ boots: 2 })); // + hard power-cycle

	test("setDeviceMode() changes mode on a running instance", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		const { readDeviceMode } = await import("../../src/lib/device-mode.ts");

		const arch = process.arch === "arm64" ? "arm64" : "x86";
		let instance: Awaited<ReturnType<typeof QuickCHR.start>> | undefined;

		try {
			// Boot without device-mode provisioning to get a plain running instance
			instance = await QuickCHR.start({
				...imageTarget(),
				arch,
				background: true,
				name: "integration-dm-setmode",
				deviceMode: { mode: "skip" },
				secureLogin: false,
			});

			expect(instance.state.status).toBe("running");

			// Change device-mode on the running instance — triggers a hard power-cycle
			await instance.setDeviceMode({ mode: "rose" });

			// After setDeviceMode returns the CHR is rebooted and running with mode=rose
			const actual = await readDeviceMode(instance.ports.http);
			expect(actual.mode).toBe("rose");

			// Persisted state must reflect the new mode
			expect(instance.state.deviceMode).toMatchObject({ mode: "rose" });
		} finally {
			if (instance) {
				try { await instance.stop(); } catch { /* ignore */ }
			}
			await cleanupMachine("integration-dm-setmode");
		}
	}, bootTestTimeout({ boots: 2 })); // + hard power-cycle

	test("setDeviceMode() is the post-boot route the refusal names, and records itself", async () => {
		// The second half of #176: a device-mode option refused on `start` has to be
		// applicable *somewhere*, and the route the refusal prints is this one.
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		const { readDeviceMode } = await import("../../src/lib/device-mode.ts");
		const { QuickCHRError } = await import("../../src/lib/types.ts");

		const arch = process.arch === "arm64" ? "arm64" : "x86";
		let instance: Awaited<ReturnType<typeof QuickCHR.start>> | undefined;

		try {
			instance = await QuickCHR.start({
				...imageTarget(),
				arch,
				background: true,
				name: "integration-dm-post-boot",
				deviceMode: { mode: "advanced" },
				secureLogin: false,
			});

			// The window is shut, so the same request through start() is refused — and the
			// refusal names the CLI command that does work.
			let refusal: unknown;
			try {
				await QuickCHR.start({ name: "integration-dm-post-boot", background: true, deviceMode: { enable: ["container"] } });
			} catch (e) { refusal = e; }
			expect(refusal).toBeInstanceOf(QuickCHRError);
			expect((refusal as InstanceType<typeof QuickCHRError>).code).toBe("PROVISIONING_WINDOW_CLOSED");
			expect((refusal as Error).message).toContain("quickchr set integration-dm-post-boot --device-mode rose --device-mode-enable container");

			// Now take that route. Naming a feature without a mode resolves to rose, so
			// `mode` moves from advanced as a side-effect — the thing the CLI announces.
			await instance.setDeviceMode({ enable: ["container"] });

			const actual = await readDeviceMode(instance.ports.http);
			expect(actual.mode).toBe("rose");
			expect(actual.container).toBe("yes");

			// The step is recorded, which is what turns a later start passing the same
			// device-mode into a recognised no-op rather than a second refusal.
			expect(instance.state.provisioning?.steps).toContain("deviceMode");
			await QuickCHR.start({ name: "integration-dm-post-boot", background: true, deviceMode: { mode: "rose", enable: ["container"] } });

			// A change that is genuinely different is still refused.
			let second: unknown;
			try {
				await QuickCHR.start({ name: "integration-dm-post-boot", background: true, deviceMode: { disable: ["smb"] } });
			} catch (e) { second = e; }
			expect(second).toBeInstanceOf(QuickCHRError);

			// Applying it folds into the record rather than replacing it: container was
			// asked for earlier and the guest still has it.
			await instance.setDeviceMode({ disable: ["smb"] });
			const after = await readDeviceMode(instance.ports.http);
			expect(after.container).toBe("yes");
			expect(after.smb).toBe("no");
			expect(instance.state.deviceMode?.enable).toContain("container");
			expect(instance.state.deviceMode?.disable).toContain("smb");
		} finally {
			if (instance) {
				try { await instance.stop(); } catch { /* ignore */ }
			}
			await cleanupMachine("integration-dm-post-boot");
		}
	}, bootTestTimeout({ boots: 3 })); // + two hard power-cycles

	test("--no-device-mode on start beats device-mode intent stored at add", async () => {
		// `--no-device-mode` is documented as "skip device-mode provisioning entirely",
		// and it used to be parsed into `undefined` — which `start()` cannot tell from
		// the user saying nothing, so it fell through to `existing.deviceMode` and
		// provisioned the stored request anyway, power cycle included. Measured before
		// the fix: 48 s and container enabled, from a flag whose job is to skip.
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		const { readDeviceMode } = await import("../../src/lib/device-mode.ts");

		const arch = process.arch === "arm64" ? "arm64" : "x86";
		let instance: Awaited<ReturnType<typeof QuickCHR.start>> | undefined;

		try {
			const added = await QuickCHR.add({
				...imageTarget(),
				arch,
				name: "integration-dm-no-skip",
				deviceMode: { mode: "auto", enable: ["container"] },
				secureLogin: false,
			});
			expect(added.deviceMode).toMatchObject({ enable: ["container"] });

			instance = await QuickCHR.start({
				name: "integration-dm-no-skip",
				background: true,
				deviceMode: { mode: "skip" },
			});

			const actual = await readDeviceMode(instance.ports.http);
			expect(actual.container).toBe("no");
			// The mode is untouched too — enabling a feature would have moved it to rose.
			expect(actual.mode).toBe("advanced");
		} finally {
			await cleanupMachine("integration-dm-no-skip");
		}
	}, bootTestTimeout({ boots: 1 }));

	test("the CLI command the refusal prints actually works, run as a process", async () => {
		// The library path is covered above; this covers the route as a *user* meets it.
		// A parser, dispatch or output regression would leave the command printed by
		// PROVISIONING_WINDOW_CLOSED unusable while every other test here stayed green.
		// It runs against a machine with admin disabled on purpose: device-mode ran on
		// factory `admin:` for as long as it was first-boot-only, and this is the machine
		// shape that broke when it became a post-boot route.
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		const { readDeviceMode } = await import("../../src/lib/device-mode.ts");
		const { resolveAuth } = await import("../../src/lib/auth.ts");
		const cli = new URL("../../src/cli/index.ts", import.meta.url).pathname;

		const arch = process.arch === "arm64" ? "arm64" : "x86";
		let instance: Awaited<ReturnType<typeof QuickCHR.start>> | undefined;

		try {
			instance = await QuickCHR.start({
				...imageTarget(),
				arch,
				background: true,
				name: "integration-dm-cli",
				deviceMode: { mode: "skip" },
				user: { name: "lab", password: "lab-pass-1" },
				disableAdmin: true,
			});

			const proc = Bun.spawn(["bun", cli, "set", "integration-dm-cli", "--device-mode-enable", "container"], {
				env: { ...process.env, NO_COLOR: "1", QUICKCHR_NO_PROMPT: "1" },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			const output = stdout + stderr;

			expect({ exitCode, output }).toMatchObject({ exitCode: 0 });
			// The settings that moved are announced before the power cycle is spent.
			expect(output).toContain("container: no -> yes");
			expect(output).toContain("Device-mode verified");
			expect(output).toContain("quickchr get integration-dm-cli device-mode");

			// And the guest agrees — read back with the machine's own credentials, since
			// admin is disabled.
			const reloaded = QuickCHR.get("integration-dm-cli");
			const actual = await readDeviceMode(instance.ports.http, resolveAuth(reloaded?.state ?? instance.state).header);
			expect(actual.container).toBe("yes");
			expect(actual.mode).toBe("rose");
		} finally {
			await cleanupMachine("integration-dm-cli");
		}
	}, bootTestTimeout({ boots: 2 })); // + hard power-cycle

	test("setDeviceMode() refuses a stopped machine instead of waiting out a REST timeout", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		const { QuickCHRError } = await import("../../src/lib/types.ts");

		const arch = process.arch === "arm64" ? "arm64" : "x86";
		let instance: Awaited<ReturnType<typeof QuickCHR.start>> | undefined;

		try {
			instance = await QuickCHR.start({
				...imageTarget(),
				arch,
				background: true,
				name: "integration-dm-stopped",
				deviceMode: { mode: "skip" },
				secureLogin: false,
			});
			await instance.stop();

			// applyDeviceMode() polls waitForDeviceModeApi before it does anything, so
			// without the guard this is a 60s wait ending in a boot-timeout message about
			// a guest that was never going to answer.
			const started = Date.now();
			let refusal: unknown;
			try { await instance.setDeviceMode({ mode: "rose" }); } catch (e) { refusal = e; }
			expect(refusal).toBeInstanceOf(QuickCHRError);
			expect((refusal as InstanceType<typeof QuickCHRError>).code).toBe("MACHINE_STOPPED");
			expect(Date.now() - started).toBeLessThan(10_000);
		} finally {
			await cleanupMachine("integration-dm-stopped");
		}
	}, bootTestTimeout({ boots: 1 }));
});
