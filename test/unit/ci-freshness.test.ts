import { describe, expect, test } from "bun:test";
import { join } from "node:path";
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

	test("green but main tip is newer → PASS with newer-tip note", () => {
		const v = evaluateFreshness([run()], "b".repeat(40));
		expect(v.ok).toBe(true);
		expect(v.message).toContain("newer than the last completed run");
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

describe("GitHub API 5xx is retried, a bounded few times (#151)", () => {
	const SCRIPT = join(import.meta.dir, "../../scripts/ci-freshness.ts");
	const SHA = "b".repeat(40);

	/** Runs the gate against a local stand-in for the API whose runs endpoint
	 *  answers with `statuses` in order (then keeps repeating the last one). */
	async function gate(statuses: number[]) {
		let calls = 0;
		const server = Bun.serve({
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				if (url.pathname.endsWith("/branches/main")) return Response.json({ commit: { sha: SHA } });
				const status = statuses[Math.min(calls++, statuses.length - 1)] ?? 200;
				if (status !== 200) return new Response("bad gateway", { status });
				return Response.json({ workflow_runs: [run({ head_sha: SHA })] });
			},
		});
		try {
			const proc = Bun.spawn(["bun", SCRIPT], {
				env: { ...process.env, GH_REPO: "o/r", GH_TOKEN: "t", GH_API: `http://127.0.0.1:${server.port}`, GH_RETRY_BASE_MS: "1", GITHUB_STEP_SUMMARY: "" },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
			return { stdout, stderr, exitCode, calls };
		} finally {
			server.stop(true);
		}
	}

	test("a 502 followed by an answer is the answer", async () => {
		const result = await gate([502, 200]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Integration freshness: PASS");
		expect(result.stderr).toContain("HTTP 502, retrying (1/3)");
		expect(result.calls).toBe(2);
	});

	test("a persistent 5xx still fails the gate after three attempts", async () => {
		const result = await gate([503]);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("HTTP 503");
		expect(result.calls).toBe(3);
	});

	test("a 4xx is not retried", async () => {
		const result = await gate([403]);
		expect(result.exitCode).not.toBe(0);
		expect(result.calls).toBe(1);
	});
});
