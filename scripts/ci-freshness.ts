#!/usr/bin/env bun
/**
 * ci-freshness — the PR "Integration freshness" gate (see ci.instructions.md).
 *
 * Integration tests do not run on PRs; they run on every push to main
 * (main.yml) except pushes touching only docs (main.yml paths-ignore, #218).
 * This gate makes that arrangement honest: a PR may only merge
 * while the latest completed integration run on main is GREEN. A red main
 * visibly blocks all PRs until someone fixes it — the failure cannot rot
 * quietly in the Actions list.
 *
 * Verdict logic (latest-first over recent completed main.yml runs on main):
 *   - skip conclusion "cancelled"/"skipped" runs (superseded pushes carry no signal)
 *   - first remaining run green  → PASS (warn if main tip is ahead of it — a
 *     newer run may still be in flight, or the newer push may have skipped
 *     integration as docs-only; merging is allowed either way)
 *   - first remaining run red    → FAIL with the run URL
 *   - no runs at all             → FAIL with a bootstrap hint
 *
 * Env: GH_REPO (owner/name), GH_TOKEN. Optional: MAIN_WORKFLOW (default
 * main.yml), MAIN_BRANCH (default main), GH_API and GH_RETRY_BASE_MS (overrides for tests),
 * GITHUB_STEP_SUMMARY (markdown verdict appended when set).
 */

const REPO = process.env.GH_REPO ?? "";
const TOKEN = process.env.GH_TOKEN ?? "";
const WORKFLOW = process.env.MAIN_WORKFLOW ?? "main.yml";
const BRANCH = process.env.MAIN_BRANCH ?? "main";
const API = process.env.GH_API ?? "https://api.github.com";
const GH_ATTEMPTS = 3;
/** Overridable only so the retry test does not sleep for seconds. */
const GH_RETRY_BASE_MS = Number(process.env.GH_RETRY_BASE_MS ?? 2000);

interface WorkflowRun {
	id: number;
	head_sha: string;
	conclusion: string | null;
	html_url: string;
	updated_at: string;
}

/** GET a GitHub API path. A 404 returns null — for the workflow-runs lookup it
 *  means the workflow has never been registered on the default branch, which is
 *  the same signal as "no runs yet" (the bootstrap verdict, not a crash).
 *
 *  A 5xx is retried, a bounded few times: a 502 is GitHub failing to answer, not
 *  an answer, and one used to fail this required check on every open PR (#151).
 *  Every other status, including a red `main`, stays exactly as decisive. */
async function gh(path: string): Promise<unknown> {
	for (let attempt = 1; ; attempt++) {
		const res = await fetch(`${API}${path}`, {
			headers: {
				Authorization: `Bearer ${TOKEN}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
		});
		if (res.status >= 500 && attempt < GH_ATTEMPTS) {
			console.error(`ci-freshness: GET ${path} → HTTP ${res.status}, retrying (${attempt}/${GH_ATTEMPTS})`);
			await Bun.sleep(attempt * GH_RETRY_BASE_MS);
			continue;
		}
		if (res.status === 404) return null;
		if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}`);
		return res.json();
	}
}

export interface Verdict {
	ok: boolean;
	message: string;
	run?: WorkflowRun;
}

/** Pure verdict from a latest-first run list + the branch tip sha. */
export function evaluateFreshness(runs: WorkflowRun[], tipSha: string): Verdict {
	const signal = runs.filter(
		(r) => r.conclusion !== "cancelled" && r.conclusion !== "skipped",
	);
	const latest = signal[0];
	if (!latest) {
		return {
			ok: false,
			message:
				`no completed integration run found on ${BRANCH} — bootstrap by dispatching ` +
				`${WORKFLOW} (or push to ${BRANCH}) and let it finish green once`,
		};
	}
	if (latest.conclusion !== "success") {
		return {
			ok: false,
			run: latest,
			message:
				`${BRANCH} integration is RED (${latest.conclusion}) at ${latest.head_sha.slice(0, 7)} — ` +
				`fix ${BRANCH} first (or ground the failure via a targeted integration.yml dispatch): ${latest.html_url}`,
		};
	}
	const stale = tipSha !== "" && latest.head_sha !== tipSha;
	return {
		ok: true,
		run: latest,
		message:
			`${BRANCH} integration is green at ${latest.head_sha.slice(0, 7)}: ${latest.html_url}` +
			(stale
				? ` — note: ${BRANCH} tip ${tipSha.slice(0, 7)} is newer than the last completed run`
				: ""),
	};
}

async function main(): Promise<void> {
	if (!REPO || !TOKEN) {
		console.error("ci-freshness: GH_REPO and GH_TOKEN are required");
		process.exit(2);
	}
	const runsResp = (await gh(
		`/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?branch=${BRANCH}&status=completed&per_page=10`,
	)) as { workflow_runs: WorkflowRun[] } | null;
	const branchResp = (await gh(`/repos/${REPO}/branches/${BRANCH}`)) as {
		commit: { sha: string };
	} | null;

	const verdict = evaluateFreshness(
		runsResp?.workflow_runs ?? [],
		branchResp?.commit.sha ?? "",
	);

	const line = `Integration freshness: ${verdict.ok ? "PASS" : "FAIL"} — ${verdict.message}`;
	console.log(line);
	const summary = process.env.GITHUB_STEP_SUMMARY;
	if (summary) {
		await Bun.write(
			summary,
			`${(await Bun.file(summary).text().catch(() => "")) ?? ""}\n## Integration freshness\n\n${verdict.ok ? "✅" : "❌"} ${verdict.message}\n`,
		);
	}
	process.exit(verdict.ok ? 0 : 1);
}

if (import.meta.main) {
	await main();
}
