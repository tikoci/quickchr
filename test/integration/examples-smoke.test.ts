import { afterAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { QuickCHR } from "../../src/index.ts";
import { runExample } from "../../examples/lib.ts";

/**
 * examples-smoke — runs a CURATED SUBSET of the runnable examples end-to-end.
 *
 * Purpose: catch drift the cheap gate (tsc/biome/shellcheck/validate-examples)
 * can't — CLI flags, env, exit codes, cleanup — by actually executing one
 * representative of each language plus an intentional failure-path case.
 *
 * Gated by QUICKCHR_INTEGRATION (needs QEMU). In CI this runs in extended
 * verification, not the per-push pipeline. `trial-license` is intentionally
 * EXCLUDED (MikroTik rate-limits). Filter with EXAMPLE_FILTER="quickstart,rollback".
 */

// Double-gated: needs QEMU (QUICKCHR_INTEGRATION) AND an explicit opt-in
// (EXAMPLES_SMOKE), so the normal/gating integration run doesn't pay for these
// extra boots. `bun run smoke:examples` and the verify-extended job set both.
const SKIP = !process.env.QUICKCHR_INTEGRATION || !process.env.EXAMPLES_SMOKE;
const REPO = resolve(import.meta.dir, "..", "..");
// CLI scripts resolve $QUICKCHR — point them at THIS checkout's source CLI.
const QUICKCHR_ENV = { QUICKCHR: `bun run ${resolve(REPO, "src/cli/index.ts")}` };

const FILTER = (process.env.EXAMPLE_FILTER ?? "")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);
const want = (name: string) => FILTER.length === 0 || FILTER.includes(name);

interface Runnable {
	name: string;
	lang: "ts" | "sh" | "py";
	cmd: string[];
	env?: Record<string, string>;
}

// One representative per language. Kept small — each entry boots a real CHR.
const RUNNABLE: Runnable[] = [
	{ name: "quickstart", lang: "ts", cmd: ["bun", "run", "examples/quickstart/quickstart.ts"] },
	{ name: "rollback", lang: "ts", cmd: ["bun", "run", "examples/rollback/rollback.ts"] },
	{ name: "quickstart-sh", lang: "sh", cmd: ["sh", "examples/quickstart/quickstart.sh"], env: QUICKCHR_ENV },
	{ name: "mndp-py", lang: "py", cmd: ["python3", "examples/mndp/mndp.py", "--timeout", "45"], env: QUICKCHR_ENV },
];

async function run(cmd: string[], env: Record<string, string> = {}) {
	const proc = Bun.spawn(cmd, {
		cwd: REPO,
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, errOut, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, out, errOut };
}

describe.skipIf(SKIP)("examples smoke", () => {
	afterAll(async () => {
		// Safety net: reap any example machines left behind by a failed run.
		for (const state of QuickCHR.list()) {
			if (state.name.startsWith("examples-")) {
				try {
					await QuickCHR.get(state.name)?.remove();
				} catch {
					/* ignore */
				}
			}
		}
	});

	for (const r of RUNNABLE) {
		test.skipIf(!want(r.name))(
			`${r.name} (${r.lang}) runs clean`,
			async () => {
				const { code, out, errOut } = await run(r.cmd, r.env);
				if (code !== 0) console.error(`[${r.name}] exit ${code}\n${errOut}`);
				expect(code).toBe(0);
				expect(out.length).toBeGreaterThan(0);
			},
			360_000,
		);
	}

	// The case that actually matters: a body that throws AFTER the VM is created
	// must still tear the machine down (runExample's finally), not strand it.
	test.skipIf(!want("failure-path"))(
		"teardown fires even when an example throws after VM creation",
		async () => {
			const name = `examples-smoke-fail-${Date.now().toString(36)}`;
			await runExample(async (track) => {
				track(
					await QuickCHR.start({ name, channel: "stable", secureLogin: false, mem: 256 }),
				);
				throw new Error("intentional failure after VM creation");
			});
			// runExample swallowed the throw and set exitCode=1 — reset it so this
			// test's own process doesn't inherit the failure.
			expect(process.exitCode).toBe(1);
			process.exitCode = 0;

			// The machine must be gone despite the thrown error.
			expect(QuickCHR.get(name)).toBeNull();
		},
		360_000,
	);

	// After the curated runs, no example machines should remain.
	test.skipIf(FILTER.length > 0)("no examples-* machines left behind", () => {
		const leftovers = QuickCHR.list()
			.map((i) => i.name)
			.filter((n) => n.startsWith("examples-"));
		expect(leftovers).toEqual([]);
	});
});
