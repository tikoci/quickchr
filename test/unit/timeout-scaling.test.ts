import { describe, test, expect } from "bun:test";
import { accelTimeoutFactor } from "../../src/lib/platform.ts";
import { defaultBootTimeout } from "../../src/lib/quickchr.ts";
import { BOOT_FORENSICS_BUDGET_MS } from "../../src/lib/diagnostics.ts";
import {
	bootTestTimeoutFor,
	COLD_DOWNLOAD_FLOOR_BYTES_PER_S,
	coldDownloadTestTimeout,
	DOWNLOAD_TEST_BASE_MS,
	PACKAGES_ZIP_BYTES,
} from "../integration/timeouts.ts";
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

describe("coldDownloadTestTimeout budgets a cold artifact fetch", () => {
	// Run 30606079288 (first genuinely cold cache after the #104 key redesign)
	// is the data window: 9.8 MB took 16.2 s and 52.2 MB did not finish inside a
	// flat 120 s, though it did finish. The budget has to cover the observed
	// transfer with margin — a *completed* download must never read as a failure.
	// The sizes come from the same fixture license.test.ts budgets against, so a
	// re-measured artifact cannot leave this test pinning a stale number.
	const ARM64_ZIP_BYTES = PACKAGES_ZIP_BYTES.arm64;
	const X86_ZIP_BYTES = PACKAGES_ZIP_BYTES.x86;

	test("covers the observed cold transfer with margin", () => {
		expect(coldDownloadTestTimeout(ARM64_ZIP_BYTES)).toBeGreaterThan(150_000);
		expect(coldDownloadTestTimeout(X86_ZIP_BYTES)).toBeGreaterThan(16_200);
	});

	test("the arm64 zip's budget clears the flat 120 s that failed it", () => {
		expect(coldDownloadTestTimeout(ARM64_ZIP_BYTES)).toBeGreaterThan(120_000);
	});

	test("scales with size — a bigger artifact gets a bigger budget", () => {
		expect(coldDownloadTestTimeout(ARM64_ZIP_BYTES)).toBeGreaterThan(coldDownloadTestTimeout(X86_ZIP_BYTES));
		const both = coldDownloadTestTimeout(ARM64_ZIP_BYTES + X86_ZIP_BYTES);
		expect(both).toBeGreaterThan(coldDownloadTestTimeout(ARM64_ZIP_BYTES));
	});

	test("assumed throughput stays a floor, well under what CI observed", () => {
		// 0.35 MB/s was the slowest observed; a floor at or above that would put
		// the budget back where the flat number was.
		expect(COLD_DOWNLOAD_FLOOR_BYTES_PER_S).toBeLessThan(350_000);
	});

	test("a zero-byte artifact still gets the fixed extraction/assertion base", () => {
		expect(coldDownloadTestTimeout(0)).toBe(DOWNLOAD_TEST_BASE_MS);
	});

	test("transfer time rounds UP to the next whole second", () => {
		// Pins ceil, not floor: flooring would under-budget by up to a second on
		// every artifact, which is the direction that turns a completed download
		// back into a test failure. Exactly one floor-second of bytes costs 1 s;
		// one byte more costs 2 s.
		expect(coldDownloadTestTimeout(COLD_DOWNLOAD_FLOOR_BYTES_PER_S)).toBe(DOWNLOAD_TEST_BASE_MS + 1_000);
		expect(coldDownloadTestTimeout(COLD_DOWNLOAD_FLOOR_BYTES_PER_S + 1)).toBe(DOWNLOAD_TEST_BASE_MS + 2_000);
	});
});
