#!/usr/bin/env bun
/**
 * ci-leg-checkpoint — a per-file progress marker that survives losing the
 * runner (issue #77, B5 of #110).
 *
 *   bun scripts/ci-leg-checkpoint.ts open  --files "$FILE_LIST"
 *   bun scripts/ci-leg-checkpoint.ts mark  --file test/integration/exec.test.ts \
 *                                          --outcome pass --duration 214 --cap 600
 *   bun scripts/ci-leg-checkpoint.ts close --conclusion success
 *
 * WHY THIS EXISTS. B4 bounded a *file* that hangs; it explicitly could not make
 * a *lost runner* diagnosable, because nothing running inside the job survives
 * one. #76's `macos-x86` legs die at ~62-65 min of job-elapsed time holding a
 * 290-minute step budget: `if: always()` never fires, no artifact is uploaded,
 * no metrics record is written, and the leg vanishes from `ci-data` entirely —
 * the 2026-07-31 sweep wrote 12 ndjson files for 15 legs with no marker for the
 * missing three. The only fix is to put the progress marker somewhere the
 * runner does not own.
 *
 * ── Why a check run ─────────────────────────────────────────────────────────
 * Ruled out, with evidence, before this was written:
 *
 *   the job log      — the loop already prints `::notice::Running <file>` per
 *                      file, so scraping it would have been free. It does not
 *                      survive. For all three vanished `macos-x86` legs of run
 *                      30665449265 the archived log blob returns `BlobNotFound`,
 *                      while a green leg AND a normally-failing windows leg from
 *                      the same run both return their full logs. Runner loss,
 *                      not failure, is what destroys it.
 *   an artifact      — uploaded by a step that never runs. That is the whole
 *                      point; #110 rules it out by name.
 *   a ci-data commit — unique per-leg paths avoid content conflicts, but 15 legs
 *                      x ~12 files is ~180 commits per sweep racing one branch
 *                      head.
 *   the jobs API     — DOES survive (a vanished leg still records its step as
 *                      `in_progress` with a start time, and the aggregate uses
 *                      exactly that, see `ci-metrics.ts ledger`). But it stops
 *                      at step granularity and can never name the file.
 *
 * A check run is server-side the moment it is PATCHed, carries a structured
 * payload with no 140-character limit (which is what ruled out a commit
 * status), and a leg that dies leaves it stuck `in_progress` — the absence of a
 * terminal IS the signal.
 *
 * ── This instrument must never turn a green leg red ─────────────────────────
 * Every API failure here is a loud `::warning::` and exit 0. An instrument that
 * fails the run it is measuring manufactures exactly the masked signal this
 * program exists to stop, and a fork PR's read-only token would fail every leg.
 * The safety net is on the reading side, not here: `ci-metrics.ts ledger`
 * classifies a leg from its *artifact* first and consults the check run only
 * for legs that produced none — so a checkpoint that silently failed to post
 * cannot fabricate a `runner-lost` for a leg that actually finished.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { hostSnapshot, type HostSnapshot } from "./ci-host-snapshot.ts";

/** One file's terminal state, as the loop observed it. */
export interface CheckpointRecord {
	file: string;
	index: number;
	outcome: string;
	duration_s?: number;
	cap_s?: number;
	ts: string;
	host?: HostSnapshot;
}

export interface LegIdentity {
	platform: string;
	target: string;
	resolved?: string;
	accel?: string;
	sha: string;
	run_id: string;
	attempt: string;
}

export interface CheckpointState {
	checkRunId?: number;
	leg: LegIdentity;
	planned: string[];
	startedAt: string;
	records: CheckpointRecord[];
}

/** Stable key for one leg of one run. One platform runs several RouterOS
 *  targets in the same run, so the target is part of the identity. */
export function legKey(platform: string, target: string): string {
	return `${platform}|${target}`;
}

/** The check run's `external_id`. The name is what a human reads and is
 *  deliberately short; this is what the aggregate matches on, because one SHA
 *  accumulates check runs from every run that ever targeted it (the sweep
 *  dispatches `platforms=all` against `main` repeatedly). */
