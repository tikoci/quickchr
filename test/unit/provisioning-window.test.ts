import { describe, test, expect } from "bun:test";
import {
	assertProvisioningWindow,
	classifyProvisioningRequest,
	hasProvisioningRequest,
	isProvisioningWindowOpen,
} from "../../src/lib/provisioning-window.ts";
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
		try {
			assertProvisioningWindow(booted(), { deviceMode: { enable: ["container"] } });
			throw new Error("expected a refusal");
		} catch (e) {
			const err = e as { code?: string; message: string };
			expect(err.code).toBe("PROVISIONING_WINDOW_CLOSED");
			expect(err.message).toContain("container=yes");
			expect(err.message).toContain("setDeviceMode()");
			expect(err.message).toContain("quickchr clean pw-test");
		}
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

	test("license names the CLI route that already ships", () => {
		expect(() => assertProvisioningWindow(booted(), { license: "p10" })).toThrow(/quickchr set pw-test --license/);
	});

	test("an option state already records is a no-op, not a refusal", () => {
		const state = machine({
			lastStartedAt: new Date().toISOString(),
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
			user: { name: "quickchr", password: "stored" },
			disableAdmin: true,
			secureLogin: true,
		});
		expect(satisfied.map((a) => a.step).sort()).toEqual(
			["deviceMode", "disableAdmin", "license", "packages", "secureLogin", "user"],
		);
		expect(satisfied.every((a) => a.satisfied)).toBe(true);
	});

	test("device-mode comparison is order-independent but not value-blind", () => {
		const state = machine({
			lastStartedAt: new Date().toISOString(),
			deviceMode: { mode: "rose", enable: ["container", "routerboard"] },
		});
		expect(() => assertProvisioningWindow(state, {
			deviceMode: { mode: "rose", enable: ["routerboard", "container"] },
		})).not.toThrow();
		expect(() => assertProvisioningWindow(state, { deviceMode: { mode: "rose", enable: ["container"], disable: ["routerboard"] } }))
			.toThrow(/has already booted/);
	});

	test("a satisfied option is still reported alongside one that is refused", () => {
		const state = machine({ lastStartedAt: new Date().toISOString(), licenseLevel: "p1" });
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
