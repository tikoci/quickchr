import { describe, expect, test } from "bun:test";
import {
	formatDeviceModeSelection,
	resolveDeviceModeOptions,
	shouldApplyDeviceMode,
	verifyDeviceMode,
} from "../../src/lib/device-mode.ts";

describe("device-mode option resolution", () => {
	test("undefined options → skip (no provisioning)", () => {
		const resolved = resolveDeviceModeOptions();
		expect(resolved.skip).toBe(true);
		expect(shouldApplyDeviceMode(resolved)).toBe(false);
		expect(resolved.warnings.length).toBe(0);
	});

	test("explicit auto resolves to rose", () => {
		const resolved = resolveDeviceModeOptions({ mode: "auto" });
		expect(resolved.skip).toBe(false);
		expect(resolved.mode).toBe("rose");
		expect(shouldApplyDeviceMode(resolved)).toBe(true);
		expect(formatDeviceModeSelection(resolved)).toBe("mode=rose");
	});

	test("skip mode disables provisioning", () => {
		const resolved = resolveDeviceModeOptions({
			mode: "skip",
			enable: ["container"],
			disable: ["zerotier"],
		});
		expect(resolved.skip).toBe(true);
		expect(shouldApplyDeviceMode(resolved)).toBe(false);
		expect(resolved.warnings.some((w) => w.includes("ignores"))).toBe(true);
	});

	test("enterprise alias maps to advanced", () => {
		const resolved = resolveDeviceModeOptions({ mode: "enterprise" });
		expect(resolved.mode).toBe("advanced");
		expect(resolved.warnings.some((w) => w.includes("legacy"))).toBe(true);
	});

	test("options with enable but no mode defaults to auto → rose", () => {
		const resolved = resolveDeviceModeOptions({ enable: ["container"] });
		expect(resolved.skip).toBe(false);
		expect(resolved.mode).toBe("rose");
		expect(resolved.features.container).toBe("yes");
	});

	test("unknown mode and feature only warn", () => {
		const resolved = resolveDeviceModeOptions({
			mode: "future-mode",
			enable: ["new-feature"],
		});
		expect(resolved.mode).toBe("future-mode");
		expect(resolved.features["new-feature"]).toBe("yes");
		expect(resolved.warnings.some((w) => w.includes("unknown device-mode 'future-mode'"))).toBe(true);
		expect(resolved.warnings.some((w) => w.includes("unknown device-mode feature 'new-feature'"))).toBe(true);
	});

	test("disable wins when feature appears in both lists", () => {
		const resolved = resolveDeviceModeOptions({
			mode: "advanced",
			enable: ["container"],
			disable: ["container"],
		});
		expect(resolved.features.container).toBe("no");
		expect(resolved.warnings.some((w) => w.includes("both enable and disable"))).toBe(true);
	});
});

describe("device-mode verification", () => {
	test("verification succeeds when mode/features match", () => {
		const resolved = resolveDeviceModeOptions({
			mode: "rose",
			enable: ["routerboard"],
			disable: ["zerotier"],
		});
		const verification = verifyDeviceMode(resolved, {
			mode: "rose",
			routerboard: "yes",
			zerotier: "no",
		});
		expect(verification.ok).toBe(true);
		expect(verification.mismatches.length).toBe(0);
	});

	test("verification reports mismatches", () => {
		const resolved = resolveDeviceModeOptions({
			mode: "rose",
			enable: ["routerboard"],
		});
		const verification = verifyDeviceMode(resolved, {
			mode: "advanced",
			routerboard: "no",
		});
		expect(verification.ok).toBe(false);
		expect(verification.mismatches.some((m) => m.includes("mode"))).toBe(true);
		expect(verification.mismatches.some((m) => m.includes("routerboard"))).toBe(true);
	});

	test("verification accepts RouterOS-style string booleans", () => {
		const resolved = resolveDeviceModeOptions({
			mode: "basic",
			enable: ["bandwidth-test", "ipsec"],
			disable: ["smb"],
		});
		const verification = verifyDeviceMode(resolved, {
			mode: "basic",
			"bandwidth-test": "true",
			ipsec: "true",
			smb: "false",
		});
		expect(verification.ok).toBe(true);
		expect(verification.mismatches.length).toBe(0);
	});
});
