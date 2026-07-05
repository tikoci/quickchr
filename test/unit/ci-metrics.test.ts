import { describe, expect, test } from "bun:test";
import {
	foldTestedVersions,
	parseTimingFile,
	resolvedTargetVersion,
	type TestedVersions,
} from "../../scripts/ci-metrics.ts";

// Anchor tests for the CI metrics pipeline (scripts/ci-metrics.ts, issue #30):
// the timing-file parser and the tested-versions rollup the ros-versions
// scheduler consumes.

describe("parseTimingFile", () => {
	test("parses the workflow's '<file> <n>s <status>' lines, ignoring noise", () => {
		const parsed = parseTimingFile(
			["start-stop.test.ts 247s pass", "exec.test.ts 121s fail", "", "garbage line", "weird 12x pass"].join("\n"),
		);
		expect(parsed).toEqual([
			{ file: "start-stop.test.ts", duration_s: 247, status: "pass" },
			{ file: "exec.test.ts", duration_s: 121, status: "fail" },
		]);
	});
});

function metricsNdjson(over: {
	version?: string;
	boots?: string[]; // boot versions, in order — overrides `version`
	target?: string;
	platform?: string;
	scope?: string;
	conclusion?: string;
	run_id?: string;
	ts?: string;
}): string {
	const platform = over.platform ?? "linux-x86";
	const run_id = over.run_id ?? "100";
	const ts = over.ts ?? "2026-07-04T10:00:00Z";
	const boots = over.boots ?? [over.version ?? "7.22.1"];
	return [
		...boots.map((version) =>
			JSON.stringify({
				kind: "boot",
				run_id,
				ts,
				platform,
				version,
				arch: "x86",
				accel: "kvm",
				boot_ms: 61000,
			}),
		),
		JSON.stringify({
			kind: "suite",
			run_id,
			ts,
			platform,
			scope: over.scope ?? "full",
			conclusion: over.conclusion ?? "pass",
			target: over.target ?? "stable",
			files: 8,
			failed: 0,
		}),
	].join("\n");
}

describe("foldTestedVersions", () => {
	test("full-scope pass marks the booted version tested on that platform", () => {
		const tested = foldTestedVersions({}, metricsNdjson({ version: "7.22.1" }));
		expect(tested["7.22.1"]?.["linux-x86"]?.conclusion).toBe("pass");
		expect(tested["7.22.1"]?.["linux-x86"]?.run_id).toBe("100");
	});

	test("filtered/smoke runs never mark a version tested", () => {
		const tested = foldTestedVersions({}, metricsNdjson({ scope: "filtered" }));
		expect(tested).toEqual({});
	});

	test("a fail is recorded (so the scheduler can re-flag it), not dropped", () => {
		const tested = foldTestedVersions({}, metricsNdjson({ conclusion: "fail" }));
		expect(tested["7.22.1"]?.["linux-x86"]?.conclusion).toBe("fail");
	});

	test("a newer run supersedes; an older run never overwrites a newer record", () => {
		let tested: TestedVersions = {};
		tested = foldTestedVersions(tested, metricsNdjson({ ts: "2026-07-04T10:00:00Z", conclusion: "fail", run_id: "100" }));
		tested = foldTestedVersions(tested, metricsNdjson({ ts: "2026-07-05T10:00:00Z", conclusion: "pass", run_id: "200" }));
		expect(tested["7.22.1"]?.["linux-x86"]?.conclusion).toBe("pass");
		// Replaying the older file must not regress the rollup.
		tested = foldTestedVersions(tested, metricsNdjson({ ts: "2026-07-04T10:00:00Z", conclusion: "fail", run_id: "100" }));
		expect(tested["7.22.1"]?.["linux-x86"]?.conclusion).toBe("pass");
	});

	test("platforms accumulate independently under one version", () => {
		let tested: TestedVersions = {};
		tested = foldTestedVersions(tested, metricsNdjson({ platform: "linux-x86" }));
		tested = foldTestedVersions(tested, metricsNdjson({ platform: "linux-arm64", run_id: "101" }));
		expect(Object.keys(tested["7.22.1"] ?? {}).sort()).toEqual(["linux-arm64", "linux-x86"]);
	});

	// Attribution guard: a run marks ONLY its target's version. Upgrade and
	// pinned-channel tests boot other versions incidentally; crediting those
	// suppressed the scheduler for versions no full suite ever targeted
	// (run 28748268691 targeted 7.20.8 but credited 7.23.1 and 7.20.7).
	test("incidental boots of other versions are never credited", () => {
		const tested = foldTestedVersions(
			{},
			metricsNdjson({ target: "7.20.8", boots: ["7.20.8", "7.20.8", "7.20.7", "7.23.1"] }),
		);
		expect(Object.keys(tested)).toEqual(["7.20.8"]);
	});

	test("a channel target resolves to the modal boot version", () => {
		const tested = foldTestedVersions(
			{},
			metricsNdjson({ target: "stable", boots: ["7.20.8", "7.20.8", "7.20.8", "7.20.7"] }),
		);
		expect(Object.keys(tested)).toEqual(["7.20.8"]);
	});

	test("a channel target with no boot records marks nothing", () => {
		const suiteOnly = metricsNdjson({ target: "stable", boots: [] });
		expect(foldTestedVersions({}, suiteOnly)).toEqual({});
	});
});

describe("resolvedTargetVersion", () => {
	const parse = (ndjson: string) =>
		ndjson
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l) as { kind: string });

	test("a version-shaped target is itself, regardless of boots", () => {
		const records = parse(metricsNdjson({ target: "7.24beta2", boots: ["7.20.7", "7.20.7"] }));
		expect(resolvedTargetVersion(records)).toBe("7.24beta2");
	});

	test("a channel target is the modal boot version", () => {
		const records = parse(metricsNdjson({ target: "testing", boots: ["7.23.1", "7.20.7", "7.23.1"] }));
		expect(resolvedTargetVersion(records)).toBe("7.23.1");
	});
});
