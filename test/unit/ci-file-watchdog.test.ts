/**
 * Anchor tests for the per-file watchdog's three pure decisions (#77 B4):
 * which cap a file gets, how the enclosing step budget shortens it, and how the
 * outcome is written down.
 *
 * These pin the *derivation*, not the numbers for their own sake. The caps come
 * from a named ci-data window (runs 30657533896 + 30665449265 at `2899be4`) and
 * refreshing that window should change `OBSERVED_MAX_S` and these expectations
 * together — a cap that drifts without its window moving is the runtime-derived
 * deadline #110's rule 4 forbids.
 */
import { describe, expect, test } from "bun:test";
import {
	CAP_CEILING_S,
	CAP_FLOOR_S,
	CAP_MULTIPLIER,
	FORENSICS_RESERVE_S,
	MIN_VIABLE_CAP_S,
	OBSERVED_MAX_S,
	capSecondsFor,
	effectiveCap,
	timingLine,
} from "../../scripts/ci-file-watchdog.ts";

describe("capSecondsFor — the checked-in cap table", () => {
	test("the slowest measured file takes the ceiling", () => {
		// provisioning.test.ts: 654 s observed x 2 = 1308 s, clamped to 1200 s.
		expect(OBSERVED_MAX_S["provisioning.test.ts"]).toBe(654);
		expect(capSecondsFor("test/integration/provisioning.test.ts")).toBe(CAP_CEILING_S);
	});

	test("a file between floor and ceiling scales, rounded up to a whole minute", () => {
		// start-stop.test.ts: 538 s x 2 = 1076 s -> 1080 s (18 min).
		expect(capSecondsFor("test/integration/start-stop.test.ts")).toBe(1080);
	});

	test("cheap files take the floor, not a tight 2x cap", () => {
		// The floor exists because macos-x86 has no cache writer (#104/B3) and may
		// pay a cold download the window never measured. 2 s x 2 would kill it.
		expect(capSecondsFor("test/integration/library-api.test.ts")).toBe(CAP_FLOOR_S);
		expect(capSecondsFor("test/integration/file-transfer.test.ts")).toBe(CAP_FLOOR_S);
	});

	test("an unknown file falls back to the floor rather than going unbounded", () => {
		expect(capSecondsFor("test/integration/newly-added.test.ts")).toBe(CAP_FLOOR_S);
	});

	test("accepts a bare basename as well as a path", () => {
		expect(capSecondsFor("provisioning.test.ts")).toBe(capSecondsFor("test/integration/provisioning.test.ts"));
	});

	test("every cap leaves real margin over what the window observed", () => {
		// The margin is what keeps the watchdog from becoming a masking device on
		// the platform it exists for: macos-x86 is absent from the window (#76) and
		// may legitimately be slower than anything measured here. The tightest cap
		// in the current window is provisioning.test.ts at 1200/654 = 1.83x, held
		// down by the ceiling; every other file sits at 2x or more.
		for (const [file, observed] of Object.entries(OBSERVED_MAX_S)) {
			const cap = capSecondsFor(file);
			expect(cap).toBeGreaterThanOrEqual(CAP_FLOOR_S);
			expect(cap / observed).toBeGreaterThanOrEqual(1.5);
			// Below the ceiling, the full multiplier applies (bar minute rounding).
			if (observed * CAP_MULTIPLIER <= CAP_CEILING_S && observed * CAP_MULTIPLIER >= CAP_FLOOR_S) {
				expect(cap).toBeGreaterThanOrEqual(observed * CAP_MULTIPLIER);
			}
		}
	});

	test("the watchdog-cap lever shortens a cap but can never lengthen one", () => {
		// The lever is what makes the timeout path testable on a real runner, so
		// its one safety property — shortens only — is worth pinning. A lever that
		// could lengthen a cap would be a runtime-derived deadline wearing a
		// dispatch input (#110 rule 4).
		const table = capSecondsFor("provisioning.test.ts");
		expect(capSecondsFor("provisioning.test.ts", 45)).toBe(45);
		expect(capSecondsFor("provisioning.test.ts", table + 6000)).toBe(table);
		expect(capSecondsFor("provisioning.test.ts", table)).toBe(table);
		// Nonsense values fall back to the table rather than disabling the bound.
		for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(capSecondsFor("provisioning.test.ts", bad)).toBe(table);
		}
	});

	test("no cap can outlive the ~60 min boundary #76 dies at", () => {
		// A single file must never be able to consume the whole runner-loss window
		// on its own; that would leave the watchdog unable to name the wedge.
		for (const file of Object.keys(OBSERVED_MAX_S)) {
			expect(capSecondsFor(file)).toBeLessThanOrEqual(CAP_CEILING_S);
			expect(capSecondsFor(file)).toBeLessThan(60 * 60);
		}
	});
});

