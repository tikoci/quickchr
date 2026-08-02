import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legKey } from "../../scripts/ci-leg-checkpoint.ts";
import {
	buildRunLedger,
	classifyLeg,
	completedLegs,
	integrationJobName,
	mapJobsToLegs,
	TEST_STEP_NAME,
	type CheckpointView,
	type JobView,
	type PlannedLeg,
} from "../../scripts/ci-leg-ledger.ts";

// Anchor tests for the incomplete-leg ledger (B5 of #110, part 2 of #77).
//
// The input this exists for — a runner that stops talking mid-suite — cannot be
// produced locally, which is exactly why classification is a pure function fed
// by three plain maps. Everything below is the shape of run 30665449265's three
// vanished `macos-x86` legs, transcribed from the jobs API.

const LEG: PlannedLeg = { id: "macos-x86", label: "macos/x86_64", target: "stable", resolved: "7.23.2" };

const META = { ts: "2026-08-02T00:00:00.000Z", sha: "abc123", attempt: "1", event: "workflow_dispatch" };

/** A job whose runner vanished: terminal at the job level, with the test step
 *  still `in_progress` and every later step never started. */
function vanishedJob(over: Partial<JobView> = {}): JobView {
	return {
		name: integrationJobName(LEG.label, LEG.target),
		status: "completed",
		conclusion: "failure",
		started_at: "2026-07-31T21:07:55Z",
		completed_at: "2026-07-31T22:09:53Z",
		steps: [
			{ name: "Set up job", status: "completed", conclusion: "success", started_at: "2026-07-31T21:07:49Z" },
			{ name: TEST_STEP_NAME, status: "in_progress", conclusion: null, started_at: "2026-07-31T21:08:57Z" },
			{ name: "Kill leftover QEMU processes", status: "pending", conclusion: null, started_at: null },
		],
		...over,
	};
}

function checkpoint(over: Partial<CheckpointView> = {}): CheckpointView {
	return {
		status: "in_progress",
		checkRunId: 42,
		payload: {
			planned: ["anchor.test.ts", "exec.test.ts", "provisioning.test.ts"],
			startedAt: "2026-07-31T21:08:57Z",
			records: [
				{ file: "anchor.test.ts", index: 1, outcome: "pass", duration_s: 168, ts: "2026-07-31T21:11:45Z" },
				{ file: "exec.test.ts", index: 2, outcome: "pass", duration_s: 149, ts: "2026-07-31T21:14:14Z" },
			],
			current: "provisioning.test.ts",
		},
		...over,
	};
}

