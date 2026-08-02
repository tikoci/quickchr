#!/usr/bin/env bun
/**
 * ci-file-watchdog — bound ONE integration test file, then leave evidence
 * (issue #77, B4 of #110).
 *
 *   bun scripts/ci-file-watchdog.ts --file test/integration/exec.test.ts \
 *     --timing "$HOME/integration-timing.txt" --report-dir "$HOME"
 *
 * WHY THIS EXISTS. `integration.yml` runs test files sequentially and the step
 * carries a cap 10 min under the job budget (#108). Both bounds are far too
 * coarse to say *which file* wedged: on the extended-budget platforms the step
 * cap is 290 minutes, so a single hung file can burn the whole leg and the
 * failure arrives as "the step ran out of time" with no name attached. This
 * puts the control at file granularity, where the answer is.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not make a lost runner
 * diagnosable. #76's `macos-x86` legs die at ~62 min holding a 290-minute step
 * budget — nothing running *inside* the job survives that, this script
 * included. That is B5's server-visible ledger, and B4 must not be mistaken for
 * it. What this does deliver is the other half: when a file hangs rather than
 * the runner vanishing, the leg now fails *at that file*, with its name, cap,
 * host state and cleanup result preserved.
 *
 * ── The caps ────────────────────────────────────────────────────────────────
 * Deterministic, checked in, and derived from a NAMED ci-data window — never
 * fetched at runtime. Runtime derivation would let a hang inflate its own next
 * deadline, which is #110's operating rule 4.
 *
 * Window: runs **30657533896** and **30665449265**, both at `2899be4` — 14 legs
 * across all four platforms that complete a suite, 168 `test-file` records, one
 * non-pass (a `resolveVersion` flake, #121). Drawn *after* #116 landed, which
 * matters: before that, a flat 120 s download deadline aborted healthy
 * transfers and re-downloaded from zero, so file durations carried retry
 * inflation rather than cost (B7 measured `provisioning.test.ts` at 992 s of
 * which 619 s had no QEMU alive at all). Re-derive with:
 *
 * ```sh
 * git fetch origin ci-data
 * git show origin/ci-data:runs/<run_id>-<platform>-<target>.ndjson \
 *   | jq -r 'select(.kind=="test-file")|"\(.file) \(.duration_s)s \(.outcome // .status)"'
 * ```
 *
 * Take only `pass` rows: a file this watchdog killed reports its cap, not its
 * cost, and folding that back in would let the caps ratchet up off their own
 * timeouts.
 *
 * `macos-x86` is ABSENT from that window and cannot be added while #76 stands —
 * it has never completed a full suite, which is the whole problem. So the caps
 * are deliberately generous rather than tight: a watchdog that killed a healthy
 * file on the one platform under investigation would manufacture exactly the
 * kind of masked signal this program exists to stop. The suite-deadline clamp
 * below, not a tight per-file cap, is what bounds the total.
 *
 * ── The two bounds ──────────────────────────────────────────────────────────
 * A file is bounded by its own cap AND by what remains of the enclosing step
 * budget, whichever is smaller (#110 rule 5 — timeouts nest):
 *
 *   file cap  +  reap + forensics reserve  <  remaining step budget
 *
 * so the reap / metrics / summary / upload steps always still run. When the
 * remaining budget cannot fit even a minimum viable attempt, the file is not
 * started at all and says so, rather than being launched into a cap that
 * guarantees a meaningless timeout.
 */
