#!/usr/bin/env bun
/**
 * ci-leg-ledger — compare the legs a run PLANNED against the legs that left a
 * record, and give the difference a name (issue #77, B5 of #110).
 *
 *   bun scripts/ci-leg-ledger.ts build --data <ci-data-dir> \
 *     --artifacts <dir> --matrix <plan matrix json file>
 *
 * WHY THIS EXISTS. "Attempted and incomplete" had no representation anywhere.
 * The 2026-07-31 sweep planned 15 integration legs and `ci-data` received 12
 * ndjson files; the three `macos-x86` legs whose runners vanished left no
 * marker of any kind, and nothing downstream could tell "never attempted" from
 * "attempted and died". A reader comparing platforms saw silence and had to
 * guess. This makes the silence explicit.
 *
 * ── Why NOT tested-versions.json (maintainer decision, 2026-08-02) ──────────
 * That file means one thing today — completed full-suite results — and the
 * version scheduler reads it as a PRESENCE test:
 *
 *   # .github/workflows/ros-versions.yml:99
 *   state=$(jq -r --arg v "$ver" '.[$v]["linux-x86"].conclusion // "untested"' …)
 *   if [ "$state" = "untested" ]; then   # …otherwise: already has a record
 *
 * Writing `incomplete` into `conclusion` would make an aborted run look tested
 * and silently stop rescheduling that version — forever, with no error. Today's
 * `macos-x86` case would not trip it (the scheduler only reads `linux-x86`), but
 * the contract is one platform away from breaking. So this ledger is a separate
 * file, `attempted-legs.json`, and `tested-versions.json` plus that jq are
 * deliberately untouched. `foldTestedVersions`'s `scope:"full"` rule stays as
 * it is; it is what keeps a filtered run from ever marking a version tested.
 *
 * ── The artifact is the primary evidence, not the check run ─────────────────
 * A leg is `complete` because it produced a metrics record — never because its
 * check run says so. The checkpoint instrument posts best-effort and exits 0 on
 * any API failure (see `ci-leg-checkpoint.ts`), so trusting it first would let a
 * dropped PATCH invent a `runner-lost` for a leg that finished cleanly. The
 * check run and the jobs API are consulted ONLY to explain legs that produced
 * no record.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { legKey, parseExternalId, parsePayload, type CheckpointRecord } from "./ci-leg-checkpoint.ts";

/** One entry of the plan job's matrix (`needs.plan.outputs.matrix`). */
export interface PlannedLeg {
	id: string;
	label: string;
	target: string;
	resolved?: string;
}

/** A check run of ours, reduced to what classification needs. */
export interface CheckpointView {
	status: string;
	payload?: {
		planned?: string[];
		records?: CheckpointRecord[];
		current?: string | null;
		startedAt?: string;
	};
	checkRunId?: number;
}

/** A workflow job, reduced. Survives runner loss — verified against run
 *  30665449265, where the three vanished legs still recorded their test step as
 *  `in_progress` with a start time and every later step as `pending`. */
export interface JobView {
	name: string;
	status: string;
	conclusion: string | null;
	started_at: string | null;
	completed_at: string | null;
	steps?: Array<{ name: string; status: string; conclusion: string | null; started_at: string | null }>;
}

/**
 * What happened to a planned leg.
 *
 * `not-started` is not in #77's original vocabulary and is deliberately added:
 * without it, a leg that died in `Install QEMU` — no artifact, no checkpoint —
 * would be indistinguishable from one whose runner vanished mid-suite, and
 * mislabelling a setup failure as `runner-lost` would send #76 chasing a
 * mechanism that was never involved.
 */
export type LegTerminal = "complete" | "runner-lost" | "attempted-incomplete" | "not-started";