describe("classifyLeg", () => {
	test("a leg that reached ci-data is complete even if its checkpoint never closed", () => {
		// THE safety property. The checkpoint instrument posts best-effort and
		// exits 0 on any API failure, so a dropped PATCH leaves the check run
		// stuck `in_progress` on a leg that finished perfectly well. Reading the
		// check run first would fabricate a `runner-lost` out of instrument
		// failure — and #110's whole premise is that a masked signal is worse
		// than no signal.
		const entry = classifyLeg(
			LEG,
			new Set([legKey("macos-x86", "stable")]),
			new Map([[legKey("macos-x86", "stable"), checkpoint()]]),
			new Map([[legKey("macos-x86", "stable"), vanishedJob()]]),
		);
		expect(entry.terminal).toBe("complete");
		expect(entry.why).toContain("metrics record");
	});

	test("a job that ended with its test step still running is runner-lost, and names the file", () => {
		const entry = classifyLeg(
			LEG,
			new Set(),
			new Map([[legKey("macos-x86", "stable"), checkpoint()]]),
			new Map([[legKey("macos-x86", "stable"), vanishedJob()]]),
		);
		expect(entry.terminal).toBe("runner-lost");
		expect(entry.stalled_step).toBe(TEST_STEP_NAME);
		// The answer #76 has never had: not just "the leg died" but where.
		expect(entry.last_file).toBe("exec.test.ts");
		expect(entry.current_file).toBe("provisioning.test.ts");
		expect(entry.files_reported).toBe(2);
		expect(entry.files_planned).toBe(3);
		// 21:07:55 → 22:09:53. An upper bound on the wedge, not the wedge.
		expect(entry.job_elapsed_s).toBe(3718);
	});

	test("an un-closed check run alone is enough when no job could be matched", () => {
		// Job matching goes through a display-name template; if that ever drifts,
		// the ledger must degrade to the other instrument rather than silently
		// reclassify every vanished leg as `attempted-incomplete`.
		const entry = classifyLeg(LEG, new Set(), new Map([[legKey("macos-x86", "stable"), checkpoint()]]), new Map());
		expect(entry.terminal).toBe("runner-lost");
		expect(entry.job_matched).toBe(false);
		expect(entry.last_file).toBe("exec.test.ts");
	});

	test("an un-closed check run on a job that finished every step is a failed close, not runner loss", () => {
		// The `close` PATCH is best-effort and can fail transiently, leaving the
		// check run `in_progress` on a leg whose job ran to the end. Reading that
		// as runner loss would be an API hiccup wearing #76's clothes — the jobs
		// API is server-side and unconditional, so it wins the disagreement.
		const finishedJob = vanishedJob({
			conclusion: "failure",
			steps: [
				{ name: TEST_STEP_NAME, status: "completed", conclusion: "failure", started_at: "2026-07-31T21:08:57Z" },
				{ name: "Close leg checkpoint", status: "completed", conclusion: "success", started_at: "2026-07-31T21:20:00Z" },
			],
		});
		const entry = classifyLeg(
			LEG,
			new Set(),
			new Map([[legKey("macos-x86", "stable"), checkpoint({ status: "in_progress" })]]),
			new Map([[legKey("macos-x86", "stable"), finishedJob]]),
		);
		expect(entry.terminal).toBe("attempted-incomplete");
		expect(entry.why).toContain("failed close, not a lost runner");
		// The forensics still survive — only the verdict changes.
		expect(entry.last_file).toBe("exec.test.ts");
	});

	test("a closed checkpoint with no metrics record is attempted-incomplete, not runner-lost", () => {
		// The leg ran to the end of its loop and then lost its evidence (a failed
		// upload, a skipped assemble). Calling that runner loss would send #76
		// chasing a mechanism that was never involved.
		const job = vanishedJob({
			steps: [{ name: TEST_STEP_NAME, status: "completed", conclusion: "failure", started_at: "2026-07-31T21:08:57Z" }],
		});
		const entry = classifyLeg(
			LEG,
			new Set(),
			new Map([[legKey("macos-x86", "stable"), checkpoint({ status: "completed" })]]),
			new Map([[legKey("macos-x86", "stable"), job]]),
		);
		expect(entry.terminal).toBe("attempted-incomplete");
		expect(entry.stalled_step).toBeUndefined();
	});

	test("a job that died before instrumenting itself is attempted-incomplete", () => {
		const job = vanishedJob({
			conclusion: "failure",
			steps: [
				{ name: "Set up job", status: "completed", conclusion: "success", started_at: "2026-07-31T21:07:49Z" },
				{ name: "Install QEMU + tools (macOS)", status: "completed", conclusion: "failure", started_at: "2026-07-31T21:07:57Z" },
			],
		});
		const entry = classifyLeg(LEG, new Set(), new Map(), new Map([[legKey("macos-x86", "stable"), job]]));
		expect(entry.terminal).toBe("attempted-incomplete");
		expect(entry.last_file).toBeUndefined();
	});

	test("a planned leg with no job and no checkpoint never started", () => {
		const entry = classifyLeg(LEG, new Set(), new Map(), new Map());
		expect(entry.terminal).toBe("not-started");
		expect(entry.job_matched).toBe(false);
	});

	test("legs are keyed by platform AND target — one platform runs several", () => {
		// `macos-x86 · stable` completing says nothing about `macos-x86 · testing`.
		const testingLeg: PlannedLeg = { ...LEG, target: "testing" };
		const entry = classifyLeg(testingLeg, new Set([legKey("macos-x86", "stable")]), new Map(), new Map());
		expect(entry.terminal).not.toBe("complete");
	});
});