export function externalId(leg: LegIdentity): string {
	return `${leg.run_id}/${leg.attempt}/${leg.platform}/${leg.target}`;
}

/** Inverse of {@link externalId}. Returns undefined for anything that is not
 *  one of ours, so a foreign check run on the same SHA is ignored rather than
 *  misread. */
export function parseExternalId(
	id: string | null | undefined,
): { run_id: string; attempt: string; platform: string; target: string } | undefined {
	if (!id) return undefined;
	const parts = id.split("/");
	if (parts.length !== 4) return undefined;
	const [run_id, attempt, platform, target] = parts as [string, string, string, string];
	if (!run_id || !attempt || !platform || !target) return undefined;
	return { run_id, attempt, platform, target };
}

/** Marker around the machine-readable block inside the check run's `output.text`.
 *  The aggregate reads this back; the summary above it is for humans only. */
const PAYLOAD_OPEN = "<!--quickchr-checkpoint";
const PAYLOAD_CLOSE = "-->";

/** Render the check run's output. Pure, so the payload contract is testable
 *  without touching the API. */
export function renderOutput(state: CheckpointState): { title: string; summary: string; text: string } {
	const done = state.records.length;
	const total = state.planned.length;
	const current = done < total ? state.planned[done] : undefined;

	const title = current
		? `${done}/${total} done — running ${basename(current)}`
		: `${done}/${total} files reported`;

	const rows = state.records.map(
		(r) =>
			`| ${r.index}/${total} | \`${r.file}\` | ${r.outcome} | ${r.duration_s ?? "?"}s | ${r.cap_s ?? "—"} | ${
				r.host?.freeMemMiB ?? "?"
			} MiB | ${r.host?.loadAvg?.[0]?.toFixed(2) ?? "?"} | ${r.host?.qemuCount ?? "?"} |`,
	);
	const summary = [
		`**${state.leg.platform} · ${state.leg.target}**${state.leg.resolved ? ` (${state.leg.resolved})` : ""}`,
		`accel \`${state.leg.accel ?? "?"}\` · run ${state.leg.run_id} attempt ${state.leg.attempt} · started ${state.startedAt}`,
		"",
		current
			? `Currently running \`${basename(current)}\`. **If this check never completes, the runner was lost here.**`
			: "All planned files reported.",
		"",
		"| # | file | outcome | duration | cap | free mem | load | qemu |",
		"|---|------|---------|----------|-----|----------|------|------|",
		...rows,
	].join("\n");

	// The record the aggregate parses. Kept inside an HTML comment so the check
	// run still reads cleanly in the UI.
	const payload = {
		leg: state.leg,
		planned: state.planned,
		startedAt: state.startedAt,
		records: state.records,
		current: current ?? null,
	};
	const text = `${PAYLOAD_OPEN}\n${JSON.stringify(payload)}\n${PAYLOAD_CLOSE}`;
	return { title, summary, text };
}

