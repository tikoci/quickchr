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
 * Throughput to assume when budgeting a COLD download from MikroTik, in bytes
 * per second. Deliberately a floor, not an average.
 *
 * Grounded rather than guessed, in run 30606079288 — the first genuinely cold
 * cache after #104 gave the image cache resolved-version keys (nothing to fall
 * back to, so both all-packages zips downloaded fresh on a hosted linux-x86
 * runner):
 *
 *   all_packages-x86-7.22.1.zip     9.8 MB   16.2 s   ~0.60 MB/s   passed
 *   all_packages-arm64-7.22.1.zip  52.2 MB   >120 s   ~0.35 MB/s   blew a flat 120 s
 *
 * The arm64 transfer was healthy, just slow: the next test in the file logged
 * `Using cached packages: 7.22.1 (arm64)`, so it finished — the *budget* was
 * wrong, and it was wrong because it was a magic number that never had a
 * measurement behind it. The floor below is roughly a third of the slower
 * observation, which keeps a slow-but-moving link inside the budget while a
 * wedged transfer still fails well inside the enclosing file and step budgets.
 *
 * This does NOT fix the download path itself. A flat 120 s abort also lives at
 * `src/lib/images.ts` (per attempt, with retries) and is why B7 measured both
 * pinned CHR images "needing two retries" on a cold cache. Replacing those
 * total-duration deadlines with stall detection and a named download outcome is
 * its own change (#116) — this constant only stops a test from calling a
 * completed download a failure.
 */
export const COLD_DOWNLOAD_FLOOR_BYTES_PER_S = 120_000;

/** Fixed slack on top of transfer time: zip extraction, enumeration and the
 *  assertions. Extracting the 52.2 MB arm64 zip is the largest of these. */
export const DOWNLOAD_TEST_BASE_MS = 60_000;

/**
 * Timeout for a test whose cost is dominated by downloading a known artifact on
 * a cold cache. Pass the artifact's size in bytes — for version-pinned test
 * fixtures that is a constant, not an estimate.
 *
 * ```ts
 * test("arm64 packages match 7.22.1", async () => { ... },
 *      coldDownloadTestTimeout(PACKAGES_ZIP_BYTES.arm64));
 * ```
 */
export function coldDownloadTestTimeout(bytes: number): number {
	return DOWNLOAD_TEST_BASE_MS + Math.ceil(bytes / COLD_DOWNLOAD_FLOOR_BYTES_PER_S) * 1000;
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