export interface LegLedgerEntry {
	platform: string;
	target: string;
	resolved?: string;
	terminal: LegTerminal;
	/** Last file the leg reported finishing. The answer #76 has never had. */
	last_file?: string;
	/** File it was inside when the record stops — `planned[reported]`. */
	current_file?: string;
	files_reported?: number;
	files_planned?: number;
	last_checkpoint_ts?: string;
	/** Step left non-terminal in the jobs API — coarse, free, and survives. */
	stalled_step?: string;
	job_conclusion?: string;
	/** Seconds from job start to when the SERVICE gave up. An upper bound on the
	 *  wedge, not the wedge: the interval between a runner going quiet and that
	 *  verdict is uncharacterized (#76). */
	job_elapsed_s?: number;
	/** False when no job could be matched by name — classification then rests on
	 *  the check run alone, and says so rather than pretending to corroboration. */
	job_matched: boolean;
	why: string;
}

export interface RunLedger {
	ts: string;
	sha: string;
	attempt: string;
	event: string;
	planned: number;
	complete: number;
	incomplete?: Record<string, LegLedgerEntry>;
}

/**
 * The integration job's display name. Matching a job to a matrix leg has to go
 * through this string — the jobs API exposes no matrix values — so the template
 * lives in ONE place and `integration.yml` carries a pointer to it. A rename
 * then breaks the unit test rather than silently degrading every ledger entry
 * to `job_matched: false`.
 */
export function integrationJobName(label: string, target: string): string {
	return `Integration (${label} · ${target})`;
}

/** The step whose non-terminal state means "died running the suite". Same
 *  contract as {@link integrationJobName}: one home, asserted by a unit test. */
export const TEST_STEP_NAME = "Run integration tests (sequential per-file)";

/**
 * Classify one planned leg. Pure — the whole point of the seam, since the
 * interesting inputs (a vanished runner) cannot be produced locally.
 */
export function classifyLeg(
	leg: PlannedLeg,
	completed: ReadonlySet<string>,
	checkpoints: ReadonlyMap<string, CheckpointView>,
	jobs: ReadonlyMap<string, JobView>,
): LegLedgerEntry {
	const key = legKey(leg.id, leg.target);
	const cp = checkpoints.get(key);
	const job = jobs.get(key);
	const records = cp?.payload?.records ?? [];
	const planned = cp?.payload?.planned ?? [];

	const entry: LegLedgerEntry = {
		platform: leg.id,
		target: leg.target,
		resolved: leg.resolved,
		terminal: "not-started",
		job_matched: job !== undefined,
		why: "",
	};

	if (cp) {
		entry.files_reported = records.length;
		entry.files_planned = planned.length;
		entry.last_file = records[records.length - 1]?.file;
		entry.last_checkpoint_ts = records[records.length - 1]?.ts;
		entry.current_file = cp.payload?.current ?? undefined;
	}
	if (job) {
		entry.job_conclusion = job.conclusion ?? undefined;
		if (job.started_at && job.completed_at) {
			entry.job_elapsed_s = Math.round(
				(Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1000,
			);
		}
		const stalled = job.steps?.find((s) => s.status !== "completed" && s.started_at);
		if (stalled) entry.stalled_step = stalled.name;
	}

	// 1. The artifact is the evidence. A leg that produced a metrics record ran
	//    its suite to the end, whatever the instruments say about it.
	if (completed.has(key)) {
		entry.terminal = "complete";
		entry.why = "a metrics record reached ci-data";
		return entry;
	}

	// 2. A step left running while the job is over means the runner stopped
	//    talking mid-step — nothing in-job could have reported it.
	if (job && job.status === "completed" && entry.stalled_step) {
		entry.terminal = "runner-lost";
		entry.why = `job reached a terminal state with '${entry.stalled_step}' still in progress — the runner stopped reporting`;
		return entry;
	}

	// 3. Same conclusion from the other instrument, for when the job could not be
	//    matched by name.
	if (cp?.status === "in_progress") {
		entry.terminal = "runner-lost";
		entry.why = "the leg's checkpoint check run was never closed";
		return entry;
	}

	// 4. The leg got far enough to instrument itself and then ended without
	//    leaving a record — a real but different failure from runner loss
	//    (upload failed, assemble step skipped, job cancelled mid-flight).
	if (cp) {
		entry.terminal = "attempted-incomplete";
		entry.why = "the leg checkpointed and closed, but no metrics record reached ci-data";
		return entry;
	}
	if (job) {
		entry.terminal = "attempted-incomplete";
		entry.why = `job ended '${job.conclusion ?? job.status}' before the suite could instrument itself`;
		return entry;
	}

	// 5. Nothing at all. Cancelled in the queue, or the matrix leg never spawned.
	entry.why = "no job, no checkpoint — the leg never started";
	return entry;
}

/** Build the whole run's ledger. Legs that completed are counted, not listed —
 *  `runs/*.ndjson` already holds them in full, and repeating every green leg
 *  here would grow the file without adding a fact. */
export function buildRunLedger(
	planned: readonly PlannedLeg[],
	completed: ReadonlySet<string>,
	checkpoints: ReadonlyMap<string, CheckpointView>,
	jobs: ReadonlyMap<string, JobView>,
	meta: { ts: string; sha: string; attempt: string; event: string },
): RunLedger {
	const incomplete: Record<string, LegLedgerEntry> = {};
	let complete = 0;
	for (const leg of planned) {
		const entry = classifyLeg(leg, completed, checkpoints, jobs);
		if (entry.terminal === "complete") complete += 1;
		else incomplete[legKey(leg.id, leg.target)] = entry;
	}
	const ledger: RunLedger = { ...meta, planned: planned.length, complete };
	if (Object.keys(incomplete).length > 0) ledger.incomplete = incomplete;
	return ledger;
}

/** Deep-sort so the committed JSON is byte-stable for equal data. */
export function sortKeysDeep<T>(value: T): T {
	if (Array.isArray(value)) return value.map(sortKeysDeep) as T;
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(value as object).sort()) out[k] = sortKeysDeep((value as Record<string, unknown>)[k]);
		return out as T;
	}
	return value;
}

