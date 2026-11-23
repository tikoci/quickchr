/**
 * windows-arm64-qemu probe — does choco's QEMU run on a Windows ARM64 runner? (#305)
 *
 * The first `platforms=windows-arm64` dispatch (run 45220931492) installed choco's
 * QEMU 11.1.0 (an x64 build, run under Windows' x64 emulation) and every boot failed
 * with "QEMU exited immediately" and no error text. This runs QEMU with growing argv,
 * each for a few seconds, and records how it ended: still running (killed by us),
 * or its full exit code (a Windows NTSTATUS like 0xC000001D shows up here, where
 * bash would truncate it to 8 bits).
 *
 * Run (Windows, QEMU in C:\Program Files\qemu): bun run test/lab/windows-arm64-qemu/probe.ts
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const DIR = process.env.QEMU_DIR ?? "C:\\Program Files\\qemu";
const A64 = join(DIR, "qemu-system-aarch64.exe");
const X64 = join(DIR, "qemu-system-x86_64.exe");
const CODE = join(DIR, "share", "edk2-aarch64-code.fd");

const cases: { name: string; argv: string[] }[] = [
	{ name: "aarch64 --version", argv: [A64, "--version"] },
	{ name: "aarch64 -M none", argv: [A64, "-M", "none", "-display", "none", "-nodefaults"] },
	{ name: "aarch64 -M virt tcg, no firmware", argv: [A64, "-M", "virt", "-cpu", "cortex-a710", "-accel", "tcg", "-m", "256", "-display", "none", "-nodefaults"] },
	{ name: "aarch64 -M virt tcg tb-size=256", argv: [A64, "-M", "virt", "-cpu", "cortex-a710", "-accel", "tcg,tb-size=256", "-m", "512", "-display", "none", "-nodefaults"] },
	{ name: "aarch64 -M virt tcg + edk2 code", argv: [A64, "-M", "virt", "-cpu", "cortex-a710", "-accel", "tcg,tb-size=256", "-m", "512", "-display", "none", "-nodefaults", "-drive", `if=pflash,format=raw,readonly=on,unit=0,file=${CODE}`] },
	{ name: "aarch64 -M virt tcg -cpu max", argv: [A64, "-M", "virt", "-cpu", "max", "-accel", "tcg", "-m", "256", "-display", "none", "-nodefaults"] },
	{ name: "aarch64 -M virt tcg thread=single", argv: [A64, "-M", "virt", "-cpu", "cortex-a710", "-accel", "tcg,thread=single", "-m", "256", "-display", "none", "-nodefaults"] },
	{ name: "x86_64 -M pc tcg", argv: [X64, "-M", "pc", "-accel", "tcg", "-m", "256", "-display", "none", "-nodefaults"] },
	{ name: "x86_64 -M pc tcg tb-size=256", argv: [X64, "-M", "pc", "-accel", "tcg,tb-size=256", "-m", "512", "-display", "none", "-nodefaults"] },
];

const rows: string[] = [];
for (const c of cases) {
	const t = performance.now();
	const proc = Bun.spawn(c.argv, { stdout: "pipe", stderr: "pipe" });
	const quick = c.argv.includes("--version");
	const timer = setTimeout(() => proc.kill(), quick ? 15_000 : 8_000);
	const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	clearTimeout(timer);
	const ms = Math.round(performance.now() - t);
	const killed = proc.signalCode !== null || (!quick && ms >= 7_900);
	const hex = code !== null && code < 0 ? `0x${(code >>> 0).toString(16).toUpperCase()}` : code !== null && code > 255 ? `0x${code.toString(16).toUpperCase()}` : String(code);
	const text = `${out}${err}`.replace(/\s+/g, " ").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").trim().slice(0, 200);
	const verdict = quick ? (code === 0 ? "ok" : `exit ${hex}`) : killed ? "ran until killed (ok)" : `exited after ${ms} ms, code ${hex}`;
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