import { existsSync, appendFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { hostSnapshot, qemuProcessCount } from "./ci-host-snapshot.ts";

/**
 * Worst observed healthy duration per file, in seconds, over the cited window.
 * Checked in so the derivation is auditable and a refresh is a data edit, not a
 * code change. A file missing here (a newly added test) falls back to
 * {@link CAP_FLOOR_S}.
 */
export const OBSERVED_MAX_S: Record<string, number> = {
	"anchor.test.ts": 168,
	"device-mode.test.ts": 290,
	"disk.test.ts": 88,
	"examples-smoke.test.ts": 1,
	"exec.test.ts": 149,
	"file-transfer.test.ts": 51,
	"forward-cli.test.ts": 158,
	"library-api.test.ts": 2,
	"license.test.ts": 253,
	"provisioning.test.ts": 654,
	"settings-secure-login-cli.test.ts": 68,
	"start-stop.test.ts": 538,
};

/** Multiplier over the worst observed healthy duration. */
export const CAP_MULTIPLIER = 2;

/**
 * Floor. Nothing gets a cap under 10 minutes, however cheap it looks in the
 * window: `macos-x86` has no cache writer while #76 stands (#104/B3), so every
 * one of its files may pay a cold image download the window never measured —
 * up to 465 s of legitimate transfer budget for the 52.2 MB artifact (#116).
 * A 2× cap on a 51-second file would kill that healthy download outright.
 */
export const CAP_FLOOR_S = 600;

/** Ceiling — #77's "a 15-20 minute floor bounds the suite with real margin",
 *  taken at the top of that range. Only `provisioning.test.ts` reaches it. */
export const CAP_CEILING_S = 1200;

/** Reserved out of the remaining step budget for the reap, metrics, summary and
 *  artifact upload steps that must still run after this file returns. */
export const FORENSICS_RESERVE_S = 300;

/** Below this there is no point starting a file: any cap this short would time
 *  out a healthy boot and report a wedge that never happened. */
export const MIN_VIABLE_CAP_S = 120;

/**
 * Outcome vocabulary (#77 item 4). B4 owns only what the watchdog can observe
 * first-hand; the rest of #77's list is deliberately NOT claimed here:
 * `runner-lost` and `attempted-incomplete` need the server-visible ledger (B5),
 * and `infra-download` / `infra-cache` / `operation-timeout` need output
 * classification this script does not do — it leaves stdout/stderr inherited so
 * the workflow's own `tee` keeps producing byte-identical logs.
 */
export type FileOutcome = "pass" | "test-failure" | "file-watchdog-timeout" | "not-run";

/** Process exit codes, so the workflow loop can tell "red, keep going" from
 *  "stop, the environment may be poisoned" without parsing anything. */
export const EXIT = {
	pass: 0,
	testFailure: 1,
	/** Timed out, children confirmed reaped — the next file starts clean. */
	timeoutReaped: 2,
	/** Timed out and QEMU survived the reap. Continuing would turn one root
	 *  cause into a string of misleading failures (#77 §2). */
	timeoutDirty: 3,
	/** Budget exhausted before this file could be given a viable cap. */
	notRun: 4,
} as const;

/** Cap for one file, in seconds: `clamp(observed x 2, floor, ceiling)`, rounded
 *  up to a whole minute so a checked-in cap reads as a number a human chose.
 *
 * `overrideS` is the `watchdog-cap` experiment lever. It can only make the
 * watchdog STRICTER — a value at or above the ceiling is ignored rather than
 * honored. A lever that could lengthen a cap would be a runtime-derived
 * deadline wearing a dispatch input, which is #110's rule 4; this one exists so
 * the timeout path itself can be exercised on a real runner without committing
 * a test that hangs on purpose. */
export function capSecondsFor(file: string, overrideS?: number): number {
	const observed = OBSERVED_MAX_S[basename(file)];
	const scaled =
		observed === undefined ? CAP_FLOOR_S : Math.min(Math.max(observed * CAP_MULTIPLIER, CAP_FLOOR_S), CAP_CEILING_S);
	const derived = Math.ceil(scaled / 60) * 60;
	// `>= 1`, not `> 0`: the floor below would turn `--cap 0.5` into a 0-second
	// cap, i.e. a deadline that has already expired when the file starts. A
	// nonsense lever value must fall back to the table, never disable the bound
	// or fabricate an instant timeout.
	if (overrideS !== undefined && Number.isFinite(overrideS) && overrideS >= 1) {
		return Math.min(derived, Math.floor(overrideS));
	}
	return derived;
}

export interface EffectiveCap {
	/** Seconds the file may run. Meaningless when `run` is false. */
	capS: number;
	/** Which bound produced it — the checked-in table or the enclosing step. */
	source: "file-table" | "suite-deadline";
	/** False when the remaining budget cannot fit a viable attempt. */
	run: boolean;
	/** Whole seconds left before the step must start winding down. */
	remainingS: number;
}

/**
 * The smaller of the file's own cap and what the step can still afford, holding
 * {@link FORENSICS_RESERVE_S} back so the evidence steps always run.
 *
 * `deadlineEpochS` is when the enclosing STEP will be killed by GitHub. Pass
 * undefined when unknown (a local run), and only the file table applies.
 */
export function effectiveCap(fileCapS: number, nowEpochS: number, deadlineEpochS?: number): EffectiveCap {
	if (deadlineEpochS === undefined) {
		return { capS: fileCapS, source: "file-table", run: true, remainingS: Number.POSITIVE_INFINITY };
	}
	const remainingS = Math.floor(deadlineEpochS - nowEpochS);
	const affordableS = remainingS - FORENSICS_RESERVE_S;
	// Order matters: ask whether the file's own cap fits BEFORE asking whether
	// what is left is "viable". A file capped below MIN_VIABLE_CAP_S — which the
	// watchdog-cap lever does deliberately — is not made non-viable by a budget
	// that comfortably covers it.
	if (affordableS >= fileCapS) {
		return { capS: fileCapS, source: "file-table", run: true, remainingS };
	}
	if (affordableS >= MIN_VIABLE_CAP_S) {
		return { capS: affordableS, source: "suite-deadline", run: true, remainingS };
	}
	return { capS: 0, source: "suite-deadline", run: false, remainingS };
}

/** One line of `integration-timing.txt`. The third token is the outcome; a
 *  reader that only knows the old `pass`/`fail` vocabulary still sees `pass`
 *  unchanged, which is what keeps historical ci-data comparable. */
export function timingLine(file: string, elapsedS: number, outcome: FileOutcome): string {
	return `${basename(file)} ${Math.round(elapsedS)}s ${outcome}`;
}

/** Sidecar filename read by `ci-leg-checkpoint mark` (B5). */
export const LAST_FILE_SIDECAR = "watchdog-last-file.json";

/**
 * Record the file just finished, for the leg checkpoint to post.
 *
 * A sidecar rather than a second parse of `integration-timing.txt`: the timing
 * line's format is frozen (`ci-metrics.ts` parses it, and every historical
 * `runs/*.ndjson` is built on it), so the cap cannot be added to it — and
 * re-deriving the outcome in the workflow's shell loop would give the outcome
 * vocabulary a second producer that could drift from this one.
 */
function writeLastFileSidecar(
	reportDir: string,
	file: string,
	elapsedS: number,
	outcome: FileOutcome,
	capS: number,
): void {
	try {
		writeFileSync(
			join(reportDir, LAST_FILE_SIDECAR),
			`${JSON.stringify({ file: basename(file), elapsed_s: Math.round(elapsedS), outcome, cap_s: capS })}\n`,
		);
	} catch {
		/* the checkpoint degrades to "unknown outcome"; never worth failing a file over */
	}
}

// --- runtime ------------------------------------------------------------------

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Terminate QEMU children the killed test process left behind. TCG orphans
 *  keep burning 100% CPU and starve the runner, which is one documented way a
 *  leg goes on to lose communication entirely. */
async function reapQemu(): Promise<void> {
	const run = async (cmd: string[]) => {
		try {
			const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
			await proc.exited;
		} catch {
			/* tool absent — the count below still reports the truth */
		}
	};
	if (process.platform === "win32") {
		await run(["taskkill", "/IM", "qemu-system-x86_64.exe", "/F"]);
		await run(["taskkill", "/IM", "qemu-system-aarch64.exe", "/F"]);
		return;
	}
	await run(["pkill", "-TERM", "-f", "qemu-system-(x86_64|aarch64)"]);
	await Bun.sleep(3000);
	await run(["pkill", "-KILL", "-f", "qemu-system-(x86_64|aarch64)"]);
}

async function main(): Promise<never> {
	const file = arg("--file");
	const timingPath = arg("--timing");
	if (!file || !timingPath) {
		console.error("usage: ci-file-watchdog --file <test file> --timing <file> [--report-dir <dir>] [--deadline <epoch seconds>]");
		process.exit(2);
	}
	const reportDir = arg("--report-dir") ?? process.env.HOME ?? ".";
	const deadlineRaw = arg("--deadline") ?? process.env.QUICKCHR_CI_STEP_DEADLINE_S;
	const deadlineEpochS = deadlineRaw ? Number(deadlineRaw) : undefined;
	const overrideRaw = arg("--cap") ?? process.env.QUICKCHR_CI_WATCHDOG_CAP_S;
	const overrideS = overrideRaw ? Number(overrideRaw) : undefined;
	const nowS = Date.now() / 1000;

	const fileCapS = capSecondsFor(file, overrideS);
	if (overrideS !== undefined && fileCapS !== capSecondsFor(file)) {
		console.log(`::notice::watchdog cap overridden to ${fileCapS}s by the watchdog-cap lever (table value ${capSecondsFor(file)}s)`);
	}
	const plan = effectiveCap(fileCapS, nowS, Number.isFinite(deadlineEpochS) ? deadlineEpochS : undefined);

	if (!plan.run) {
		console.error(
			`::error title=Budget exhausted::Not starting ${file} — ${plan.remainingS}s left in the step budget, which cannot fit a viable cap after the ${FORENSICS_RESERVE_S}s forensics reserve.`,
		);
		appendFileSync(timingPath, `${timingLine(file, 0, "not-run")}\n`);
		writeLastFileSidecar(reportDir, file, 0, "not-run", 0);
		process.exit(EXIT.notRun);
	}

	const capNote = plan.source === "suite-deadline" ? ` (shortened from ${fileCapS}s by the step deadline)` : "";
	console.log(`::notice::watchdog cap for ${basename(file)}: ${plan.capS}s${capNote}`);

	const started = Date.now();
	const proc = Bun.spawn(["bun", "test", `./${file.replace(/^\.\//, "")}`], {
		env: { ...process.env, QUICKCHR_INTEGRATION: "1" },
		stdout: "inherit",
		stderr: "inherit",
	});

	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill("SIGTERM");
		// SIGTERM first so bun can run its own teardown; a test blocked on a
		// wedged QEMU will not take it, hence the unconditional follow-up.
		setTimeout(() => proc.kill("SIGKILL"), 5000);
	}, plan.capS * 1000);

	const code = await proc.exited;
	clearTimeout(timer);
	const elapsedS = (Date.now() - started) / 1000;

	if (!timedOut) {
		const outcome: FileOutcome = code === 0 ? "pass" : "test-failure";
		appendFileSync(timingPath, `${timingLine(file, elapsedS, outcome)}\n`);
		writeLastFileSidecar(reportDir, file, elapsedS, outcome, plan.capS);
		process.exit(code === 0 ? EXIT.pass : EXIT.testFailure);
	}

	// --- expiry path: reap, verify, capture, then report -------------------------
	const beforeReap = await qemuProcessCount();
	await reapQemu();
	const afterReap = await qemuProcessCount();
	const cleanupVerified = afterReap === 0;

	const report = {
		kind: "file-watchdog-timeout",
		ts: new Date().toISOString(),
		run_id: process.env.GITHUB_RUN_ID ?? "local",
		sha: process.env.GITHUB_SHA ?? "",
		platform: process.env.PLATFORM_ID ?? "unknown",
		target: process.env.QUICKCHR_TEST_TARGET || "stable",
		file: basename(file),
		elapsed_s: Math.round(elapsedS),
		cap_s: plan.capS,
		cap_source: plan.source,
		qemu_before_reap: beforeReap,
		qemu_after_reap: afterReap,
		cleanup_verified: cleanupVerified,
		host: await hostSnapshot(),
	};
	const reportPath = join(reportDir, `watchdog-${basename(file)}.json`);
	await Bun.write(reportPath, `${JSON.stringify(report, null, "\t")}\n`);

	appendFileSync(timingPath, `${timingLine(file, elapsedS, "file-watchdog-timeout")}\n`);
	writeLastFileSidecar(reportDir, file, elapsedS, "file-watchdog-timeout", plan.capS);
	console.error(
		`::error title=File watchdog::${basename(file)} exceeded its ${plan.capS}s cap (${Math.round(elapsedS)}s elapsed, cap from ${plan.source}). QEMU processes ${beforeReap ?? "?"} before reap, ${afterReap ?? "?"} after. Report: ${reportPath}`,
	);
	if (!cleanupVerified) {
		console.error(
			`::error title=Cleanup unverified::QEMU processes survived the reap (${afterReap ?? "unknown"}). Stopping the file loop rather than running the remaining files in a possibly poisoned environment (#77).`,
		);
	}
	process.exit(cleanupVerified ? EXIT.timeoutReaped : EXIT.timeoutDirty);
}

if (import.meta.main) {
	if (!existsSync("package.json")) {
		console.error("ci-file-watchdog: run from the repository root");
		process.exit(2);
	}
	await main();
}