/** Read the machine-readable block back out of a check run's `output.text`. */
export function parsePayload(text: string | null | undefined): {
	leg: LegIdentity;
	planned: string[];
	startedAt: string;
	records: CheckpointRecord[];
	current: string | null;
} | undefined {
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

// --- runtime ------------------------------------------------------------------

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

function statePath(): string {
	return arg("--state") ?? join(process.env.HOME ?? ".", "leg-checkpoint.json");
}

function warn(message: string): void {
	console.log(`::warning title=Leg checkpoint::${message}`);
}

/** POST/PATCH the checks API. Returns undefined on ANY failure — see the header:
 *  this instrument never fails the leg it is measuring. */
async function api(path: string, method: "POST" | "PATCH", body: unknown): Promise<{ id?: number } | undefined> {
	const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
	const repo = process.env.GITHUB_REPOSITORY;
	if (!token || !repo) {
		warn(`no GITHUB_TOKEN/GITHUB_REPOSITORY — checkpoint not posted (${method} ${path})`);
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
			warn(`${method} ${path} → HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
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

function loadState(): CheckpointState | undefined {
	const p = statePath();
	if (!existsSync(p)) return undefined;
	try {
		return JSON.parse(readFileSync(p, "utf-8")) as CheckpointState;
	} catch {
		return undefined;
	}
}

async function saveState(state: CheckpointState): Promise<void> {
	await Bun.write(statePath(), `${JSON.stringify(state, null, "\t")}\n`);
}

async function open(): Promise<void> {
	const leg = identity();
	const planned = (arg("--files") ?? "")
		.split(/\s+/)
		.filter(Boolean)
		.map((f) => basename(f));
	const state: CheckpointState = { leg, planned, startedAt: new Date().toISOString(), records: [] };

	const created = await api("/check-runs", "POST", {
		name: `leg: ${leg.platform} · ${leg.target}`,
		head_sha: leg.sha,
		status: "in_progress",
		started_at: state.startedAt,
		external_id: externalId(leg),
		details_url: `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${process.env.GITHUB_REPOSITORY ?? ""}/actions/runs/${leg.run_id}`,
		output: renderOutput(state),
	});
	if (created?.id) {
		state.checkRunId = created.id;
		console.log(`::notice::leg checkpoint open — check run ${created.id} for ${legKey(leg.platform, leg.target)}`);
	}
	await saveState(state);
}

async function mark(): Promise<void> {
	const state = loadState();
	if (!state) {
		warn("no checkpoint state — `open` did not run or its state file is gone; nothing marked");
		return;
	}
	// `--from` is the normal path: the watchdog wrote this file, so the outcome
	// vocabulary and the cap have exactly one producer. The explicit flags exist
	// for a caller that is not the watchdog (and for tests).
	let sidecar: { file?: string; outcome?: string; elapsed_s?: number; cap_s?: number } = {};
	const from = arg("--from");
	if (from && existsSync(from)) {
		try {
			sidecar = JSON.parse(readFileSync(from, "utf-8"));
		} catch {
			warn(`could not parse ${from} — marking with what the flags provide`);
		}
	}

	const file = arg("--file") ?? sidecar.file;
	if (!file) {
		warn("mark called without --file and with no readable --from sidecar");
		return;
	}
	const durationRaw = Number(arg("--duration") ?? sidecar.elapsed_s);
	const capRaw = Number(arg("--cap") ?? sidecar.cap_s);
	state.records.push({
		file: basename(file),
		index: state.records.length + 1,
		outcome: arg("--outcome") ?? sidecar.outcome ?? "unknown",
		duration_s: Number.isFinite(durationRaw) ? Math.round(durationRaw) : undefined,
		cap_s: Number.isFinite(capRaw) ? capRaw : undefined,
		ts: new Date().toISOString(),
		host: await hostSnapshot(true),
	});
	await saveState(state);
	if (state.checkRunId) await api(`/check-runs/${state.checkRunId}`, "PATCH", { output: renderOutput(state) });
}

async function close(): Promise<void> {
	const state = loadState();
	if (!state) {
		warn("no checkpoint state — nothing to close");
		return;
	}
	if (!state.checkRunId) return;
	// `neutral`, not `failure`, when the loop went red: the leg's own job already
	// carries that verdict, and a second red check on the commit would double-count
	// one failure in every branch-protection and PR-status view.
	const conclusion = arg("--conclusion") === "success" ? "success" : "neutral";
	await api(`/check-runs/${state.checkRunId}`, "PATCH", {
		status: "completed",
		conclusion,
		completed_at: new Date().toISOString(),
		output: renderOutput(state),
	});
	console.log(`::notice::leg checkpoint closed (${conclusion}) — ${state.records.length}/${state.planned.length} files reported`);
}

if (import.meta.main) {
	const mode = process.argv[2];
	if (mode === "open") await open();
	else if (mode === "mark") await mark();
	else if (mode === "close") await close();
	else {
		console.error("usage: ci-leg-checkpoint <open|mark|close> …");
		process.exit(2);
	}
}
