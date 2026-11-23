/**
 * doctor-timing probe — where does `quickchr doctor --json` spend its time? (#269)
 *
 * `test/unit/cli-version-doctor.test.ts` spawns the CLI's `doctor --json` under
 * bun:test's 5 s default, and Windows runners sometimes reach 4–5 s. This
 * measures, on the runner itself:
 *
 *   cli      wall time of `bun src/cli/index.ts doctor --json`, spawned exactly as
 *            the test does (empty data dir, HOME pointed at it), N times;
 *   baseline `bun -e 0` and `bun src/cli/index.ts --help`, to split Bun
 *            startup and module loading from doctor's own work;
 *   inProcess   `QuickCHR.doctor()` in this process with Bun.spawnSync wrapped, so
 *            each child process doctor starts is timed by command line.
 *
 * Run:  bun run test/lab/doctor-timing/probe.ts --runs 15
 * Writes doctor-timing.json in the cwd and appends a summary to
 * $GITHUB_STEP_SUMMARY.
 */

import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DoctorResult } from "../../../src/lib/types.ts";

/** `--runs N` (default 15): a positive safe integer, or the probe refuses to start. */
function parseRuns(argv: string[]): number {
	if (argv.length === 0) return 15;
	const [flag, raw] = argv;
	const runs = Number(raw);
	if (argv.length !== 2 || flag !== "--runs" || raw === undefined || !/^\d+$/.test(raw)
		|| !Number.isSafeInteger(runs) || runs < 1) {
		throw new Error("Usage: probe.ts [--runs N] (N must be a positive safe integer)");
	}
	return runs;
}

const RUNS = parseRuns(process.argv.slice(2));
const ROOT = join(import.meta.dir, "../../..");
const CLI = join(ROOT, "src/cli/index.ts");
const DATA = join(tmpdir(), `doctor-timing-${process.pid}`);

