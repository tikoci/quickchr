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
import { transferBudgetMs } from "../../src/lib/download.ts";
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
		expect(coldDownloadTestTimeout(0)).toBe(DOWNLOAD_TEST_BASE_MS + transferBudgetMs(0));
	});

	test("transfer time rounds UP, never down", () => {
		// Pins ceil, not floor: flooring under-budgets, which is the direction that
		// turns a completed download back into a failure — the #116 defect itself.
		// Granularity is the millisecond (it was whole seconds while this was a
		// test-only helper); what must not change is the direction.
		const base = DOWNLOAD_TEST_BASE_MS + transferBudgetMs(0);
		expect(coldDownloadTestTimeout(COLD_DOWNLOAD_FLOOR_BYTES_PER_S)).toBe(base + 1_000);
		expect(coldDownloadTestTimeout(COLD_DOWNLOAD_FLOOR_BYTES_PER_S + 1)).toBe(base + 1_001);

		// The exact-fit case is the one that matters: a transfer running at exactly
		// the floor must still fit its own budget.
		for (const bytes of [1, 999, COLD_DOWNLOAD_FLOOR_BYTES_PER_S * 7 + 3]) {
			const transferOnly = transferBudgetMs(bytes) - transferBudgetMs(0);
			expect(transferOnly).toBeGreaterThanOrEqual((bytes / COLD_DOWNLOAD_FLOOR_BYTES_PER_S) * 1000);
		}
	});

	// #116/B13: the test timeout is now DERIVED from the budget the library
	// enforces, so it cannot be set below it. This is one of #106's partial
	// orders, pinned rather than left to coincidence — the previous arrangement
	// (two independent computations from the same floor) happened to satisfy it
	// by 30 s, which is exactly the kind of accidental margin B12 removes.
	test("a test always outlives the library's own transfer budget for the same artifact", () => {
		for (const bytes of [0, X86_ZIP_BYTES, ARM64_ZIP_BYTES, ARM64_ZIP_BYTES + X86_ZIP_BYTES]) {
			expect(coldDownloadTestTimeout(bytes)).toBeGreaterThan(transferBudgetMs(bytes));
		}
	});

	test("the margin over the library budget covers extraction and assertions", () => {
		// Extracting the 52.2 MB arm64 zip is the largest non-transfer cost in
		// these tests; 120 s of headroom is what DOWNLOAD_TEST_BASE_MS buys.
		const margin = coldDownloadTestTimeout(ARM64_ZIP_BYTES) - transferBudgetMs(ARM64_ZIP_BYTES);
		expect(margin).toBe(DOWNLOAD_TEST_BASE_MS);
		expect(margin).toBeGreaterThanOrEqual(60_000);
	});
});
