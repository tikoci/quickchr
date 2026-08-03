import { describe, expect, test } from "bun:test";
import { parseExternalId, type CheckpointState } from "../../scripts/ci-leg-checkpoint.ts";
import type { HostSnapshot } from "../../scripts/ci-host-snapshot.ts";
import {
	heartbeatExternalId,
	locate,
	MAX_SAMPLES,
	MAX_TEXT_BYTES,
	parseCheckpoint,
	parsePayload,
	renderOutput,
	type HeartbeatSample,
	type HeartbeatState,
} from "../../scripts/ci-leg-heartbeat.ts";

// Anchor tests for the in-file heartbeat (B8d of #110, for #76).
//
// Everything here is the part that runs where no test can reach it: the payload
// is written on a runner that is expected to die, and read by a human minutes
// later out of a check run. The round trip, the size bound and the file
// attribution are the whole interface, and all three are verifiable without a
// runner.

const LEG = {
	platform: "macos-x86",
	target: "stable",
	resolved: "7.23.2",
	accel: "hvf",
	sha: "abc123",
	run_id: "30844433241",
	attempt: "1",
};

const HOST: HostSnapshot = {
	platform: "darwin",
	cpuCount: 4,
	totalMemMiB: 14336,
	freeMemMiB: 2048,
	freeDiskMiB: 51200,
	freeDataDiskMiB: 51200,
	memFreePct: 41,
	swapUsedMiB: 1596,
	loadAvg: [3.14, 2.7, 1.4],
	hostUptimeS: 900,
	qemuCount: 1,
};

function sample(over: Partial<HeartbeatSample> = {}): HeartbeatSample {
	return {
		ts: "2026-08-03T21:20:00.000Z",
		elapsed_s: 930,
		file: "provisioning.test.ts",
		fileIndex: 10,
		inFile_s: 240,
		host: HOST,
		...over,
	};
}

function state(over: Partial<HeartbeatState> = {}): HeartbeatState {
	return {
		checkRunId: 42,
		leg: LEG,
		startedAt: "2026-08-03T21:04:30.000Z",
		intervalS: 30,
		samples: [sample()],
		postFailures: 0,
		...over,
	};
}

describe("external_id", () => {
	test("B5's reader skips a heartbeat rather than reading it as a leg", () => {
		// The load-bearing assertion of the two-check-run design. `parseExternalId`
		// takes exactly four segments, so ci-leg-ledger's check-run scan drops these
		// with no knowledge that they exist — and a heartbeat can therefore never be
		// mistaken for a leg checkpoint stuck `in_progress`, i.e. never fabricate a
		// `runner-lost` entry for a leg that finished.
		expect(parseExternalId(heartbeatExternalId(LEG))).toBeUndefined();
	});

	test("still carries the identity a human needs to match it to its leg", () => {
		expect(heartbeatExternalId(LEG)).toBe("30844433241/1/macos-x86/stable/hb");
	});
});

describe("renderOutput", () => {
	test("the title names the file and how far in — a wedged leg's epitaph", () => {
		expect(renderOutput(state()).title).toBe("1 sample — provisioning.test.ts @ 930s");
		expect(renderOutput(state({ samples: [sample(), sample()] })).title).toContain("2 samples —");
	});

	test("the summary says outright what an un-closed check means", () => {
		expect(renderOutput(state()).summary).toContain("the last row below is the last thing the host said");
	});

	test("payload round-trips every reading the open hypotheses need", () => {
		// Disk and memory are the two live hypotheses for #76 and neither has ever
		// been sampled inside the wedged file. A field that does not survive the
		// round trip is a field that was never measured.
		const parsed = parsePayload(renderOutput(state()).text);
		expect(parsed?.samples).toHaveLength(1);
		const h = parsed?.samples[0]?.host;
		expect(h?.freeDiskMiB).toBe(51200);
		expect(h?.freeDataDiskMiB).toBe(51200);
		expect(h?.memFreePct).toBe(41);
		expect(h?.swapUsedMiB).toBe(1596);
		expect(h?.qemuCount).toBe(1);
		expect(parsed?.samples[0]?.inFile_s).toBe(240);
		expect(parsed?.samples[0]?.fileIndex).toBe(10);
	});

	test("an empty window renders rather than throwing", () => {
		const out = renderOutput(state({ samples: [] }));
		expect(out.title).toBe("no samples yet");
		expect(parsePayload(out.text)?.samples).toEqual([]);
	});

	test("failed posts are declared, so a gap in the series is attributable", () => {
		// A reader looking at a hole in the samples has to be able to tell "the host
		// stopped answering" from "the API refused our writes".
		expect(renderOutput(state({ postFailures: 3 })).summary).toContain("3 post(s) failed");
		expect(renderOutput(state()).summary).not.toContain("post(s) failed");
	});
});