// --- runtime ------------------------------------------------------------------

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

async function ghJson<T>(path: string): Promise<T | undefined> {
	const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
	const repo = process.env.GITHUB_REPOSITORY;
	if (!token || !repo) return undefined;
	const base = process.env.GITHUB_API_URL ?? "https://api.github.com";
	try {
		const res = await fetch(`${base}/repos/${repo}${path}`, {
			headers: {
				authorization: `Bearer ${token}`,
				accept: "application/vnd.github+json",
				"x-github-api-version": "2022-11-28",
			},
			signal: AbortSignal.timeout(30_000),
		});
		if (!res.ok) {
			console.log(`::warning title=ci-data ledger::GET ${path} → HTTP ${res.status}`);
			return undefined;
		}
		return (await res.json()) as T;
	} catch (err) {
		console.log(`::warning title=ci-data ledger::GET ${path} failed: ${err instanceof Error ? err.message : err}`);
		return undefined;
	}
}

/** Our check runs for this SHA, keyed by leg.
 *
 *  `filter=all` is mandatory: the API defaults to `latest`, which returns only
 *  the most recent check run per NAME. A sweep dispatches `platforms=all`
 *  against `main` repeatedly, so the same SHA accumulates a
 *  `leg: macos-x86 · stable` from every one of them — the default would hand
 *  this run its successor's check run. `external_id` carries the run id, and anything that
 *  does not parse as ours is skipped. */
