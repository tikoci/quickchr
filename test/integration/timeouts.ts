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
