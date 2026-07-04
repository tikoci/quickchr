#!/usr/bin/env bun
/**
 * ci-metrics — CHR timing collection for CI (issue #30). Two modes:
 *
 * assemble  — run inside an integration job, after the test loop:
 *               bun scripts/ci-metrics.ts assemble \
 *                 --timing "$HOME/integration-timing.txt" --out "$HOME/metrics.ndjson"
 *             Reads the boot-history log (boot-log.ndjson, written by the
 *             library on every successful boot) + the per-file timing file
 *             (written by the workflow's test loop) and emits one NDJSON file:
 *               {kind:"boot",  ts, run_id, sha, platform, host, name, version, arch, accel, boot_ms}
 *               {kind:"test-file", …, file, duration_s, status}
 *               {kind:"suite", …, scope: "full"|"filtered", conclusion: "pass"|"fail",
 *                target, files, failed}
 *             Env: PLATFORM_ID, SCOPE, SUITE_CONCLUSION, QUICKCHR_TEST_TARGET,
 *             GITHUB_RUN_ID, GITHUB_SHA, GITHUB_STEP_SUMMARY (optional table).
 *
 * aggregate — run in the aggregator job against a checkout of the ci-data
 *             branch + the downloaded per-platform artifacts:
 *               bun scripts/ci-metrics.ts aggregate --data <ci-data-dir> --artifacts <dir>
 *             Copies every metrics.ndjson found under <artifacts> to
 *             <ci-data-dir>/runs/<run_id>-<platform>.ndjson and folds suite
 *             records into <ci-data-dir>/tested-versions.json:
 *               { "<version>": { "<platform>": { run_id, date, conclusion } } }
 *             Only scope="full" suite records count — a filtered/smoke run never
 *             marks a version "tested". The ros-versions scheduler reads this.
 *
 * Schema doc lives on the ci-data branch README; keep the two in sync.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootLogPath } from "../src/lib/state.ts";

interface BaseRecord {
	kind: "boot" | "test-file" | "suite";
	ts: string;
	run_id: string;
	sha: string;
	platform: string;
	host: string;
}

function baseRecord(kind: BaseRecord["kind"]): BaseRecord {
	return {
		kind,
		ts: new Date().toISOString(),
		run_id: process.env.GITHUB_RUN_ID ?? "local",
		sha: process.env.GITHUB_SHA ?? "",
		platform: process.env.PLATFORM_ID ?? "unknown",
		host: process.platform,
	};
}

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Parse the workflow's timing file: one `<file> <seconds>s <pass|fail>` per line. */
export function parseTimingFile(text: string): Array<{ file: string; duration_s: number; status: string }> {
	const out: Array<{ file: string; duration_s: number; status: string }> = [];
	for (const line of text.split("\n")) {
		const m = line.trim().match(/^(\S+)\s+(\d+)s\s+(pass|fail)$/);
		if (m?.[1] && m[2] && m[3]) out.push({ file: m[1], duration_s: Number(m[2]), status: m[3] });
	}
	return out;
}

