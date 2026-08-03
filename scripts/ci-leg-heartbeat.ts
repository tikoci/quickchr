#!/usr/bin/env bun
/**
 * ci-leg-heartbeat — periodic host sampling from *inside* a test file, on a
 * channel that survives losing the runner (B8d of #110, for #76).
 *
 *   bun scripts/ci-leg-heartbeat.ts --interval 30 --deadline <epoch> \
 *       --state "$HOME/leg-checkpoint.json" \
 *       --stop-file "$HOME/heartbeat.stop" \
 *       --out "$HOME/heartbeat-samples.ndjson"
 *
 * WHY THIS EXISTS. B5's checkpoint marks a **file boundary**: it fires once, as
 * a file ends. That was enough to name #76's wedge — all four known legs die in
 * `provisioning.test.ts` — and it is structurally unable to describe it, because
 * the freeze happens 3.5-7.6 min *inside* that file (B8b, from the maintainer's
 * live log capture; the runner destroys the log, so that capture is the only
 * copy). Free disk, free memory, load and `qemuCount` have therefore never been
 * read anywhere in the window the leg actually dies in. B8a's reassuring
 * "111 GB free, qemuCount 0" is a boundary reading from a leg that never reached
 * position 10. The disk-space and memory hypotheses are open because nothing has
 * ever looked, not because anything has cleared them.
 *
 * ── Why its own check run, and not B5's ─────────────────────────────────────
 * The obvious implementation extends the checkpoint: same state, same check run,
 * extra rows. It is the wrong one. `mark` and a heartbeat would both be
 * read-modify-write writers of one payload, and the interleaving that costs
 * nothing anywhere else — heartbeat reads state, `mark` writes a record and
 * PATCHes, heartbeat PATCHes its stale copy — drops the newest file record from
 * the server-side output. The window is a second wide and self-heals on the next
 * tick, except in the one case this whole program is about: the runner dying
 * inside it. That trade is not worth taking to save a check run, so the
 * heartbeat owns a separate one and never writes B5's state.
 *
 * The `external_id` carries a fifth segment (`…/hb`). `parseExternalId` requires
 * exactly four, so `ci-leg-ledger` skips these without needing to know they
 * exist — no `runner-lost` can ever be fabricated from a heartbeat. That is
 * asserted in `test/unit/ci-leg-heartbeat.test.ts`, not left to the reader.
 *
 * ── Why it is opt-in ────────────────────────────────────────────────────────
 * `GITHUB_TOKEN` is rate-limited to 1000 requests/hour/repository. A 30 s post
 * interval is 120 PATCH/hour *per leg*: fine for the 1-3 leg dispatches that
 * chase #76 (the diagnostic boundary is ~16-20 min), and ~1800/hour across a
 * 15-leg sweep of 300-minute legs — which would throttle B5's own checkpoint
 * writes and the aggregate's reads, i.e. break the durable record to feed a
 * diagnostic. So `heartbeat-interval` is an experiment lever, empty = off, and
 * always-on stays a decision to make from measured cost rather than by default.
 *
 * ── This instrument must never turn a green leg red ─────────────────────────
 * Same contract as `ci-leg-checkpoint.ts`: every API failure is a loud
 * `::warning::` and exit 0, and the workflow runs this as a background job and
 * ignores its status. It also self-terminates at the step deadline, so a leg
 * whose test step is killed cannot leave a sampler running into the next steps.
 */
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { getDataDir } from "../src/lib/state.ts";
import { hostSnapshot, type HostSnapshot } from "./ci-host-snapshot.ts";
import { type CheckpointState, type LegIdentity } from "./ci-leg-checkpoint.ts";

/** One periodic reading, attributed to wherever the leg was at the time. */
export interface HeartbeatSample {
	ts: string;
	/** Seconds since the heartbeat started — the leg's own clock. */
	elapsed_s: number;
	/** File the leg is inside, per B5's checkpoint state. `null` before the first. */
	file: string | null;
	/** 1-based position of `file` in the planned list — position 10 is #76's. */
	fileIndex: number | null;
	/** Seconds since that file started, i.e. how deep into it this reading is. */
	inFile_s: number | null;
	host: HostSnapshot;
}