describe("retention", () => {
	const many = (n: number) => Array.from({ length: n }, (_, i) => sample({ elapsed_s: i * 30 }));

	test("keeps the NEWEST samples — the ones approaching the freeze", () => {
		const parsed = parsePayload(renderOutput(state({ samples: many(MAX_SAMPLES + 50) })).text);
		expect(parsed?.samples).toHaveLength(MAX_SAMPLES);
		// Last sample retained is the last one taken; the dropped ones are the old
		// ones. Trimming the other end would throw away the only rows that matter.
		expect(parsed?.samples[parsed.samples.length - 1]?.elapsed_s).toBe((MAX_SAMPLES + 49) * 30);
		expect(parsed?.samples[0]?.elapsed_s).toBe(50 * 30);
		expect(parsed?.truncatedFrom).toBe(MAX_SAMPLES + 50);
	});

	test("an untruncated window does not claim to be truncated", () => {
		expect(parsePayload(renderOutput(state({ samples: many(5) })).text)?.truncatedFrom).toBeUndefined();
	});

	test("output.text stays inside the checks API's limit at full retention", () => {
		// The API rejects >65535 chars, and this instrument treats a rejection as a
		// warning — so blowing the limit would not fail loudly, it would silently
		// stop updating and leave the wedge unsampled. That is the failure this
		// bound exists to prevent.
		const text = renderOutput(state({ samples: many(MAX_SAMPLES) })).text;
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_TEXT_BYTES);
	});

	test("the byte budget holds even when a sample grows past what MAX_SAMPLES assumed", () => {
		// MAX_SAMPLES bounds the count, not the size: adding a field to HostSnapshot
		// silently inflates every sample. Simulated here with an oversized file name
		// so the second trim loop is what has to hold.
		const fat = Array.from({ length: MAX_SAMPLES }, (_, i) => sample({ elapsed_s: i * 30, file: "x".repeat(3000) }));
		const out = renderOutput(state({ samples: fat }));
		expect(Buffer.byteLength(out.text, "utf8")).toBeLessThanOrEqual(MAX_TEXT_BYTES);
		// And it is still parseable — a trim that produced a truncated JSON blob
		// would cost the whole window rather than its oldest part.
		expect(parsePayload(out.text)?.samples.length).toBeGreaterThan(0);
	});
});

