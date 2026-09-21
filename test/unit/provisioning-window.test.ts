import { describe, test, expect } from "bun:test";
import {
	appliedDeviceModeRecord,
	assertProvisioningWindow,
	classifyProvisioningRequest,
	hasProvisioningRequest,
	isProvisioningWindowOpen,
} from "../../src/lib/provisioning-window.ts";
import { resolveDeviceModeOptions } from "../../src/lib/device-mode.ts";
import { QuickCHRError } from "../../src/lib/types.ts";
import type { MachineState } from "../../src/lib/types.ts";

/**
 * The refusal that replaces a silent drop (#176).
 *
 * Until this landed, every provisioning option handed to `start()` on a machine past
 * its first boot was parsed, accepted and discarded — `--device-mode-enable container`
 * returned in normal boot time with `container` still false, and nothing said so.
 */

function machine(overrides: Partial<MachineState> = {}): MachineState {
	return {
		name: "pw-test",
		version: "7.24.4",
		arch: "x86",
		cpu: 1,
		mem: 512,
		networks: [{ specifier: "user", id: "net0" }],
		ports: {},
		packages: [],
		portBase: 9100,
		excludePorts: [],
		extraPorts: [],
		createdAt: new Date().toISOString(),
		status: "stopped",
		machineDir: "/nonexistent/pw-test",
		...overrides,
	};
}

describe("provisioning window", () => {
	test("open on a machine that has never been launched", () => {
		expect(isProvisioningWindowOpen(machine())).toBe(true);
	});

	test("closed once QEMU has been launched, even with no provisioning record", () => {
		expect(isProvisioningWindowOpen(machine({ lastStartedAt: new Date().toISOString() }))).toBe(false);
	});

	test("closed once provisioning has run, even with lastStartedAt cleared", () => {
		const state = machine({ provisioning: { at: new Date().toISOString(), steps: ["deviceMode"] } });
		expect(isProvisioningWindowOpen(state)).toBe(false);
	});

	test("a legacy machine — lastStartedAt set, no provisioning record — reads as closed", () => {
		// Machines created before `provisioning` existed must not re-provision
		// themselves on their next start.
		expect(isProvisioningWindowOpen(machine({ lastStartedAt: "2026-01-01T00:00:00.000Z" }))).toBe(false);
	});
});

/** The refusal `assertProvisioningWindow` threw, or a failure if it returned.
 *  Mirrors `expectQuickCHRError` in download.test.ts — the sentinel is outside the
 *  try, so a call that does not throw fails on its own terms rather than being
 *  caught by the block meant for the refusal. */
function refusal(state: MachineState, request: Parameters<typeof assertProvisioningWindow>[1]): QuickCHRError {
	try {
		assertProvisioningWindow(state, request);
	} catch (e) {
		expect(e).toBeInstanceOf(QuickCHRError);
		return e as QuickCHRError;
	}
	throw new Error("expected assertProvisioningWindow to refuse, but it returned");
}

