import { describe, test, expect } from "bun:test";
import { accelTimeoutFactor } from "../../src/lib/platform.ts";
import { defaultBootTimeout } from "../../src/lib/quickchr.ts";
import { BOOT_FORENSICS_BUDGET_MS } from "../../src/lib/diagnostics.ts";
import { bootTestTimeoutFor } from "../integration/timeouts.ts";
import type { Arch } from "../../src/lib/types.ts";

describe("accelTimeoutFactor", () => {
	test("kvm same-arch = 1.5", () => expect(accelTimeoutFactor("kvm", false)).toBe(1.5));
	test("hvf same-arch = 1.5", () => expect(accelTimeoutFactor("hvf", false)).toBe(1.5));
	test("tcg same-arch = 4.0", () => expect(accelTimeoutFactor("tcg", false)).toBe(4.0));
	test("tcg cross-arch = 15.0", () => expect(accelTimeoutFactor("tcg", true)).toBe(15.0));
	test("kvm cross-arch = 1.5", () => expect(accelTimeoutFactor("kvm", true)).toBe(1.5));
	test("hvf cross-arch = 1.5", () => expect(accelTimeoutFactor("hvf", true)).toBe(1.5));
	test("unknown accel same-arch = 4.0 (TCG fallback)", () => expect(accelTimeoutFactor("unknown", false)).toBe(4.0));
	test("unknown accel cross-arch = 15.0 (TCG fallback)", () => expect(accelTimeoutFactor("unknown", true)).toBe(15.0));
});

/**
 * The #106 invariant: a test's own timeout must outlive the boot budget *plus*
 * the forensics that run once that budget is exhausted.
 *
 * When it does not, bun kills the test first and `captureBootFailure()` never
 * runs — which is how the TCG legs in run 30383938261 produced four failures
 * with no report at all (480 s budget vs a hardcoded 300 s test timeout).
 */
describe("bootTestTimeout outlives the boot budget it is paired with", () => {
	const arches: Arch[] = ["x86", "arm64"];
	const accels = ["kvm", "hvf", "tcg", "unknown"];

	for (const arch of arches) {
		for (const accel of accels) {
			for (const boots of [1, 2]) {
				for (const withPackages of [false, true]) {
					const label = `${arch}/${accel} boots=${boots}${withPackages ? " +packages" : ""}`;
					test(label, () => {
						const budget = defaultBootTimeout(arch, withPackages, accel);
						const testTimeout = bootTestTimeoutFor(arch, accel, { boots, withPackages });
						expect(testTimeout).toBeGreaterThan(boots * budget + BOOT_FORENSICS_BUDGET_MS);
					});
				}
			}
		}
	}

	test("extraMs adds on top rather than replacing headroom", () => {
		const base = bootTestTimeoutFor("x86", "tcg");
		expect(bootTestTimeoutFor("x86", "tcg", { extraMs: 60_000 })).toBe(base + 60_000);
	});
});