export interface HeartbeatState {
	checkRunId?: number;
	leg: LegIdentity;
	startedAt: string;
	intervalS: number;
	samples: HeartbeatSample[];
	/** Posts that failed, cumulative. A gap in the series is a fact about the
	 *  instrument, and the reader needs to be able to tell it from a gap in the
	 *  leg. */
	postFailures: number;
}

/**
 * How many samples the payload keeps.
 *
 * The window is trailing on purpose: what matters for a wedge is the state
 * approaching the freeze, and the oldest samples are the ones a completed run
 * already explains. 120 × 30 s is 60 minutes — 3x the 16-20 min at which every
 * known #76 leg dies, and it renders to ~39 KB against the 60 KB budget below,
 * so adding a `HostSnapshot` field does not immediately start silently
 * shortening the window.
 */
export const MAX_SAMPLES = 120;

/**
 * Byte budget for `output.text`.
 *
 * The checks API rejects an output over 65535 characters, and this instrument
 * treats a rejection as a warning and carries on — so an over-long payload would
 * not fail loudly, it would silently stop updating and leave the wedge
 * unsampled. `MAX_SAMPLES` alone does not bound this (a sample grows whenever a
 * field is added to `HostSnapshot`), so the trim is enforced against the
 * rendered bytes as well.
 */
export const MAX_TEXT_BYTES = 60_000;

const PAYLOAD_OPEN = "<!--quickchr-heartbeat";
const PAYLOAD_CLOSE = "-->";

/** `…/hb` fifth segment: `parseExternalId` takes exactly four, so B5's reader
 *  skips heartbeats without a special case. See the header. */
export function heartbeatExternalId(leg: LegIdentity): string {
	return `${leg.run_id}/${leg.attempt}/${leg.platform}/${leg.target}/hb`;
}

function fmt(n: number | undefined, suffix = ""): string {
	return n === undefined ? "—" : `${n}${suffix}`;
}

/** Render the heartbeat's check-run output. Pure, so the payload contract and
 *  the size bound are both testable without touching the API. */