describe("assertProvisioningWindow", () => {
	const booted = () => machine({ lastStartedAt: new Date().toISOString() });

	test("says nothing while the window is open", () => {
		expect(assertProvisioningWindow(machine(), { deviceMode: { mode: "auto", enable: ["container"] } })).toEqual([]);
	});

	test("refuses device-mode on a booted machine instead of dropping it", () => {
		expect(() => assertProvisioningWindow(booted(), { deviceMode: { mode: "auto", enable: ["container"] } }))
			.toThrow(/has already booted/);
	});

	test("the refusal names the option and a route that works", () => {
		const err = refusal(booted(), { deviceMode: { enable: ["container"] } });
		expect(err.code).toBe("PROVISIONING_WINDOW_CLOSED");
		expect(err.message).toContain("container=yes");
		expect(err.message).toContain("quickchr set pw-test --device-mode rose --device-mode-enable container");
		expect(err.message).toContain("quickchr clean pw-test");
	});

	test("the device-mode route is a command, printed with the flags that were asked for", () => {
		// It replaced "instance.setDeviceMode() from the library (no CLI route yet)",
		// which told a CLI user to go and write TypeScript. A route only helps if it can
		// be run as printed, so the flags come out resolved: `auto` prints as the `rose`
		// it becomes, and the mode is named even when only a feature was requested,
		// because that is the mode the change will land on.
		const { message } = refusal(booted(), { deviceMode: { mode: "basic", enable: ["ipsec"], disable: ["smb"] } });
		expect(message).toContain("quickchr set pw-test --device-mode basic --device-mode-enable ipsec --device-mode-disable smb");
		expect(message).toContain("power-cycles the machine");
		expect(message).not.toContain("no CLI route yet");
	});

	test("every provisioning option is refused, not just device-mode", () => {
		// The dropped-on-restart bug was never device-mode specific: one `undefined`
		// discarded all seven options.
		const cases: Array<[string, Parameters<typeof assertProvisioningWindow>[1]]> = [
			["packages", { packages: ["container"] }],
			["install-all", { installAllPackages: true }],
			["license", { license: "p10" }],
			["user", { user: { name: "lab", password: "x" } }],
			["disableAdmin", { disableAdmin: true }],
			["secureLogin", { secureLogin: true }],
		];
		for (const [label, request] of cases) {
			expect(() => assertProvisioningWindow(booted(), request), label).toThrow(/has already booted/);
		}
	});

	test("the remediation route replays the request rather than saying \"start it again\"", () => {
		// A refused request is never persisted, and clean() clears `user` and
		// `disableAdmin` because they are guest state — so a plain start after the
		// reset would drop the very options that were refused.
		const { message } = refusal(booted(), { user: { name: "lab", password: "Pass1" } });
		expect(message).toContain("repeat the original start command");
		expect(message).not.toContain("then start it again");
	});

	test("the packages route names the packages, and sends install-all through clean()", () => {
		// installPackage() takes names and has no install-all form, so naming it for
		// `--install-all-packages` would point at an API that cannot do the job.
		expect(refusal(booted(), { packages: ["container", "ups"] }).message)
			.toContain('instance.installPackage(["container","ups"])');

		const installAll = refusal(booted(), { installAllPackages: true }).message;
		expect(installAll).toContain("repeat the original start command");
		expect(installAll).not.toContain("installPackage(");
	});

	test("license names the CLI route that already ships", () => {
		expect(() => assertProvisioningWindow(booted(), { license: "p10" })).toThrow(/quickchr set pw-test --license/);
	});

	test("a provisioning run that threw does not read as satisfied — the retry is refused", () => {
		// The trap this module exists to avoid. `installAllPackages`, `packages`,
		// `deviceMode` and `secureLogin` are persisted at add() as *desired config*, so
		// a first boot that reached _provisionInstance and threw leaves them matching a
		// retry exactly — while `lastStartedAt` has already closed the window. Without
		// the step-record gate the retry would classify as "already applied" and be
		// dropped in silence, which is the original bug wearing a different hat.
		const halfProvisioned = machine({
			lastStartedAt: new Date().toISOString(),
			// no `provisioning` record — the run never completed
			installAllPackages: true,
			deviceMode: { mode: "rose", enable: ["container"] },
			secureLogin: true,
			disableAdmin: true,
		});
		for (const request of [
			{ installAllPackages: true },
			{ deviceMode: { mode: "rose", enable: ["container"] } },
			{ secureLogin: true },
			{ disableAdmin: true },
		]) {
			expect(() => assertProvisioningWindow(halfProvisioned, request), JSON.stringify(request))
				.toThrow(/has already booted/);
		}
	});

	test("satisfaction needs the step record, not just a matching value", () => {
		const applied = (steps: MachineState["provisioning"]) =>
			machine({ lastStartedAt: new Date().toISOString(), licenseLevel: "p1", provisioning: steps });

		expect(() => assertProvisioningWindow(applied({ at: "2026-01-01T00:00:00.000Z", steps: [] }), { license: "p1" }))
			.toThrow(/has already booted/);
		expect(() => assertProvisioningWindow(applied({ at: "2026-01-01T00:00:00.000Z", steps: ["license"] }), { license: "p1" }))
			.not.toThrow();
	});

	test("an option state already records is a no-op, not a refusal", () => {
		const state = machine({
			lastStartedAt: new Date().toISOString(),
			provisioning: {
				at: new Date().toISOString(),
				steps: ["packages", "deviceMode", "license", "user", "disableAdmin", "secureLogin"],
			},
			licenseLevel: "p1",
			deviceMode: { mode: "rose", enable: ["container"] },
			packages: ["container"],
			user: { name: "quickchr", password: "stored" },
			disableAdmin: true,
			secureLogin: true,
		});
		const satisfied = assertProvisioningWindow(state, {
			license: "p1",
			deviceMode: { mode: "rose", enable: ["container"] },
			packages: ["container"],
			disableAdmin: true,
			secureLogin: true,
		});
		expect(satisfied.map((a) => a.step).sort()).toEqual(
			["deviceMode", "disableAdmin", "license", "packages", "secureLogin"],
		);
		expect(satisfied.every((a) => a.satisfied)).toBe(true);
	});

	test("a user whose password cannot be verified is refused, not waved through", () => {
		// `state.user.password` is a placeholder — the real one lives in the secret
		// store — so a name match alone would let `--add-user lab:NewPass1` pass as a
		// no-op and silently leave the old password in place.
		const state = machine({
			lastStartedAt: new Date().toISOString(),
			provisioning: { at: new Date().toISOString(), steps: ["user"] },
			user: { name: "lab", password: "**stored in secrets**" },
		});
		expect(() => assertProvisioningWindow(state, { user: { name: "lab", password: "NewPass1" } }))
			.toThrow(/has already booted/);
	});

	test("device-mode comparison is order-independent but not value-blind", () => {
		const state = machine({
			lastStartedAt: new Date().toISOString(),
			provisioning: { at: new Date().toISOString(), steps: ["deviceMode"] },
			deviceMode: { mode: "rose", enable: ["container", "routerboard"] },
		});
		expect(() => assertProvisioningWindow(state, {
			deviceMode: { mode: "rose", enable: ["routerboard", "container"] },
		})).not.toThrow();
		expect(() => assertProvisioningWindow(state, { deviceMode: { mode: "rose", enable: ["container"], disable: ["routerboard"] } }))
			.toThrow(/has already booted/);
	});

	test("a satisfied option is still reported alongside one that is refused", () => {
		const state = machine({
			lastStartedAt: new Date().toISOString(),
			licenseLevel: "p1",
			provisioning: { at: new Date().toISOString(), steps: ["license"] },
		});
		expect(() => assertProvisioningWindow(state, { license: "p1", disableAdmin: true }))
			.toThrow(/already applied, unchanged: license \(p1\)/);
	});

	test("no provisioning options — a plain restart — passes untouched", () => {
		expect(assertProvisioningWindow(booted(), {})).toEqual([]);
		expect(assertProvisioningWindow(booted(), { disableAdmin: false, secureLogin: false, packages: [] })).toEqual([]);
	});

	test("device-mode=skip is not a request", () => {
		expect(hasProvisioningRequest({ deviceMode: { mode: "skip" } })).toBe(false);
		expect(classifyProvisioningRequest(booted(), { deviceMode: { mode: "skip" } })).toEqual([]);
		expect(assertProvisioningWindow(booted(), { deviceMode: { mode: "skip" } })).toEqual([]);
	});
});

