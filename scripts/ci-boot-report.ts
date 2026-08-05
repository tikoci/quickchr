#!/usr/bin/env bun
/**
 * ci-boot-report — combined CHR boot-time table across every platform/accel
 * in ci-data (issue #30's raw feed). Each integration job's own step summary
 * (ci-metrics.ts assemble) only ever shows a "Boot timing" table for ITS
 * platform — comparing across platforms means pulling every runs/*.ndjson
 * from a ci-data checkout and regrouping. That's what this does.
 *
 *   git worktree add /tmp/ci-data ci-data   # once, from a quickchr checkout
 *   bun scripts/ci-boot-report.ts --data /tmp/ci-data
 *   bun scripts/ci-boot-report.ts --data /tmp/ci-data --format json --out boots.json
 *
 * Optional filters narrow the default (every boot ever recorded in ci-data):
 *   --run-id <id>       only runs/*.ndjson for that run (a single workflow run
 *                       may still cover several platform legs)
 *   --since <ISO date>  only boots with ts >= this date, e.g. 2026-07-01
 *   --trim-outliers     drop boots over 2x a group's median before computing
 *                       median/min/max. A boot occasionally stalls on a
 *                       loaded runner (host contention, a wedged watchdog
 *                       retry) and lands 7-8x past the group's usual range
 *                       (e.g. 205s against a 26s median) — a single one of
 *                       those swamps the "max" column otherwise. A plain IQR
 *                       fence was tried and rejected: this data is routinely
 *                       bimodal (cache-hit vs cache-miss boot paths a couple
 *                       seconds apart) and IQR flagged the smaller of the two
 *                       real clusters as "outliers", dropping up to a third
 *                       of a group's legitimate boots. 2x-median only ever
 *                       catches the genuine multi-hundred-second stalls.
 *                       Dropped count is reported per row.
 *
 * Grouped by platform × accel × RouterOS version — arch is implied by
 * platform for every platform id in use today, but accel is not: macos-x86
 * runs both hvf and tcg legs (the accel-contrast work, #137), so collapsing
 * accel would silently average two very different boot paths together.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface BootRecord {
	kind: "boot";
	ts: string;
	run_id: string;
	platform: string;
	version: string;
	arch: string;
	accel: string;
	boot_ms: number;
}

interface Group {
	platform: string;
	accel: string;
	version: string;
	boots: number[];
	dropped: number;
}

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Median of a non-empty number list. */
function median(nums: number[]): number {
	const s = [...nums].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Drop boots over 2x the group's median — see the --trim-outliers doc
 *  comment at the top of the file for why this (and not an IQR fence) is the
 *  right rule for this data's shape. */
function dropOutliers(nums: number[]): { kept: number[]; dropped: number } {
	const bound = 2 * median(nums);
	const kept = nums.filter((n) => n <= bound);
	return { kept, dropped: nums.length - kept.length };
}

function loadBoots(dataDir: string, runId: string | undefined, since: string | undefined): BootRecord[] {
	const runsDir = join(dataDir, "runs");
	if (!existsSync(runsDir)) {
		console.error(`ci-boot-report: no runs/ under ${dataDir} — wrong --data path? (git worktree add <dir> ci-data)`);
		process.exit(1);
	}
	const boots: BootRecord[] = [];
	// Sorted traversal → deterministic group order for equal input.
	for (const name of [...readdirSync(runsDir)].sort()) {
		if (!name.endsWith(".ndjson")) continue;
		if (runId && !name.startsWith(`${runId}-`)) continue;
		const text = readFileSync(join(runsDir, name), "utf-8");
		for (const line of text.split("\n")) {
			if (!line) continue;
			const r = JSON.parse(line);
			if (r.kind !== "boot") continue;
			if (since && r.ts < since) continue;
			boots.push(r);
		}
	}
	return boots;
}

function groupBoots(records: BootRecord[], trimOutliers: boolean): Group[] {
	const byKey = new Map<string, number[]>();
	for (const r of records) {
		const key = `${r.platform}|${r.accel}|${r.version}`;
		byKey.set(key, [...(byKey.get(key) ?? []), r.boot_ms]);
	}
	const groups: Group[] = [];
	for (const [key, allBoots] of byKey) {
		const [platform, accel, version] = key.split("|") as [string, string, string];
		const { kept, dropped } = trimOutliers ? dropOutliers(allBoots) : { kept: allBoots, dropped: 0 };
		groups.push({ platform, accel, version, boots: kept, dropped });
	}
	return groups.sort(
		(a, b) =>
			a.platform.localeCompare(b.platform) ||
			a.accel.localeCompare(b.accel) ||
			b.version.localeCompare(a.version, undefined, { numeric: true }),
	);
}

function toMarkdown(groups: Group[], trimOutliers: boolean): string {
	const fmt = (n: number) => `${Math.round(n / 100) / 10}s`;
	const header = trimOutliers
		? "| platform | accel | RouterOS | boots | dropped | median | min | max |"
		: "| platform | accel | RouterOS | boots | median | min | max |";
	const rule = trimOutliers
		? "|----------|-------|----------|-------|---------|--------|-----|-----|"
		: "|----------|-------|----------|-------|--------|-----|-----|";
	const lines = [header, rule];
	for (const g of groups) {
		const cols = [
			g.platform,
			g.accel,
			g.version,
			String(g.boots.length),
			...(trimOutliers ? [String(g.dropped)] : []),
			fmt(median(g.boots)),
			fmt(Math.min(...g.boots)),
			fmt(Math.max(...g.boots)),
		];
		lines.push(`| ${cols.join(" | ")} |`);
	}
	return lines.join("\n");
}

function toJson(groups: Group[], trimOutliers: boolean): string {
	return JSON.stringify(
		groups.map((g) => ({
			platform: g.platform,
			accel: g.accel,
			version: g.version,
			boots: g.boots.length,
			...(trimOutliers ? { dropped: g.dropped } : {}),
			median_ms: median(g.boots),
			min_ms: Math.min(...g.boots),
			max_ms: Math.max(...g.boots),
		})),
		null,
		"\t",
	);
}

function main(): void {
	const dataDir = arg("--data");
	if (!dataDir) {
		console.error(
			"usage: ci-boot-report --data <ci-data-dir> [--format md|json] [--out <file>] [--run-id <id>] [--since <ISO date>] [--trim-outliers]",
		);
		process.exit(2);
	}
	const format = arg("--format") ?? "md";
	const out = arg("--out");
	const runId = arg("--run-id");
	const since = arg("--since");
	const trimOutliers = process.argv.includes("--trim-outliers");

	const boots = loadBoots(dataDir, runId, since);
	if (boots.length === 0) {
		console.error("ci-boot-report: no boot records matched — check --data/--run-id/--since");
		process.exit(1);
	}
	const groups = groupBoots(boots, trimOutliers);
	const output = format === "json" ? toJson(groups, trimOutliers) : toMarkdown(groups, trimOutliers);

	if (out) {
		writeFileSync(out, `${output}\n`);
		const droppedTotal = groups.reduce((n, g) => n + g.dropped, 0);
		const droppedNote = trimOutliers ? `, ${droppedTotal} outlier(s) dropped` : "";
		console.error(`ci-boot-report: wrote ${groups.length} group(s) from ${boots.length} boots${droppedNote} to ${out}`);
	} else {
		console.log(output);
	}
}

if (import.meta.main) main();