describe("buildRunLedger", () => {
	const planned: PlannedLeg[] = [
		LEG,
		{ id: "macos-x86", label: "macos/x86_64", target: "testing", resolved: "7.24beta2" },
		{ id: "linux-x86", label: "linux/x86_64", target: "stable", resolved: "7.23.2" },
	];

	test("counts completed legs and lists only the incomplete ones", () => {
		// Green legs are already in runs/*.ndjson in full; repeating them here
		// would grow a file that lives forever without adding a fact.
		const ledger = buildRunLedger(
			planned,
			new Set([legKey("linux-x86", "stable")]),
			new Map([[legKey("macos-x86", "stable"), checkpoint()]]),
			new Map([[legKey("macos-x86", "stable"), vanishedJob()]]),
			META,
		);
		expect(ledger.planned).toBe(3);
		expect(ledger.complete).toBe(1);
		expect(Object.keys(ledger.incomplete ?? {}).sort()).toEqual(["macos-x86|stable", "macos-x86|testing"]);
		expect(ledger.incomplete?.["macos-x86|stable"]?.terminal).toBe("runner-lost");
		expect(ledger.incomplete?.["macos-x86|testing"]?.terminal).toBe("not-started");
	});

	test("a fully green run records the counts and omits the incomplete map", () => {
		const ledger = buildRunLedger(
			planned,
			new Set(planned.map((l) => legKey(l.id, l.target))),
			new Map(),
			new Map(),
			META,
		);
		expect(ledger.complete).toBe(3);
		expect(ledger.incomplete).toBeUndefined();
	});

	test("at sweep scale, every incomplete leg carries its own last file", () => {
		// Same 15-leg shape as the real replay below, but driven by checkpoints
		// instead of jobs — this is the half that supplies the file name, and it
		// has to hold for every incomplete leg, not just the first.
		const sweep: PlannedLeg[] = [];
		for (const [id, label] of [
			["linux-x86", "linux/x86_64"],
			["linux-arm64", "linux/aarch64"],
			["macos-arm64", "macos/arm64"],
			["macos-x86", "macos/x86_64"],
			["windows-x86", "windows/x86_64"],
		] as const) {
			for (const target of ["stable", "testing", "long-term"]) sweep.push({ id, label, target });
		}
		const completed = new Set(
			sweep.filter((l) => l.id !== "macos-x86").map((l) => legKey(l.id, l.target)),
		);
		const checkpoints = new Map(
			sweep.filter((l) => l.id === "macos-x86").map((l) => [legKey(l.id, l.target), checkpoint()] as const),
		);
		const ledger = buildRunLedger(sweep, completed, checkpoints, new Map(), META);
		expect(ledger.planned).toBe(15);
		expect(ledger.complete).toBe(12);
		expect(Object.keys(ledger.incomplete ?? {})).toHaveLength(3);
		for (const entry of Object.values(ledger.incomplete ?? {})) {
			expect(entry.terminal).toBe("runner-lost");
			expect(entry.last_file).toBe("exec.test.ts");
		}
	});
});

describe("completedLegs", () => {
	// This is the DEFINITION of "complete" — the primary evidence the whole
	// classification rests on. Everything else in the ledger only explains legs
	// this set does not contain.
	function dataDir(files: Record<string, string>): string {
		const dir = mkdtempSync(join(tmpdir(), "ledger-"));
		mkdirSync(join(dir, "runs"));
		for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, "runs", name), body);
		return dir;
	}

	const suite = (platform: string, target: string) =>
		`${JSON.stringify({ kind: "boot", platform, version: "7.23.2" })}\n${JSON.stringify({
			kind: "suite",
			run_id: "999",
			platform,
			target,
			scope: "full",
			conclusion: "pass",
		})}\n`;

	test("reads platform and target from the suite record, not the filename", () => {
		// Platform ids contain no separator today, but the filename is not a
		// contract — the record is.
		const dir = dataDir({ "999-macos-x86-stable.ndjson": suite("macos-x86", "stable") });
		expect([...completedLegs(dir, "999")]).toEqual([legKey("macos-x86", "stable")]);
	});

	test("ignores other runs' files sharing the ci-data branch", () => {
		const dir = dataDir({
			"999-linux-x86-stable.ndjson": suite("linux-x86", "stable"),
			"888-macos-x86-stable.ndjson": suite("macos-x86", "stable"),
		});
		expect([...completedLegs(dir, "999")]).toEqual([legKey("linux-x86", "stable")]);
	});

	test("a run that wrote nothing yields an empty set, not a throw", () => {
		expect(completedLegs(mkdtempSync(join(tmpdir(), "ledger-")), "999").size).toBe(0);
	});

	test("a truncated line costs that line, not the whole reconciliation", () => {
		// An unguarded parse here would escape build(): no ledger written AND the
		// lost-runner check runs never finalized — the script failing shut in
		// exactly the circumstances it exists for. A half-written trailing record
		// is the most plausible corruption, so the good legs must still survive it.
		const dir = dataDir({
			"999-linux-x86-stable.ndjson": suite("linux-x86", "stable"),
			"999-macos-x86-stable.ndjson": `${suite("macos-x86", "stable")}{"kind":"suite"`,
		});
		expect([...completedLegs(dir, "999")].sort()).toEqual([
			legKey("linux-x86", "stable"),
			legKey("macos-x86", "stable"),
		]);
	});

	test("a file whose every line is garbage yields no legs and no throw", () => {
		const dir = dataDir({ "999-linux-x86-stable.ndjson": "not json\n{oops\n" });
		expect(completedLegs(dir, "999").size).toBe(0);
	});
});