async function wall(argv: string[]): Promise<{ ms: number; exit: number; stdout: string; stderr: string }> {
	rmSync(DATA, { recursive: true, force: true });
	mkdirSync(DATA, { recursive: true });
	const { QUICKCHR_ACCEL: _drop, ...env } = process.env;
	const t = performance.now();
	const proc = Bun.spawn(argv, {
		env: { ...env, QUICKCHR_DATA_DIR: DATA, NO_COLOR: "1", QUICKCHR_NO_PROMPT: "1", HOME: DATA },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exit = await proc.exited;
	return { ms: Math.round(performance.now() - t), exit, stdout, stderr };
}

/** Only include samples from a completed doctor invocation. */
function checkDoctorRun(r: { exit: number; stdout: string; stderr: string }): void {
	let doc: Partial<DoctorResult & { staleImages: unknown }> | null;
	try {
		doc = JSON.parse(r.stdout) as typeof doc;
	} catch {
		throw new Error(`doctor-timing: doctor --json printed no JSON (exit ${r.exit}): ${(r.stdout + r.stderr).slice(0, 500)}`);
	}
	if (!doc || typeof doc.ok !== "boolean" || !Array.isArray(doc.checks) || doc.checks.length === 0
		|| !doc.checks.every((check) => typeof check?.label === "string" && typeof check.detail === "string"
			&& ["ok", "warn", "error"].includes(check.status))
		|| !Array.isArray(doc.staleImages)) {
		throw new Error(`doctor-timing: invalid doctor --json result: ${r.stdout.slice(0, 500)}`);
	}
	if (r.exit !== (doc.ok ? 0 : 1)) {
		throw new Error(`doctor-timing: doctor --json said ok=${doc.ok} but exited ${r.exit}`);
	}
}

function stats(xs: number[]): { n: number; min: number; p50: number; p90: number; max: number } {
	const s = [...xs].sort((a, b) => a - b);
	const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? Number.NaN;
	return { n: s.length, min: s[0] ?? Number.NaN, p50: at(0.5), p90: at(0.9), max: s.at(-1) ?? Number.NaN };
}

const result: Record<string, unknown> = {
	env: { platform: process.platform, arch: process.arch, bun: Bun.version, image: `${process.env.ImageOS ?? "?"} ${process.env.ImageVersion ?? ""}`.trim() },
};

// ── cli: the test's own spawn, interleaved with the baselines ──
const cli: number[] = [];
const bunStart: number[] = [];
const help: number[] = [];
for (let i = 0; i < RUNS; i++) {
	const doctorRun = await wall(["bun", CLI, "doctor", "--json"]);
	checkDoctorRun(doctorRun);
	cli.push(doctorRun.ms);
	bunStart.push((await wall(["bun", "-e", "0"])).ms);
	help.push((await wall(["bun", CLI, "--help"])).ms);
}
result.cli = { doctor: { runs: cli, ...stats(cli) }, bunStartup: { runs: bunStart, ...stats(bunStart) }, help: { runs: help, ...stats(help) } };

// ── inProcess: each child process doctor starts, by command ──
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
process.env.QUICKCHR_DATA_DIR = DATA;
process.env.HOME = DATA;
const spawns: { run: number; cmd: string; ms: number; exit: number | null }[] = [];
let run = -1;
const realSpawnSync = Bun.spawnSync;
(Bun as unknown as { spawnSync: unknown }).spawnSync = (...args: Parameters<typeof Bun.spawnSync>) => {
	const first = args[0] as unknown;
	const cmd = Array.isArray(first) ? first.join(" ") : String((first as { cmd?: string[] })?.cmd?.join(" ") ?? first);
	const t = performance.now();
	const r = realSpawnSync(...args);
	spawns.push({ run, cmd, ms: Math.round(performance.now() - t), exit: r.exitCode });
	return r;
};
const importT = performance.now();
const { QuickCHR } = await import(join(ROOT, "src/lib/quickchr.ts"));
const importMs = Math.round(performance.now() - importT);
const totals: number[] = [];
for (run = 0; run < RUNS; run++) {
	const t = performance.now();
	await QuickCHR.doctor();
	totals.push(Math.round(performance.now() - t));
}
(Bun as unknown as { spawnSync: unknown }).spawnSync = realSpawnSync;

const byCmd = new Map<string, number[]>();
for (const s of spawns) byCmd.set(s.cmd, [...(byCmd.get(s.cmd) ?? []), s.ms]);
const perRunSpawnMs = totals.map((_, r) => spawns.filter((s) => s.run === r).reduce((a, s) => a + s.ms, 0));
result.inProcess = {
	importMs,
	doctor: { runs: totals, ...stats(totals) },
	spawnMsPerRun: perRunSpawnMs,
	spawnsPerRun: spawns.filter((s) => s.run === 0).length,
	byCommand: [...byCmd].map(([cmd, ms]) => ({ cmd, ...stats(ms), first: ms[0] })).sort((a, b) => b.max - a.max),
};
rmSync(DATA, { recursive: true, force: true });

writeFileSync("doctor-timing.json", `${JSON.stringify(result, null, 2)}\n`);

const c = result.cli as Record<string, ReturnType<typeof stats> & { runs: number[] }>;
const ip = result.inProcess as { importMs: number; doctor: ReturnType<typeof stats> & { runs: number[] }; spawnMsPerRun: number[]; byCommand: (ReturnType<typeof stats> & { cmd: string; first: number })[] };
const row = (name: string, s: ReturnType<typeof stats> & { runs?: number[] }) => `| ${name} | ${s.min} | ${s.p50} | ${s.p90} | ${s.max} | ${s.runs ? s.runs.join(" ") : ""} |`;
const lines = [
	`## doctor-timing — ${process.platform}/${process.arch}, Bun ${Bun.version}, ${RUNS} runs`,
	"",
	"| measure (ms) | min | p50 | p90 | max | runs in order |",
	"|---|---|---|---|---|---|",
	row("CLI `doctor --json` (as the test spawns it)", c.doctor as never),
	row("`bun -e 0`", c.bunStartup as never),
	row("CLI `--help`", c.help as never),
	row("in-process `QuickCHR.doctor()`", ip.doctor),
	`| in-process spawn time per doctor() | | | | | ${ip.spawnMsPerRun.join(" ")} |`,
	"",
	`Module import (cold): ${ip.importMs} ms`,
	"",
	"| child process | n | first | min | p50 | p90 | max |",
	"|---|---|---|---|---|---|---|",
	...ip.byCommand.map((b) => `| \`${b.cmd.replace(/\\/g, "\\\\").replace(/\|/g, "\\|")}\` | ${b.n} | ${b.first} | ${b.min} | ${b.p50} | ${b.p90} | ${b.max} |`),
	"",
];
const text = lines.join("\n");
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
