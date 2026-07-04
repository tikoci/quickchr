import { describe, expect, test } from "bun:test";
import { evaluateFreshness } from "../../scripts/ci-freshness.ts";

// Anchor tests for the PR "Integration freshness" gate verdict logic
// (scripts/ci-freshness.ts). The gate's contract: PRs merge only while the
// latest signal-bearing integration run on main is green.

function run(over: Partial<{ id: number; head_sha: string; conclusion: string | null; html_url: string; updated_at: string }> = {}) {
	return {
		id: 1,
		head_sha: "a".repeat(40),
		conclusion: "success",
		html_url: "https://example.test/run/1",
		updated_at: "2026-07-04T00:00:00Z",
		...over,
	};
}

describe("evaluateFreshness", () => {
	test("green latest run → PASS", () => {
		const v = evaluateFreshness([run()], "a".repeat(40));
		expect(v.ok).toBe(true);
		expect(v.message).toContain("green");
	});

	test("red latest run → FAIL with run URL", () => {
		const v = evaluateFreshness([run({ conclusion: "failure" })], "a".repeat(40));
		expect(v.ok).toBe(false);
		expect(v.message).toContain("RED");
		expect(v.message).toContain("https://example.test/run/1");
	});

	test("no runs at all → FAIL with bootstrap hint", () => {
		const v = evaluateFreshness([], "a".repeat(40));
		expect(v.ok).toBe(false);
		expect(v.message).toContain("bootstrap");
	});

	test("cancelled runs carry no signal — skipped over to the next real run", () => {
		const v = evaluateFreshness(
			[run({ id: 3, conclusion: "cancelled" }), run({ id: 2, conclusion: "success" })],
			"a".repeat(40),
		);
		expect(v.ok).toBe(true);
		expect(v.run?.id).toBe(2);
	});

	test("only cancelled/skipped runs → treated as no signal → FAIL", () => {
		const v = evaluateFreshness(
			[run({ conclusion: "cancelled" }), run({ id: 2, conclusion: "skipped" })],
			"a".repeat(40),
		);
		expect(v.ok).toBe(false);
		expect(v.message).toContain("bootstrap");
	});

	test("green but main tip is newer → PASS with in-flight note", () => {
		const v = evaluateFreshness([run()], "b".repeat(40));
		expect(v.ok).toBe(true);
		expect(v.message).toContain("still in flight");
	});

	test("red run older than a cancelled one still FAILS (cancel does not launder a red)", () => {
		const v = evaluateFreshness(
			[run({ id: 3, conclusion: "cancelled" }), run({ id: 2, conclusion: "failure" })],
			"a".repeat(40),
		);
		expect(v.ok).toBe(false);
		expect(v.run?.id).toBe(2);
	});
});