describe("replay of sweep 30665449265 — the run that made this bite exist", () => {
	// Real job records from `platforms=all` x 3 targets on `main` @ 2899be4,
	// where three macos-x86 runners vanished and ci-data received 12 ndjson files
	// for 15 legs. Trimmed to the fields classification reads: each job keeps its
	// steps up to and including the first that started and never completed (jobs
	// without one keep two steps, which preserves the same answer).
	//
	// This is the only test fed by a genuine runner-loss event rather than a
	// fixture someone wrote to match their own expectations.
	const realJobs = JSON.parse(
		readFileSync(join(import.meta.dir, "fixtures", "sweep-30665449265-jobs.json"), "utf-8"),
	) as JobView[];

	const sweepPlan: PlannedLeg[] = [];
	for (const [id, label] of [
		["linux-x86", "linux/x86_64"],
		["linux-arm64", "linux/aarch64"],
		["macos-arm64", "macos/arm64"],
		["macos-x86", "macos/x86_64"],
		["windows-x86", "windows/x86_64"],
	] as const) {
		for (const target of ["stable", "testing", "long-term"]) sweepPlan.push({ id, label, target });
	}

	// The PRODUCTION join, not a copy of it. Rebuilding the name lookup here
	// would let this suite keep passing while the real join broke — and a broken
	// join degrades silently to `job_matched: false` rather than erroring, so a
	// test that cannot catch it is worth very little.
	const realJobMap = (): Map<string, JobView> => mapJobsToLegs(sweepPlan, realJobs);

	test("every planned leg matches a real job by name", () => {
		// The one silent-degradation risk in this design: the jobs API exposes no
		// matrix values, so a rename of integration.yml's `name:` would strand
		// every leg at job_matched:false with no error anywhere. Asserting against
		// production names covers all five platform labels at once.
		expect(realJobMap().size).toBe(15);
	});

	test("classifies the three vanished legs as runner-lost, from the jobs API alone", () => {
		// No check runs existed on that run — this bite had not landed — so this
		// exercises the free half of the ledger with nothing to lean on.
		const completed = new Set(
			sweepPlan.filter((l) => l.id !== "macos-x86").map((l) => legKey(l.id, l.target)),
		);
		const ledger = buildRunLedger(sweepPlan, completed, new Map(), realJobMap(), META);

		expect(ledger.planned).toBe(15);
		expect(ledger.complete).toBe(12);
		expect(Object.keys(ledger.incomplete ?? {}).sort()).toEqual([
			"macos-x86|long-term",
			"macos-x86|stable",
			"macos-x86|testing",
		]);
		for (const entry of Object.values(ledger.incomplete ?? {})) {
			expect(entry.terminal).toBe("runner-lost");
			expect(entry.stalled_step).toBe(TEST_STEP_NAME);
			expect(entry.job_matched).toBe(true);
			// Without the checkpoint there is no file name — which is exactly the
			// gap the check run fills, and why the jobs API alone is not enough.
			expect(entry.last_file).toBeUndefined();
		}
	});

	test("the death boundary is per-job elapsed, not a shared wall-clock event", () => {
		// #76 grounding, carried as an assertion so a future change to the elapsed
		// computation cannot quietly rewrite the number the issue cites. The three
		// legs started 11 minutes apart and died 14 minutes apart, each ~62-65 min
		// into its own job — so this is something each leg accumulates on its own
		// clock, not a service blip they all hit together.
		const ledger = buildRunLedger(
			sweepPlan,
			new Set(sweepPlan.filter((l) => l.id !== "macos-x86").map((l) => legKey(l.id, l.target))),
			new Map(),
			realJobMap(),
			META,
		);
		const elapsed = Object.values(ledger.incomplete ?? {})
			.map((e) => e.job_elapsed_s ?? 0)
			.sort((a, b) => a - b);
		expect(elapsed).toEqual([3718, 3844, 3902]);
		for (const s of elapsed) {
			expect(s).toBeGreaterThan(60 * 60);
			expect(s).toBeLessThan(66 * 60);
		}
	});
});

describe("job name mapping", () => {
	test("matches integration.yml's job name template exactly", () => {
		// The jobs API exposes no matrix values, so this string IS the join key.
		// integration.yml carries a pointer here; if that `name:` is edited
		// without updating this, every ledger entry silently degrades to
		// job_matched: false — so assert the literal, not a round trip.
		expect(integrationJobName("macos/x86_64", "stable")).toBe("Integration (macos/x86_64 · stable)");
	});

	test("the stalled-step name matches the workflow's test step", () => {
		expect(TEST_STEP_NAME).toBe("Run integration tests (sequential per-file)");
	});
});