export function renderOutput(state: HeartbeatState): { title: string; summary: string; text: string } {
	// Trim to the sample cap first, then to the byte budget — the second loop is
	// the one that holds when a field is added to HostSnapshot later.
	let samples = state.samples.slice(-MAX_SAMPLES);
	let text = "";
	for (;;) {
		const payload = {
			leg: state.leg,
			startedAt: state.startedAt,
			intervalS: state.intervalS,
			postFailures: state.postFailures,
			truncatedFrom: state.samples.length > samples.length ? state.samples.length : undefined,
			samples,
		};
		text = `${PAYLOAD_OPEN}\n${JSON.stringify(payload)}\n${PAYLOAD_CLOSE}`;
		if (Buffer.byteLength(text, "utf8") <= MAX_TEXT_BYTES || samples.length <= 1) break;
		samples = samples.slice(Math.ceil(samples.length / 10));
	}

	const last = samples[samples.length - 1];
	const title = last
		? `${samples.length} samples — ${last.file ?? "no file yet"} @ ${last.elapsed_s}s`
		: "no samples yet";

	// Humans read the tail; the machine record above holds the whole window.
	const rows = samples.slice(-25).map((s) => {
		const h = s.host;
		return `| ${s.elapsed_s}s | ${s.file ? `\`${s.file}\`${s.fileIndex ? ` (${s.fileIndex})` : ""}` : "—"} | ${
			s.inFile_s === null ? "—" : `${s.inFile_s}s`
		} | ${fmt(h.freeMemMiB)} | ${fmt(h.memFreePct, "%")} | ${fmt(h.swapUsedMiB)} | ${fmt(h.freeDiskMiB)} | ${fmt(
			h.freeDataDiskMiB,
		)} | ${h.loadAvg?.[0]?.toFixed(2) ?? "—"} | ${fmt(h.qemuCount)} |`;
	});

	const summary = [
		`**${state.leg.platform} · ${state.leg.target}**${state.leg.resolved ? ` (${state.leg.resolved})` : ""} — in-file heartbeat (B8d of #110)`,
		`accel \`${state.leg.accel ?? "?"}\` · run ${state.leg.run_id} attempt ${state.leg.attempt} · every ${state.intervalS}s · started ${state.startedAt}`,
		"",
		"**If this check never completes, the last row below is the last thing the host said.**",
		state.postFailures > 0 ? `\n⚠️ ${state.postFailures} post(s) failed — a gap in the series may be this instrument, not the leg.\n` : "",
		"",
		"| elapsed | file | in-file | free mem MiB | mem free % | swap MiB | free disk MiB | free data-disk MiB | load | qemu |",
		"|---|---|---|---|---|---|---|---|---|---|",
		...rows,
		"",
		samples.length > rows.length ? `_(showing the last ${rows.length} of ${samples.length} retained samples; the full window is in this check's payload)_` : "",
	].join("\n");

	return { title, summary, text };
}

/** Read the machine-readable block back out. Never throws — it runs over check
 *  runs written by who knows what. */
export function parsePayload(text: string | null | undefined):
	| {
			leg: LegIdentity;
			startedAt: string;
			intervalS: number;
			postFailures: number;
			truncatedFrom?: number;
			samples: HeartbeatSample[];
	  }
	| undefined {
	if (!text) return undefined;
	const start = text.indexOf(PAYLOAD_OPEN);
	if (start < 0) return undefined;
	const end = text.indexOf(PAYLOAD_CLOSE, start);
	if (end < 0) return undefined;
	try {
		return JSON.parse(text.slice(start + PAYLOAD_OPEN.length, end).trim());
	} catch {
		return undefined;
	}
}

/**
 * Where the leg is, from B5's checkpoint state.
 *
 * Read-only by contract — the heartbeat never writes this file. A file that is
 * missing, half-written or malformed yields `undefined` and the caller keeps its
 * previous answer, so a torn read costs one sample's attribution rather than
 * the sample.
 */
export function locate(
	state: CheckpointState | undefined,
	now: number,
): { file: string | null; fileIndex: number | null; startedAtMs: number | null } | undefined {
	if (!state) return undefined;
	const done = state.records.length;
	const file = done < state.planned.length ? (state.planned[done] ?? null) : null;
	// The current file began when the previous one was marked; before the first
	// mark, when the leg opened its checkpoint.
	const priorTs = done > 0 ? state.records[done - 1]?.ts : state.startedAt;
	const startedAtMs = priorTs ? Date.parse(priorTs) : Number.NaN;
	return {
		file: file ? basename(file) : null,
		fileIndex: file ? done + 1 : null,
		startedAtMs: Number.isFinite(startedAtMs) && startedAtMs <= now ? startedAtMs : null,
	};
}

// --- runtime ------------------------------------------------------------------

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

function warn(message: string): void {
	console.log(`::warning title=Leg heartbeat::${message}`);
}

async function api(path: string, method: "POST" | "PATCH", body: unknown): Promise<{ id?: number } | undefined> {
	const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
	const repo = process.env.GITHUB_REPOSITORY;
	if (!token || !repo) {
		warn(`no GITHUB_TOKEN/GITHUB_REPOSITORY — heartbeat not posted (${method} ${path})`);
		return undefined;
	}
	const base = process.env.GITHUB_API_URL ?? "https://api.github.com";
	try {
		const res = await fetch(`${base}/repos/${repo}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${token}`,
				accept: "application/vnd.github+json",
				"x-github-api-version": "2022-11-28",
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(30_000),
		});
		if (!res.ok) {
			warn(`${method} ${path} → HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
			return undefined;
		}
		return (await res.json()) as { id?: number };
	} catch (err) {
		warn(`${method} ${path} failed: ${err instanceof Error ? err.message : String(err)}`);
		return undefined;
	}
}

function identity(): LegIdentity {
	return {
		platform: process.env.PLATFORM_ID ?? "unknown",
		target: process.env.QUICKCHR_TEST_TARGET || "stable",
		resolved: process.env.QUICKCHR_RESOLVED_VERSION || undefined,
		accel: process.env.QUICKCHR_DETECTED_ACCEL || undefined,
		sha: process.env.GITHUB_SHA ?? "",
		run_id: process.env.GITHUB_RUN_ID ?? "local",
		attempt: process.env.GITHUB_RUN_ATTEMPT ?? "1",
	};
}

function readCheckpoint(path: string): CheckpointState | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as CheckpointState;
	} catch {
		return undefined;
	}
}

/** Sleep in slices so a stop file is noticed promptly rather than one interval late. */
async function sleepUntil(target: number, stopFile: string): Promise<void> {
	while (Date.now() < target) {
		if (existsSync(stopFile)) return;
		await Bun.sleep(Math.min(1000, target - Date.now()));
	}
}

async function main(): Promise<void> {
	const intervalS = Math.max(10, Number(arg("--interval") ?? 30));
	const statePath = arg("--state") ?? join(process.env.HOME ?? ".", "leg-checkpoint.json");
	const stopFile = arg("--stop-file") ?? join(process.env.HOME ?? ".", "heartbeat.stop");
	const outPath = arg("--out");
	// A deadline is mandatory in spirit: this process outlives the shell that
	// started it as a background job, so something has to end it. Default to six hours, above
	// the longest step budget (300 min) and far below "forever".
	const deadline = Number(arg("--deadline") ?? 0) * 1000 || Date.now() + 6 * 3600_000;
	const dataDir = getDataDir();

	const leg = identity();
	const state: HeartbeatState = {
		leg,
		startedAt: new Date().toISOString(),
		intervalS,
		samples: [],
		postFailures: 0,
	};

	const created = await api("/check-runs", "POST", {
		name: `hb: ${leg.platform} · ${leg.target}`,
		head_sha: leg.sha,
		status: "in_progress",
		started_at: state.startedAt,
		external_id: heartbeatExternalId(leg),
		details_url: `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${process.env.GITHUB_REPOSITORY ?? ""}/actions/runs/${leg.run_id}`,
		output: renderOutput(state),
	});
	if (created?.id) {
		state.checkRunId = created.id;
		console.log(`::notice::leg heartbeat open — check run ${created.id}, every ${intervalS}s until deadline`);
	} else {
		warn("could not open the heartbeat check run — sampling to the local file only");
	}

	// Truncate rather than append to whatever a previous process left — the file
	// is appended to per tick below, and a stale prefix would date-stamp another
	// leg's samples into this one's record.
	if (outPath) rmSync(outPath, { force: true });

	const startMs = Date.parse(state.startedAt);
	let lastLocation: ReturnType<typeof locate>;
	// Backoff exists for one failure mode: the token's hourly budget running out.
	// Hammering it at the configured interval after that would extend the outage
	// across the leg's OWN checkpoint writes, which matter more than this does.
	let backoffS = intervalS;

	while (Date.now() < deadline && !existsSync(stopFile)) {
		const now = Date.now();
		const located = locate(readCheckpoint(statePath), now) ?? lastLocation;
		if (located) lastLocation = located;
		const sample: HeartbeatSample = {
			ts: new Date(now).toISOString(),
			elapsed_s: Math.round((now - startMs) / 1000),
			file: located?.file ?? null,
			fileIndex: located?.fileIndex ?? null,
			inFile_s: located?.startedAtMs ? Math.round((now - located.startedAtMs) / 1000) : null,
			host: await hostSnapshot(true, dataDir),
		};
		state.samples.push(sample);
		// The local copy dies with the runner — that is the whole reason the check
		// run exists — but it is the readable one for a leg that finishes, and it
		// keeps every sample rather than the trailing window.
		//
		// APPEND, never rewrite. Re-encoding the whole array each tick is O(n²)
		// over a leg, and a sampler whose own cost grows with elapsed time would
		// perturb exactly the late-in-the-leg window this instrument exists to
		// measure — it would look like accumulation it caused itself.
		if (outPath) appendFileSync(outPath, `${JSON.stringify(sample)}\n`);

		if (state.checkRunId) {
			const ok = await api(`/check-runs/${state.checkRunId}`, "PATCH", { output: renderOutput(state) });
			if (ok) {
				backoffS = intervalS;
			} else {
				state.postFailures += 1;
				backoffS = Math.min(300, backoffS * 2);
			}
		}
		await sleepUntil(Date.now() + backoffS * 1000, stopFile);
	}

	// Reached only by a runner that is still alive. A heartbeat left `in_progress`
	// is the signal, exactly as B5's checkpoint is.
	if (state.checkRunId) {
		await api(`/check-runs/${state.checkRunId}`, "PATCH", {
			status: "completed",
			// Never `failure`: this check carries no verdict about the suite, and a
			// second red check on the commit would double-count one failure.
			conclusion: "neutral",
			completed_at: new Date().toISOString(),
			output: renderOutput(state),
		});
	}
	console.log(`::notice::leg heartbeat done — ${state.samples.length} samples, ${state.postFailures} failed posts`);
}

if (import.meta.main) await main();