async function fetchCheckpoints(sha: string, runId: string, attempt: string): Promise<Map<string, CheckpointView>> {
	const out = new Map<string, CheckpointView>();
	for (let page = 1; page <= 10; page += 1) {
		const body = await ghJson<{ total_count: number; check_runs: Array<Record<string, unknown>> }>(
			`/commits/${sha}/check-runs?filter=all&per_page=100&page=${page}`,
		);
		const runs = body?.check_runs ?? [];
		for (const cr of runs) {
			const ext = parseExternalId(cr.external_id as string | null);
			if (!ext || ext.run_id !== runId || ext.attempt !== attempt) continue;
			out.set(legKey(ext.platform, ext.target), {
				status: String(cr.status),
				checkRunId: cr.id as number,
				payload: parsePayload((cr.output as { text?: string } | undefined)?.text),
			});
		}
		if (runs.length < 100) break;
	}
	return out;
}

/** This run's jobs, keyed by leg via {@link integrationJobName}. */
async function fetchJobs(runId: string, attempt: string, planned: readonly PlannedLeg[]): Promise<Map<string, JobView>> {
	const byName = new Map<string, JobView>();
	for (let page = 1; page <= 10; page += 1) {
		const body = await ghJson<{ jobs: JobView[] }>(
			`/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`,
		);
		const jobs = body?.jobs ?? [];
		for (const j of jobs) byName.set(j.name, j);
		if (jobs.length < 100) break;
	}
	const out = new Map<string, JobView>();
	for (const leg of planned) {
		const job = byName.get(integrationJobName(leg.label, leg.target));
		if (job) out.set(legKey(leg.id, leg.target), job);
	}
	return out;
}

/** Leg keys that reached ci-data this run — read from the freshly written
 *  `runs/<run_id>-<platform>-<target>.ndjson` files, which is exactly the set
 *  `ci-metrics aggregate` just produced. */
export function completedLegs(dataDir: string, runId: string): Set<string> {
	const runsDir = join(dataDir, "runs");
	const out = new Set<string>();
	if (!existsSync(runsDir)) return out;
	for (const name of readdirSync(runsDir)) {
		if (!name.startsWith(`${runId}-`) || !name.endsWith(".ndjson")) continue;
		const file = join(runsDir, name);
		if (!statSync(file).isFile()) continue;
		// The suite record carries platform and target verbatim — safer than
		// splitting the filename, whose platform ids contain no separator today
		// but are not guaranteed to stay that way.
		for (const line of readFileSync(file, "utf-8").split("\n")) {
			if (!line) continue;
			const rec = JSON.parse(line) as { kind?: string; platform?: string; target?: string };
			if (rec.kind === "suite" && rec.platform && rec.target) out.add(legKey(rec.platform, rec.target));
		}
	}
	return out;
}

/** Close a check run the runner never got to close, so the commit does not
 *  carry a check that claims to still be running weeks later. */
async function finalizeLostCheckRuns(ledger: RunLedger, checkpoints: ReadonlyMap<string, CheckpointView>): Promise<void> {
	const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
	const repo = process.env.GITHUB_REPOSITORY;
	if (!token || !repo) return;
	const base = process.env.GITHUB_API_URL ?? "https://api.github.com";
	for (const [key, entry] of Object.entries(ledger.incomplete ?? {})) {
		const cp = checkpoints.get(key);
		if (!cp?.checkRunId || cp.status === "completed") continue;
		try {
			await fetch(`${base}/repos/${repo}/check-runs/${cp.checkRunId}`, {
				method: "PATCH",
				headers: {
					authorization: `Bearer ${token}`,
					accept: "application/vnd.github+json",
					"x-github-api-version": "2022-11-28",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					status: "completed",
					conclusion: "failure",
					completed_at: new Date().toISOString(),
					output: {
						title: `${entry.terminal} — last file ${entry.last_file ?? "(none reported)"}`,
						summary: [
							`**${entry.terminal}** · ${entry.why}`,
							"",
							`- last completed file: \`${entry.last_file ?? "—"}\``,
							`- was running: \`${entry.current_file ?? "—"}\``,
							`- files reported: ${entry.files_reported ?? 0}/${entry.files_planned ?? "?"}`,
							`- stalled step: ${entry.stalled_step ?? "—"}`,
							`- job elapsed: ${entry.job_elapsed_s ?? "?"}s (upper bound on the wedge — see #76)`,
							"",
							"Closed by the aggregate job; the leg's own runner never reported a terminal.",
						].join("\n"),
					},
				}),
				signal: AbortSignal.timeout(30_000),
			});
		} catch (err) {
			console.log(`::warning title=ci-data ledger::could not finalize check run for ${key}: ${err}`);
		}
	}
}

