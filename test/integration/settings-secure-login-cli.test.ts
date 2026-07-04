import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { imageTarget } from "./image-target.ts";

/**
 * Integration test — the QUICKCHR_SECURE_LOGIN setting end-to-end.
 *
 * `secure-login` is the only one of the 5 quickchr settings that changes
 * RouterOS state (whether a managed login is provisioned during boot), so per
 * testing.instructions.md it needs real-CHR coverage — the other 4 settings
 * are pre-boot/filesystem-only and are covered by test/unit/settings.test.ts.
 *
 * Drives the CLI directly (not the library) so the env-var resolution wired
 * into cmdAdd/cmdStart in src/cli/index.ts is what's actually exercised.
 */

const SKIP = !process.env.QUICKCHR_INTEGRATION;
const MACHINE = "integration-settings-secure-login";
const CLI = ["run", "src/cli/index.ts"];

function imageTargetFlags(): string[] {
	const target = imageTarget();
	return "channel" in target ? ["--channel", target.channel] : ["--version", target.version];
}

async function cleanupMachine(name: string): Promise<void> {
	const { QuickCHR } = await import("../../src/lib/quickchr.ts");
	const existing = QuickCHR.get(name);
	if (!existing) return;
	try { await existing.stop(); } catch { /* ignore */ }
	try { await existing.remove(); } catch { /* ignore */ }
}

async function runCli(args: string[], extraEnv: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["bun", ...CLI, ...args], {
		cwd: process.cwd(),
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...extraEnv },
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const exitCode = await proc.exited;
	return { stdout, stderr, exitCode };
}

describe.skipIf(SKIP)("QUICKCHR_SECURE_LOGIN setting end-to-end", () => {
	beforeAll(async () => {
		await cleanupMachine(MACHINE);
	});

	afterAll(async () => {
		await cleanupMachine(MACHINE);
	});

	test("QUICKCHR_SECURE_LOGIN=true causes 'start' with no flags to provision the managed account", async () => {
		const addRes = await runCli(["add", MACHINE, ...imageTargetFlags()]);
		if (addRes.exitCode !== 0) {
			throw new Error(`add failed (exit ${addRes.exitCode}):\nSTDOUT:\n${addRes.stdout}\nSTDERR:\n${addRes.stderr}`);
		}

		// No --secure-login flag passed — only the env var expresses the preference.
		const startRes = await runCli(["start", MACHINE], { QUICKCHR_SECURE_LOGIN: "true" });
		if (startRes.exitCode !== 0) {
			throw new Error(`start failed (exit ${startRes.exitCode}):\nSTDOUT:\n${startRes.stdout}\nSTDERR:\n${startRes.stderr}`);
		}

		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		const { getInstanceCredentials } = await import("../../src/lib/credentials.ts");
		const { QUICKCHR_USER } = await import("../../src/lib/provision.ts");
		const { restGet } = await import("../../src/lib/rest.ts");

		const instance = QuickCHR.get(MACHINE);
		expect(instance).toBeDefined();

		const creds = getInstanceCredentials(MACHINE);
		expect(creds?.user).toBe(QUICKCHR_USER);
		expect(creds?.password).toBeTruthy();

		if (!instance || !creds) throw new Error("expected a running instance with managed credentials");
		const resp = await restGet(
			`http://127.0.0.1:${instance.ports.http}/rest/system/resource`,
			`Basic ${btoa(`${creds.user}:${creds.password}`)}`,
			10_000,
		);
		expect(resp.status).toBe(200);
	}, 300_000);
});