describe("effectiveCap — the step budget is the second bound", () => {
	const now = 1_000_000;

	test("with budget to spare, the file table wins", () => {
		const plan = effectiveCap(600, now, now + 3600);
		expect(plan).toMatchObject({ capS: 600, source: "file-table", run: true });
	});

	test("the forensics reserve is held back so the upload steps still run", () => {
		// 900 s left, 300 s reserved -> 600 s affordable, which shortens an 1200 s cap.
		const plan = effectiveCap(CAP_CEILING_S, now, now + 900);
		expect(plan.capS).toBe(900 - FORENSICS_RESERVE_S);
		expect(plan.source).toBe("suite-deadline");
		expect(plan.run).toBe(true);
	});

	test("a shortened cap always leaves the reserve intact", () => {
		for (const remaining of [400, 500, 900, 1500, 3000]) {
			const plan = effectiveCap(CAP_CEILING_S, now, now + remaining);
			if (!plan.run) continue;
			expect(plan.capS + FORENSICS_RESERVE_S).toBeLessThanOrEqual(remaining);
		}
	});

	test("a budget too short for a viable attempt does not start the file", () => {
		// Better to record `not-run` than to launch into a cap that guarantees a
		// meaningless timeout and reports a wedge that never happened.
		const plan = effectiveCap(600, now, now + FORENSICS_RESERVE_S + MIN_VIABLE_CAP_S - 1);
		expect(plan.run).toBe(false);
		expect(plan.source).toBe("suite-deadline");
	});

	test("an already-passed deadline does not start the file", () => {
		expect(effectiveCap(600, now, now - 10).run).toBe(false);
	});

	test("a cap already smaller than the remainder runs, however small it is", () => {
		// Regression: the viability floor used to be checked before the file's own
		// cap, so the watchdog-cap lever (which caps BELOW MIN_VIABLE_CAP_S on
		// purpose) was refused as "budget exhausted" with 99 s affordable and a
		// 3 s cap. Found by running the lever, not by reading it.
		const plan = effectiveCap(3, now, now + FORENSICS_RESERVE_S + 99);
		expect(plan).toMatchObject({ capS: 3, source: "file-table", run: true });
	});

	test("exactly at the viability boundary the file still runs", () => {
		const plan = effectiveCap(600, now, now + FORENSICS_RESERVE_S + MIN_VIABLE_CAP_S);
		expect(plan.run).toBe(true);
		expect(plan.capS).toBe(MIN_VIABLE_CAP_S);
	});

	test("no deadline (a local run) leaves the file table as the only bound", () => {
		const plan = effectiveCap(600, now, undefined);
		expect(plan).toMatchObject({ capS: 600, source: "file-table", run: true });
		expect(plan.remainingS).toBe(Number.POSITIVE_INFINITY);
	});
});

describe("timingLine — outcome serialization", () => {
	test("a pass is byte-identical to what the loop wrote before B4", () => {
		// Historical ci-data comparability: `<file> <seconds>s pass` is unchanged.
		expect(timingLine("test/integration/exec.test.ts", 149, "pass")).toBe("exec.test.ts 149s pass");
	});

	test("failures carry the widened vocabulary, not a bare `fail`", () => {
		expect(timingLine("exec.test.ts", 12, "test-failure")).toBe("exec.test.ts 12s test-failure");
		expect(timingLine("exec.test.ts", 600, "file-watchdog-timeout")).toBe("exec.test.ts 600s file-watchdog-timeout");
		expect(timingLine("exec.test.ts", 0, "not-run")).toBe("exec.test.ts 0s not-run");
	});

	test("seconds are rounded, never truncated to a float", () => {
		expect(timingLine("exec.test.ts", 149.6, "pass")).toBe("exec.test.ts 150s pass");
	});

	test("the line always parses back out of the timing file", async () => {
		const { parseTimingFile } = await import("../../scripts/ci-metrics.ts");
		const text = [
			timingLine("a.test.ts", 10, "pass"),
			timingLine("b.test.ts", 20, "test-failure"),
			timingLine("c.test.ts", 30, "file-watchdog-timeout"),
			timingLine("d.test.ts", 0, "not-run"),
		].join("\n");
		expect(parseTimingFile(text)).toEqual([
			{ file: "a.test.ts", duration_s: 10, status: "pass", outcome: "pass" },
			{ file: "b.test.ts", duration_s: 20, status: "fail", outcome: "test-failure" },
			{ file: "c.test.ts", duration_s: 30, status: "fail", outcome: "file-watchdog-timeout" },
			{ file: "d.test.ts", duration_s: 0, status: "fail", outcome: "not-run" },
		]);
	});
});