describe("appliedDeviceModeRecord", () => {
	const applied = resolveDeviceModeOptions({ enable: ["container"] });

	test("carries forward device-mode that actually ran", () => {
		// The guest keeps settings an earlier apply landed — a device-mode update moves
		// only the settings it names — so the record has to keep them too.
		const state = machine({
			deviceMode: { mode: "advanced", enable: ["ipsec"] },
			provisioning: { at: "2026-01-01T00:00:00.000Z", steps: ["deviceMode"] },
		});
		expect(appliedDeviceModeRecord(state, applied))
			.toEqual({ mode: "rose", enable: ["container", "ipsec"], disable: undefined });
	});

	test("drops intent that never reached the guest", () => {
		// A first boot that threw at the packages step leaves `deviceMode` in state as
		// desired config having never been applied. Folding it in here and then stamping
		// `deviceMode` as applied would make a later start treat ipsec as satisfied.
		const state = machine({
			deviceMode: { mode: "advanced", enable: ["ipsec"] },
			provisioning: { at: "2026-01-01T00:00:00.000Z", steps: ["packages"] },
		});
		expect(appliedDeviceModeRecord(state, applied))
			.toEqual({ mode: "rose", enable: ["container"], disable: undefined });
	});

	test("and so a later start still asks for the intent that was never applied", () => {
		// The harm the gate prevents, stated as the behaviour that matters: after a
		// post-boot `set --device-mode-enable container`, a start that asks for the ipsec
		// the guest never got must not read as satisfied.
		const before = machine({
			deviceMode: { mode: "advanced", enable: ["ipsec"] },
			provisioning: { at: "2026-01-01T00:00:00.000Z", steps: ["packages"] },
		});
		const after = machine({
			deviceMode: appliedDeviceModeRecord(before, applied),
			provisioning: { at: "2026-01-01T00:00:00.000Z", steps: ["packages", "deviceMode"] },
			lastStartedAt: "2026-01-01T00:00:00.000Z",
		});
		const [ask] = classifyProvisioningRequest(after, { deviceMode: { mode: "advanced", enable: ["ipsec"] } });
		expect(ask?.satisfied).toBe(false);
	});

	test("no prior record at all is simply the applied selection", () => {
		expect(appliedDeviceModeRecord(machine(), applied))
			.toEqual({ mode: "rose", enable: ["container"], disable: undefined });
	});
});