async function build(): Promise<void> {
	const dataDir = arg("--data");
	const matrixPath = arg("--matrix");
	if (!dataDir || !matrixPath) {
		console.error("usage: ci-leg-ledger build --data <ci-data-dir> --matrix <matrix json file>");
		process.exit(2);
	}
	const runId = process.env.GITHUB_RUN_ID ?? "local";
	const attempt = process.env.GITHUB_RUN_ATTEMPT ?? "1";
	const sha = process.env.GITHUB_SHA ?? "";

	const raw = JSON.parse(readFileSync(matrixPath, "utf-8")) as { include?: PlannedLeg[] } | PlannedLeg[];
	const planned = Array.isArray(raw) ? raw : (raw.include ?? []);
	if (planned.length === 0) {
		console.log("::warning title=ci-data ledger::empty plan matrix — nothing to reconcile");
		return;
	}

	const completed = completedLegs(dataDir, runId);
	const checkpoints = await fetchCheckpoints(sha, runId, attempt);
	const jobs = await fetchJobs(runId, attempt, planned);

	const ledger = buildRunLedger(planned, completed, checkpoints, jobs, {
		ts: new Date().toISOString(),
		sha,
		attempt,
		event: process.env.GITHUB_EVENT_NAME ?? "unknown",
	});

	const path = join(dataDir, "attempted-legs.json");
	const all = existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as Record<string, RunLedger>) : {};
	all[runId] = ledger;
	writeFileSync(path, `${JSON.stringify(sortKeysDeep(all), null, "\t")}\n`);

	console.log(`ci-leg-ledger: ${ledger.complete}/${ledger.planned} legs complete`);
	for (const [key, entry] of Object.entries(ledger.incomplete ?? {})) {
		// A notice, not a warning: the leg's own job is already red, and the
		// aggregate is best-effort by contract. This annotation exists to put the
		// name on the run summary where a human will see it.
		console.log(
			`::notice title=Incomplete leg::${key} — ${entry.terminal}: ${entry.why}. Last file: ${entry.last_file ?? "(none reported)"}; was running ${entry.current_file ?? "(unknown)"}.`,
		);
	}

	const summary = process.env.GITHUB_STEP_SUMMARY;
	if (summary && ledger.incomplete) {
		const lines = [
			"",
			`### Incomplete legs — ${ledger.complete}/${ledger.planned} completed`,
			"",
			"| platform | target | terminal | last file | was running | files | stalled step | job elapsed |",
			"|----------|--------|----------|-----------|-------------|-------|--------------|-------------|",
			// Platform and target get their own cells rather than the `|`-joined
			// leg key: escaping that separator back out of a markdown table is the
			// kind of partial encoding that is wrong the moment a value contains a
			// backslash, and the split table reads better anyway.
			...Object.values(ledger.incomplete).map(
				(e) =>
					`| \`${e.platform}\` | \`${e.target}\` | **${e.terminal}** | \`${e.last_file ?? "—"}\` | \`${e.current_file ?? "—"}\` | ${e.files_reported ?? 0}/${e.files_planned ?? "?"} | ${e.stalled_step ?? "—"} | ${e.job_elapsed_s ?? "?"}s |`,
			),
		];
		writeFileSync(summary, `${readFileSync(summary, "utf-8")}${lines.join("\n")}\n`);
	}

	await finalizeLostCheckRuns(ledger, checkpoints);
}

if (import.meta.main) {
	if (process.argv[2] === "build") await build();
	else {
		console.error("usage: ci-leg-ledger build …");
		process.exit(2);
	}
}
