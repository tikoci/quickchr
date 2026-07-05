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
 *             marks a version "tested" — and each run marks exactly ONE version:
 *             its target's resolution. The ros-versions scheduler reads this.
 *
 * refold    — rebuild tested-versions.json from every runs/*.ndjson already on
 *             the ci-data branch (heals the rollup after a fold-logic fix):
 *               bun scripts/ci-metrics.ts refold --data <ci-data-dir>
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

/** RouterOS version shape (7.22.1, 7.24beta2, 7.24rc1) — anything else is a channel alias. */
const VERSION_SHAPE = /^[0-9]+\.[0-9]+(\.[0-9]+)?((beta|rc)[0-9]+)?$/;

/** The RouterOS version a suite run actually tested. A version-shaped target is
 *  itself; a channel alias (stable/testing/…) resolves to the run's MODAL boot
 *  version — tests boot the leg's target by default, so the majority of boots
 *  are the channel's resolution, while pinned-version tests (upgrade paths,
 *  provisioning baselines) stay in the minority. */
export function resolvedTargetVersion(records: Array<{ kind: string; [k: string]: unknown }>): string | undefined {
	const suite = records.find((r) => r.kind === "suite") as SuiteRecord | undefined;
	if (!suite) return undefined;
	if (VERSION_SHAPE.test(suite.target)) return suite.target;
	const counts = new Map<string, number>();
	for (const r of records) {
		if (r.kind !== "boot") continue;
		const v = (r as { version?: unknown }).version;
		if (typeof v !== "string" || v === "") continue;
		counts.set(v, (counts.get(v) ?? 0) + 1);
	}
	let best: string | undefined;
	let bestCount = 0;
	for (const [v, n] of counts) {
		if (n > bestCount) {
			best = v;
			bestCount = n;
		}
	}
	return best;
}

/** Fold one metrics file's records into the tested-versions rollup.
 *  Only full-scope suite runs count, and a run marks exactly ONE version — its
 *  target's resolution — never every version it happened to boot. Upgrade and
 *  pinned-channel tests boot other versions incidentally; crediting those would
 *  suppress the ros-versions scheduler for versions no full suite ever targeted
 *  (observed: run 28748268691 targeted 7.20.8 but credited 7.23.1). */
export function foldTestedVersions(tested: TestedVersions, ndjson: string): TestedVersions {
	const records = ndjson.split("\n").filter(Boolean).map((l) => JSON.parse(l));
	const suite = records.find((r) => r.kind === "suite") as SuiteRecord | undefined;
	if (!suite || suite.scope !== "full") return tested;
	const version = resolvedTargetVersion(records);
	if (!version) return tested;
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
	return tested;
}

function findMetricsFiles(dir: string): string[] {
	const out: string[] = [];
	// Sorted traversal → deterministic fold order → stable rollup output
	// (readdir's native order varies run-to-run and would churn ci-data diffs).
	for (const name of [...readdirSync(dir)].sort()) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) out.push(...findMetricsFiles(p));
		else if (name === "metrics.ndjson") out.push(p);
	}
	return out;
}

/** Deep-sort object keys so tested-versions.json is byte-stable for equal data. */
export function sortKeysDeep<T>(value: T): T {
	if (Array.isArray(value)) return value.map(sortKeysDeep) as T;
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(value as object).sort()) {
			out[k] = sortKeysDeep((value as Record<string, unknown>)[k]);
		}
		return out as T;
	}
	return value;
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
		const records = ndjson.split("\n").filter(Boolean).map((l) => JSON.parse(l));
		const first = records[0] as { run_id: string; platform: string } | undefined;
		if (!first) continue;
		// One run may cover the same platform under several RouterOS targets —
		// the target is part of the per-run filename so legs never collide.
		const suite = records.find((r) => r.kind === "suite") as { target?: string } | undefined;
		const target = (suite?.target ?? "unknown").replace(/[^A-Za-z0-9.-]/g, "-");
		writeFileSync(join(dataDir, "runs", `${first.run_id}-${first.platform}-${target}.ndjson`), ndjson);
		tested = foldTestedVersions(tested, ndjson);
	}
	writeFileSync(testedPath, `${JSON.stringify(sortKeysDeep(tested), null, "\t")}\n`);
	console.log(`ci-metrics: aggregated ${files.length} metrics file(s) into ${dataDir}`);
}

/** Rebuild tested-versions.json from scratch out of every runs/*.ndjson on a
 *  ci-data checkout — the healing path after a fold-logic change (the per-run
 *  files are the source of truth; the rollup is derived). */
function refold(): void {
	const dataDir = arg("--data");
	if (!dataDir) {
		console.error("usage: ci-metrics refold --data <ci-data-dir>");
		process.exit(2);
	}
	const runsDir = join(dataDir, "runs");
	const files = existsSync(runsDir)
		? [...readdirSync(runsDir)].sort().filter((f) => f.endsWith(".ndjson"))
		: [];
	let tested: TestedVersions = {};
	for (const f of files) {
		tested = foldTestedVersions(tested, readFileSync(join(runsDir, f), "utf-8"));
	}
	writeFileSync(join(dataDir, "tested-versions.json"), `${JSON.stringify(sortKeysDeep(tested), null, "\t")}\n`);
	console.log(`ci-metrics: refolded ${files.length} run file(s) into tested-versions.json`);
}

if (import.meta.main) {
	const mode = process.argv[2];
	if (mode === "assemble") assemble();
	else if (mode === "aggregate") aggregate();
	else if (mode === "refold") refold();
	else {
		console.error("usage: ci-metrics <assemble|aggregate|refold> …");
		process.exit(2);
	}
}
