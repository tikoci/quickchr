import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * THROWAWAY diagnostic for a suspected Bun.spawnSync({ timeout }) bug on Windows —
 * not part of the permanent suite. Grounds a bun upstream bug report (quickchr #92)
 * before filing it, rather than reporting from a QEMU/SSH-shaped scenario that's
 * harder for a Bun maintainer to run standalone.
 *
 * Background: test/integration/provisioning.test.ts's SSH batch-login probe used
 * `Bun.spawnSync(["ssh", ...], { timeout: 20_000 })` and reproduced 3/3 as an
 * instant `exitCode: null` with empty stdout+stderr on windows-x86 CI — nowhere near
 * the timeout, no plausible network delay. Switching to async `Bun.spawn()` + a
 * manual `setTimeout`-based kill fixed it 3/3. This file isolates that from
 * quickchr/QEMU/SSH entirely to see how minimal the repro goes.
 *
 * Only meaningful on win32; runs elsewhere too (harmless, uses the OS shell) so CI
 * doesn't need an extra platform gate wired in.
 */
const SKIP = !process.env.QUICKCHR_INTEGRATION;

function run(label: string, cmd: string[], timeout: number) {
	const t0 = Date.now();
	const result = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", timeout });
	const elapsedMs = Date.now() - t0;
	const out = new TextDecoder().decode(result.stdout).trim();
	const err = new TextDecoder().decode(result.stderr).trim();
	console.log(
		`[repro:${label}] elapsedMs=${elapsedMs} exitCode=${result.exitCode} ` +
			`signalCode=${result.signalCode} success=${result.success} ` +
			`stdout=${JSON.stringify(out)} stderr=${JSON.stringify(err)}`,
	);
	return { elapsedMs, exitCode: result.exitCode, signalCode: result.signalCode, out, err };
}

describe.skipIf(SKIP)("lab: Bun.spawnSync timeout repro (throwaway, see quickchr #92)", () => {
	test("A: trivial fast command, no timeout option (control)", () => {
		const cmd = process.platform === "win32" ? ["cmd", "/c", "echo repro-ok"] : ["sh", "-c", "echo repro-ok"];
		const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
		const out = new TextDecoder().decode(r.stdout).trim();
		console.log(`[repro:A] exitCode=${r.exitCode} stdout=${JSON.stringify(out)}`);
		expect(out).toContain("repro-ok");
	});

	test("B: trivial fast command, WITH timeout option", () => {
		const cmd = process.platform === "win32" ? ["cmd", "/c", "echo repro-ok"] : ["sh", "-c", "echo repro-ok"];
		const { out, exitCode } = run("B", cmd, 5_000);
		expect(exitCode).toBe(0);
		expect(out).toContain("repro-ok");
	});

	test("C: command that sleeps ~2s then prints, WITH timeout option (well under budget)", () => {
		const cmd = process.platform === "win32"
			? ["cmd", "/c", "ping -n 3 127.0.0.1 >nul & echo repro-ok"]
			: ["sh", "-c", "sleep 2; echo repro-ok"];
		const { out, exitCode } = run("C", cmd, 10_000);
		expect(exitCode).toBe(0);
		expect(out).toContain("repro-ok");
	});

	test("D: ssh against a closed local port, WITH timeout option (mirrors the real failure)", () => {
		// No QEMU/CHR needed — port 1 has nothing listening, so ssh should fail fast
		// with a real connection-refused error, not hang. That's the closest
		// standalone analog to the actual provisioning.test.ts scenario (a real
		// network-connecting child process under spawnSync+timeout on Windows).
		const dir = mkdtempSync(join(tmpdir(), "spawnsync-repro-"));
		const emptyConfig = join(dir, "empty_ssh_config");
		Bun.write(emptyConfig, "");
		const cmd = [
			"ssh",
			"-F", emptyConfig,
			"-o", "StrictHostKeyChecking=no",
			"-o", "PasswordAuthentication=no",
			"-o", "BatchMode=yes",
			"-o", "ConnectTimeout=3",
			"nobody@127.0.0.1", "-p", "1",
			"true",
		];
		const { exitCode, signalCode, out, err } = run("D", cmd, 8_000);
		// Expect a real, fast connection-refused failure (nonzero exit, some stderr) —
		// NOT the exitCode:null/empty-output pattern from the original bug.
		console.log(`[repro:D] verdict: ${exitCode === null && !out && !err ? "REPRODUCED null/empty" : "did not reproduce"}`);
		expect(exitCode !== null || signalCode !== null).toBe(true);
	});
});
