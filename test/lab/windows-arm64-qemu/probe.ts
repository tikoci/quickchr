/**
 * windows-arm64-qemu probe — does choco's QEMU run on a Windows ARM64 runner? (#305)
 *
 * The first `platforms=windows-arm64` dispatch (run 45220931492) installed choco's
 * QEMU 11.1.0 (an x64 build, run under Windows' x64 emulation) and every boot failed
 * with "QEMU exited immediately" and no error text. This runs QEMU with growing argv,
 * each for a few seconds, and records how it ended: still running at the deadline
 * (killed by the helper), or its full 32-bit exit status. Each case goes through
 * run-case.ps1 (.NET Process) because Bun reports only the low byte of a Windows
 * exit status: an NTSTATUS like 0xC000001D reads as 29, and 0xC0000005 as 5.
 *
 * Run (Windows, pwsh on PATH, QEMU in C:\Program Files\qemu):
 *   bun run test/lab/windows-arm64-qemu/probe.ts
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const DIR = process.env.QEMU_DIR ?? "C:\\Program Files\\qemu";
const A64 = join(DIR, "qemu-system-aarch64.exe");
const X64 = join(DIR, "qemu-system-x86_64.exe");
const CODE = join(DIR, "share", "edk2-aarch64-code.fd");
const HELPER = join(import.meta.dir, "run-case.ps1");
// QEMU -drive option values escape a literal comma by doubling it.
const codeOption = CODE.replaceAll(",", ",,");

const cases: { name: string; argv: string[] }[] = [
	{ name: "aarch64 --version", argv: [A64, "--version"] },
	{ name: "aarch64 -M none", argv: [A64, "-M", "none", "-display", "none", "-nodefaults"] },
	{ name: "aarch64 -M virt tcg, no firmware", argv: [A64, "-M", "virt", "-cpu", "cortex-a710", "-accel", "tcg", "-m", "256", "-display", "none", "-nodefaults"] },
	{ name: "aarch64 -M virt tcg tb-size=256", argv: [A64, "-M", "virt", "-cpu", "cortex-a710", "-accel", "tcg,tb-size=256", "-m", "512", "-display", "none", "-nodefaults"] },
	{ name: "aarch64 -M virt tcg + edk2 code", argv: [A64, "-M", "virt", "-cpu", "cortex-a710", "-accel", "tcg,tb-size=256", "-m", "512", "-display", "none", "-nodefaults", "-drive", `if=pflash,format=raw,readonly=on,unit=0,file=${codeOption}`] },
	{ name: "aarch64 -M virt tcg -cpu max", argv: [A64, "-M", "virt", "-cpu", "max", "-accel", "tcg", "-m", "256", "-display", "none", "-nodefaults"] },
	{ name: "aarch64 -M virt tcg thread=single", argv: [A64, "-M", "virt", "-cpu", "cortex-a710", "-accel", "tcg,thread=single", "-m", "256", "-display", "none", "-nodefaults"] },
	{ name: "x86_64 -M pc tcg", argv: [X64, "-M", "pc", "-accel", "tcg", "-m", "256", "-display", "none", "-nodefaults"] },
	{ name: "x86_64 -M pc tcg tb-size=256", argv: [X64, "-M", "pc", "-accel", "tcg,tb-size=256", "-m", "512", "-display", "none", "-nodefaults"] },
];

interface CaseResult {
	killedAtDeadline: boolean;
	exitCode: number;
	ms: number;
	output: string;
}

const rows: string[] = [];
for (const c of cases) {
	const quick = c.argv.includes("--version");
	const timeoutMs = quick ? 15_000 : 8_000;
	const [file, ...args] = c.argv;
	const proc = Bun.spawn(["pwsh", "-NoProfile", "-NonInteractive", "-File", HELPER], {
		env: { ...process.env, PROBE_CASE: JSON.stringify({ file, args, timeoutMs }) },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, helperExit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	let r: CaseResult;
	try {
		if (helperExit !== 0) throw new Error("PowerShell helper failed");
		r = JSON.parse(out) as CaseResult;
		if (!r || typeof r.killedAtDeadline !== "boolean" || !Number.isInteger(r.exitCode)
			|| !Number.isFinite(r.ms) || typeof r.output !== "string") {
			throw new Error("PowerShell helper returned an invalid result");
		}
	} catch {
		const why = `${out}${err}`.replace(/\s+/g, " ").trim().slice(0, 200);
		rows.push(`| ${c.name} | helper failed (exit ${helperExit}) | ${why.replace(/\\/g, "\\\\").replace(/\|/g, "\\|")} |`);
		console.log(`${c.name}: helper failed (exit ${helperExit}) ${why}`);
		process.exitCode = 1;
		continue;
	}
	const text = r.output.replace(/\s+/g, " ").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").trim().slice(0, 200);
	const statusHex = (r.exitCode >>> 0).toString(16).toUpperCase().padStart(8, "0");
	const verdict = r.killedAtDeadline
		? `still running at ${timeoutMs / 1000} s, killed`
		: `exited after ${r.ms} ms, status 0x${statusHex} (${r.exitCode})`;
	rows.push(`| ${c.name} | ${verdict} | ${text} |`);
	console.log(`${c.name}: ${verdict} ${text}`);
}
const summary = [
	`## windows-arm64-qemu — ${process.platform}/${process.arch}, Bun ${Bun.version}`,
	"",
	"| case | result | output |",
	"|---|---|---|",
	...rows,
	"",
].join("\n");
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