describe("locate", () => {
	const NOW = Date.parse("2026-08-03T21:20:00.000Z");

	function checkpoint(doneFiles: number): CheckpointState {
		const planned = Array.from({ length: 12 }, (_, i) => `f${i + 1}.test.ts`);
		planned[9] = "provisioning.test.ts";
		return {
			leg: LEG,
			planned,
			startedAt: "2026-08-03T21:00:00.000Z",
			records: Array.from({ length: doneFiles }, (_, i) => ({
				file: planned[i] as string,
				index: i + 1,
				outcome: "pass",
				// Last mark at 21:16:00 — the file boundary B8b measured.
				ts: new Date(Date.parse("2026-08-03T21:00:00.000Z") + (i + 1) * 106_000).toISOString(),
			})),
		};
	}

	test("names the file the leg is INSIDE, not the last one it finished", () => {
		// The distinction this whole bite exists for. Nine files reported means the
		// leg is running the tenth — which on macos-x86 is `provisioning.test.ts`,
		// and position 10 is the condition every known wedge shares.
		const at = locate(checkpoint(9), NOW);
		expect(at?.file).toBe("provisioning.test.ts");
		expect(at?.fileIndex).toBe(10);
	});

	test("in-file depth is measured from the previous file's mark", () => {
		// B8b's live capture put the freeze 3.5-7.6 min inside the file. Depth is
		// what makes a sample comparable to that figure at all.
		const at = locate(checkpoint(9), NOW);
		expect(Math.round((NOW - (at?.startedAtMs ?? 0)) / 1000)).toBe(246);
	});

	test("before the first mark, depth runs from the checkpoint opening", () => {
		const at = locate(checkpoint(0), NOW);
		expect(at?.file).toBe("f1.test.ts");
		expect(at?.fileIndex).toBe(1);
		expect(at?.startedAtMs).toBe(Date.parse("2026-08-03T21:00:00.000Z"));
	});

	test("after the last file there is no current file", () => {
		expect(locate(checkpoint(12), NOW)).toMatchObject({ file: null, fileIndex: null });
	});

	test("an unreadable checkpoint yields undefined, so the caller keeps its last answer", () => {
		// The heartbeat reads a file another process writes. A torn read must cost
		// one sample's attribution, never the sample.
		expect(locate(undefined, NOW)).toBeUndefined();
	});

	test("a timestamp in the future is dropped rather than reported as negative depth", () => {
		const cp = checkpoint(9);
		(cp.records[8] as { ts: string }).ts = "2027-01-01T00:00:00.000Z";
		expect(locate(cp, NOW)?.startedAtMs).toBeNull();
	});
});

describe("parseCheckpoint", () => {
	const NOW = Date.parse("2026-08-03T21:20:00.000Z");
	const good = JSON.stringify({
		leg: LEG,
		planned: ["a.test.ts", "b.test.ts"],
		startedAt: "2026-08-03T21:00:00.000Z",
		records: [],
	});

	test("accepts a real checkpoint", () => {
		expect(parseCheckpoint(good)?.planned).toEqual(["a.test.ts", "b.test.ts"]);
	});

	test("a parseable but partial checkpoint is rejected, not cast", () => {
		// The whole point of the guard. This file is written by ANOTHER process
		// while the sampler reads it, so a valid-JSON-but-incomplete object is
		// reachable — and `locate()` reads `.records.length` / `.planned.length`.
		// A cast would let that throw and kill the sampler at exactly the moment
		// it is the only instrument still reporting.
		for (const bad of [
			'{"startedAt":"x","planned":["a"]}', // no records
			'{"startedAt":"x","records":[]}', // no planned
			'{"planned":["a"],"records":[]}', // no startedAt
			'{"startedAt":"x","planned":"a","records":[]}', // planned not an array
			'{"startedAt":"x","planned":[1,2],"records":[]}', // planned not strings
			'{"startedAt":1,"planned":["a"],"records":[]}', // startedAt not a string
			"[]",
			"null",
			"7",
			"not json at all",
			"",
			undefined,
		]) {
			expect(parseCheckpoint(bad)).toBeUndefined();
		}
	});

	test("locate survives every rejected shape, because it never sees one", () => {
		// The guard and its consumer, together: a rejected checkpoint reaches
		// `locate()` as `undefined`, which is the documented "keep your previous
		// answer" path rather than a throw.
		expect(() => locate(parseCheckpoint('{"startedAt":"x","planned":["a"]}'), NOW)).not.toThrow();
		expect(locate(parseCheckpoint('{"startedAt":"x","planned":["a"]}'), NOW)).toBeUndefined();
	});
});
