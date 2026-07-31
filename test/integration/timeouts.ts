/**
 * Per-test timeouts derived from the boot budget the library will actually use.
 *
 * Why this exists (tikoci/quickchr#106): integration tests used to hardcode
 * `300_000`, which is *shorter* than the same-arch TCG boot budget of 480 s. On
 * every TCG leg a stuck boot was therefore killed by bun before `waitForBoot()`
 * gave up, so `captureBootFailure()` never ran and the failure arrived with no
 * evidence — the reason #79 sat unexplained for so long. In run 30383938261 the
 * only two failures that produced a report were the ones in a test whose
 * timeout (540 s) happened to exceed the budget.
 *
 * The invariant this file enforces is simply:
 *
 *   test timeout  >  boots × bootTimeout + forensics + test body
 *
 * `forensics` is one budget, not one per capture kind, and stays that way now
 * that `chr-rest.ts` can also trigger a capture after readiness (#69). A test
 * gets at most one: either a boot exhausts its budget and throws — in which case
 * no post-readiness request is ever made — or every boot succeeds and a later
 * request fails. The two are mutually exclusive per test, and the worst case is
 * already the sum above: boots that each take nearly the full budget and pass,
 * then one capture.
 *
 * It does NOT retune the budget itself — `accelTimeoutFactor`'s 4× for same-arch
 * TCG is still ~11× the measured 44 s worst case, and cutting it needs its own
 * measurement of the package-install and device-mode paths (#106).
 */

import { defaultBootTimeout } from "../../src/lib/quickchr.ts";
import { transferBudgetMs } from "../../src/lib/download.ts";
import { BOOT_FORENSICS_BUDGET_MS } from "../../src/lib/diagnostics.ts";
import { detectAccel } from "../../src/lib/platform.ts";
import type { Arch } from "../../src/lib/types.ts";

/** Arch integration tests boot by default — the process-native one, matching
 *  what `QuickCHR.start()` picks when the caller passes no `arch`. */
export const TEST_ARCH: Arch = process.arch === "arm64" ? "arm64" : "x86";

/** Resolved once at module load, because a test timeout has to be a plain number
 *  at `test()` definition time and `detectAccel()` is async.
 *
 *  Gated on `QUICKCHR_INTEGRATION` so a unit-only run stays side-effect free:
 *  `detectAccel()` probes the host (`/dev/kvm` on Linux, `sysctl` on macOS), and
 *  `test/unit/timeout-scaling.test.ts` imports this module for
 *  {@link bootTestTimeoutFor}, which takes its accel as an argument. Without the
 *  gate every integration `describe` is skipped anyway, so the value is unused —
 *  `tcg` is just the conservative placeholder. */
export const TEST_ACCEL: string = process.env.QUICKCHR_INTEGRATION ? await detectAccel(TEST_ARCH) : "tcg";

/** Slack for everything in a test body that is not booting: the image download
 *  on a cold cache, REST round-trips, `stop()`/`remove()`, and the assertions. */
export const TEST_BODY_HEADROOM_MS = 180_000;

/**
 * The floor throughput the *library* budgets a cold download against, re-exported
 * so tests and the download path cannot disagree about it.
 *
 * It used to be defined here, with a note saying it did not fix the download
 * path. #116 fixed that path, so the number moved to `src/lib/download.ts` next
 * to the code that enforces it — see that file for the run-30606079288
 * measurement it comes from. **Do not reintroduce a copy:** #116's done-when
 * asks the library budget and the test budget not to drift, and two constants
 * asked not to drift are how they drift.
 */
export { COLD_DOWNLOAD_FLOOR_BYTES_PER_S } from "../../src/lib/download.ts";

/** Byte sizes of the all-packages artifacts the integration suite downloads.
 *  `license.test.ts` pins 7.22.1, so these are constants of fixed artifacts
 *  rather than estimates (measured 2026-07-31 via `curl -sI` against
 *  download.mikrotik.com). They live here, next to the budget they feed, so the
 *  test that downloads them and the unit test that pins the budget cannot drift
 *  apart. Un-pinning the version in `license.test.ts` means re-measuring these. */
export const PACKAGES_ZIP_BYTES = { arm64: 52_216_933, x86: 9_821_339 } as const;

/** Slack on top of the library's own transfer budget: zip extraction,
 *  enumeration, and the assertions. Extracting the 52.2 MB arm64 zip is the
 *  largest of these. */
export const DOWNLOAD_TEST_BASE_MS = 120_000;

/**
 * Timeout for a test whose cost is dominated by downloading a known artifact on
 * a cold cache. Pass the artifact's size in bytes — for version-pinned test
 * fixtures that is a constant, not an estimate.
 *
 * Derived from {@link transferBudgetMs}, the budget the library itself will
 * enforce, rather than recomputing it from the floor throughput. That makes one
 * of #106's partial orders structural instead of coincidental:
 *
 *   download stall + transfer deadline  <  test timeout
 *
 * A test can no longer be given less time than the download it is waiting on —
 * which is the #91/#116 failure in its general form. `test/unit/timeouts.test.ts`
 * pins the inequality.
 *
 * ```ts
 * test("arm64 packages match 7.22.1", async () => { ... },
 *      coldDownloadTestTimeout(PACKAGES_ZIP_BYTES.arm64));
 * ```
 */
export function coldDownloadTestTimeout(bytes: number): number {
	return transferBudgetMs(bytes) + DOWNLOAD_TEST_BASE_MS;
}

export interface BootTestTimeoutOptions {
	/** How many full CHR boots the test performs. Default 1. */
	boots?: number;
	/** True when a boot installs packages — `defaultBootTimeout()` doubles for it. */
	withPackages?: boolean;
	/** Extra slack for anything unusually slow in this specific test. */
	extraMs?: number;
}

/**
 * Timeout for a test that boots CHR, guaranteed to outlive the boot budget plus
 * the forensics that run when that budget is exhausted.
 *
 * Use it as the third argument to `test()`:
 *
 * ```ts
 * test("start → wait for boot → stop", async () => { ... }, bootTestTimeout());
 * test("clean() resets disk ...", async () => { ... }, bootTestTimeout({ boots: 2 }));
 * ```
 */
export function bootTestTimeout(opts: BootTestTimeoutOptions = {}): number {
	return bootTestTimeoutFor(TEST_ARCH, TEST_ACCEL, opts);
}

/** {@link bootTestTimeout} for an explicit arch/accel instead of this host's.
 *  Exists so the invariant can be unit-tested across every accel, not just the
 *  one the machine running the tests happens to have. */
export function bootTestTimeoutFor(arch: Arch, accel: string, opts: BootTestTimeoutOptions = {}): number {
	const boots = opts.boots ?? 1;
	const budget = defaultBootTimeout(arch, opts.withPackages, accel);
	return boots * budget + BOOT_FORENSICS_BUDGET_MS + TEST_BODY_HEADROOM_MS + (opts.extraMs ?? 0);
}