/** Median of a non-empty number list. */
function median(nums: number[]): number {
	const s = [...nums].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

function assemble(): void {
	const timingPath = arg("--timing");
	const outPath = arg("--out");
	if (!timingPath || !outPath) {
		console.error("usage: ci-metrics assemble --timing <file> --out <file>");
		process.exit(2);
	}

	const records: object[] = [];

	// Boots — the library appends every successful boot of this run to the
	// boot-history log (fresh on a CI runner; it is outside the image cache path).
	interface BootEntry { ts: string; name: string; version: string; arch: string; accel: string; bootMs: number }
	let boots: BootEntry[] = [];
	if (existsSync(bootLogPath())) {
		boots = readFileSync(bootLogPath(), "utf-8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l) as BootEntry);
	}
	for (const b of boots) {
		records.push({
			...baseRecord("boot"),
			ts: b.ts,
			name: b.name,
			version: b.version,
			arch: b.arch,
			accel: b.accel,
			boot_ms: b.bootMs,
		});
	}

	// Per test file timings from the workflow's sequential loop.
	const timings = existsSync(timingPath) ? parseTimingFile(readFileSync(timingPath, "utf-8")) : [];
	for (const t of timings) {
		records.push({ ...baseRecord("test-file"), ...t });
	}

	// One suite record — what the scheduler/tested-versions rollup consumes.
	const failed = timings.filter((t) => t.status === "fail").length;
	records.push({
		...baseRecord("suite"),
		scope: process.env.SCOPE === "full" ? "full" : "filtered",
		conclusion: process.env.SUITE_CONCLUSION === "pass" && failed === 0 ? "pass" : "fail",
		target: process.env.QUICKCHR_TEST_TARGET || "stable",
		files: timings.length,
		failed,
	});

	writeFileSync(outPath, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
	console.log(`ci-metrics: wrote ${records.length} records (${boots.length} boots, ${timings.length} test files) to ${outPath}`);

	// Compact boot-timing table for the job summary.
	const summary = process.env.GITHUB_STEP_SUMMARY;
	if (summary && boots.length > 0) {
		const byKey = new Map<string, number[]>();
		for (const b of boots) {
			const key = `${b.version}|${b.arch}|${b.accel}`;
			byKey.set(key, [...(byKey.get(key) ?? []), b.bootMs]);
		}
		const lines = [
			"",
			"### Boot timing",
			"",
			"| RouterOS | arch | accel | boots | median | min | max |",
			"|----------|------|-------|-------|--------|-----|-----|",
		];
		for (const [key, ms] of byKey) {
			const [version, arch, accel] = key.split("|");
			const fmt = (n: number) => `${Math.round(n / 100) / 10}s`;
			lines.push(
				`| ${version} | ${arch} | ${accel} | ${ms.length} | ${fmt(median(ms))} | ${fmt(Math.min(...ms))} | ${fmt(Math.max(...ms))} |`,
			);
		}
		writeFileSync(summary, `${readFileSync(summary, "utf-8")}${lines.join("\n")}\n`);
	}
}

// --- aggregate -----------------------------------------------------------------

interface SuiteRecord {
	kind: string;
	run_id: string;
	ts: string;
	platform: string;
	scope: string;
	conclusion: string;
	target: string;
}

export type TestedVersions = Record<string, Record<string, { run_id: string; date: string; conclusion: string }>>;

/** Fold one metrics file's records into the tested-versions rollup.
 *  Only full-scope suite runs count; version comes from the run's boot records
 *  (the actually-booted RouterOS, not the channel alias it was requested by). */
export function foldTestedVersions(tested: TestedVersions, ndjson: string): TestedVersions {
	const records = ndjson.split("\n").filter(Boolean).map((l) => JSON.parse(l));
	const suite = records.find((r) => r.kind === "suite") as SuiteRecord | undefined;
	if (!suite || suite.scope !== "full") return tested;
	const versions = new Set(
		records.filter((r) => r.kind === "boot").map((r) => (r as { version: string }).version),
	);
	for (const version of versions) {
		const platforms = tested[version] ?? {};
		const prior = platforms[suite.platform];
		// A later run supersedes; never let a pass be overwritten by nothing.
		if (!prior || prior.date <= suite.ts) {
			platforms[suite.platform] = {
				run_id: suite.run_id,
				date: suite.ts,
				conclusion: suite.conclusion,
			};
		}
		tested[version] = platforms;
	}
	return tested;
}

function findMetricsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) out.push(...findMetricsFiles(p));
		else if (name === "metrics.ndjson") out.push(p);
	}
	return out;
}

function aggregate(): void {
	const dataDir = arg("--data");
	const artifactsDir = arg("--artifacts");
	if (!dataDir || !artifactsDir) {
		console.error("usage: ci-metrics aggregate --data <ci-data-dir> --artifacts <dir>");
		process.exit(2);
	}
	mkdirSync(join(dataDir, "runs"), { recursive: true });
	const testedPath = join(dataDir, "tested-versions.json");
	let tested: TestedVersions = existsSync(testedPath)
		? (JSON.parse(readFileSync(testedPath, "utf-8")) as TestedVersions)
		: {};

	const files = existsSync(artifactsDir) ? findMetricsFiles(artifactsDir) : [];
	for (const file of files) {
		const ndjson = readFileSync(file, "utf-8");
		const first = ndjson.split("\n").find(Boolean);
		if (!first) continue;
		const { run_id, platform } = JSON.parse(first) as { run_id: string; platform: string };
		writeFileSync(join(dataDir, "runs", `${run_id}-${platform}.ndjson`), ndjson);
		tested = foldTestedVersions(tested, ndjson);
	}
	writeFileSync(testedPath, `${JSON.stringify(tested, null, "\t")}\n`);
	console.log(`ci-metrics: aggregated ${files.length} metrics file(s) into ${dataDir}`);
}

if (import.meta.main) {
	const mode = process.argv[2];
	if (mode === "assemble") assemble();
	else if (mode === "aggregate") aggregate();
	else {
		console.error("usage: ci-metrics <assemble|aggregate> …");
		process.exit(2);
	}
}
