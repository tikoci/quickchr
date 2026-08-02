import { describe, expect, test } from "bun:test";
import {
	externalId,
	legKey,
	parseExternalId,
	parsePayload,
	renderOutput,
	type CheckpointState,
} from "../../scripts/ci-leg-checkpoint.ts";

// Anchor tests for the leg checkpoint's payload contract (B5 of #110).
//
// The writer runs on the leg and the reader runs in the aggregate job, minutes
// later and on a different machine — so the round trip through a check run's
// `output.text` is the whole interface between them, and it is the only part
// that can be verified without a runner.

const LEG = {
	platform: "macos-x86",
	target: "stable",
	resolved: "7.23.2",
	accel: "hvf",
	sha: "abc123",
	run_id: "30665449265",
	attempt: "1",
};

function state(over: Partial<CheckpointState> = {}): CheckpointState {
	return {
		checkRunId: 42,
		leg: LEG,
		planned: ["anchor.test.ts", "exec.test.ts", "provisioning.test.ts"],
		startedAt: "2026-07-31T21:08:57.000Z",
		records: [
			{
				file: "anchor.test.ts",
				index: 1,
				outcome: "pass",
				duration_s: 168,
				cap_s: 600,
				ts: "2026-07-31T21:11:45.000Z",
				host: {
					platform: "darwin",
					cpuCount: 4,
					totalMemMiB: 14336,
					freeMemMiB: 2048,
					freeDiskMiB: 51200,
					loadAvg: [3.14, 2.7, 1.4],
					hostUptimeS: 900,
					qemuCount: 0,
				},
			},
		],
		...over,
	};
}

describe("external_id", () => {
	test("round-trips the identity the aggregate matches on", () => {
		expect(parseExternalId(externalId(LEG))).toEqual({
			run_id: "30665449265",
			attempt: "1",
			platform: "macos-x86",
			target: "stable",
		});
	});

	test("carries the run id, because one SHA accumulates many runs' check runs", () => {
		// The sweep dispatches `platforms=all` against `main` repeatedly, so the
		// same commit collects a `leg: macos-x86 · stable` from every one. Without
		// the run id in the external id, a run would read its successor's marker.
		expect(externalId(LEG)).toContain("30665449265");
		expect(externalId({ ...LEG, run_id: "999" })).not.toBe(externalId(LEG));
	});

	test("a foreign or malformed external id is ignored, never guessed at", () => {
		expect(parseExternalId(null)).toBeUndefined();
		expect(parseExternalId("")).toBeUndefined();
		expect(parseExternalId("some-other-tool")).toBeUndefined();
		expect(parseExternalId("1/2/3")).toBeUndefined();
		expect(parseExternalId("1/2/3/4/5")).toBeUndefined();
		expect(parseExternalId("1//macos-x86/stable")).toBeUndefined();
	});
});

describe("renderOutput", () => {
	test("the title names the file currently running — the point of the whole bite", () => {
		// A leg that dies here leaves this title as its epitaph, so it has to say
		// where it was, not just how far it got.
		expect(renderOutput(state()).title).toBe("1/3 done — running exec.test.ts");
	});

	test("the summary says outright what an un-closed check means", () => {
		expect(renderOutput(state()).summary).toContain("If this check never completes, the runner was lost here");
	});

	test("after the last file there is no current file", () => {
		const full = state({
			records: ["anchor.test.ts", "exec.test.ts", "provisioning.test.ts"].map((file, i) => ({
				file,
				index: i + 1,
				outcome: "pass",
				ts: "2026-07-31T21:11:45.000Z",
			})),
		});
		expect(renderOutput(full).title).toBe("3/3 files reported");
		expect(parsePayload(renderOutput(full).text)?.current).toBeNull();
	});

	test("payload round-trips through output.text", () => {
		const parsed = parsePayload(renderOutput(state()).text);
		expect(parsed?.leg.platform).toBe("macos-x86");
		expect(parsed?.leg.accel).toBe("hvf");
		expect(parsed?.records).toHaveLength(1);
		expect(parsed?.records[0]?.file).toBe("anchor.test.ts");
		// One file reported, so the leg is inside planned[1].
		expect(parsed?.current).toBe("exec.test.ts");
		// #77's per-checkpoint list: the resource sample has to survive the trip,
		// or the ledger records a name with no context around it.
		expect(parsed?.records[0]?.host?.freeMemMiB).toBe(2048);
		expect(parsed?.records[0]?.host?.qemuCount).toBe(0);
	});

	test("an empty leg renders without a current file and with no rows", () => {
		const parsed = parsePayload(renderOutput(state({ records: [], planned: [] })).text);
		expect(parsed?.records).toEqual([]);
		expect(parsed?.current).toBeNull();
	});
});

describe("parsePayload", () => {
	test("returns undefined rather than throwing on anything unparseable", () => {
		// This runs in the aggregate, over check runs written by who-knows-what.
		// A throw there would cost the whole ledger, including the legs that are
		// perfectly readable.
		expect(parsePayload(undefined)).toBeUndefined();
		expect(parsePayload("")).toBeUndefined();
		expect(parsePayload("a plain human summary")).toBeUndefined();
		expect(parsePayload("<!--quickchr-checkpoint not json -->")).toBeUndefined();
		expect(parsePayload("<!--quickchr-checkpoint {\"a\":1}")).toBeUndefined();
	});
});

describe("legKey", () => {
	test("distinguishes targets on one platform", () => {
		expect(legKey("macos-x86", "stable")).not.toBe(legKey("macos-x86", "testing"));
	});
});
