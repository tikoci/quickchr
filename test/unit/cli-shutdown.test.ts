import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function run(args: string[], timeout = "10", pid?: number) {
	const dir = mkdtempSync(join(tmpdir(), "quickchr-shutdown-"));
	dirs.push(dir);
	if (pid !== undefined) {
		const machineDir = join(dir, "machines", "fixture");
		mkdirSync(machineDir, { recursive: true });
		await Bun.write(join(machineDir, "machine.json"), JSON.stringify({
			name: "fixture", version: "6.49.23", arch: "x86", cpu: 1, mem: 512,
			networks: [], ports: {}, packages: [], portBase: 9100, excludePorts: [], extraPorts: [],
			createdAt: "2026-10-21T00:00:00.000Z", status: "running", machineDir, pid,
		}));
	}
	const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../../src/cli/index.ts"), "shutdown", ...args], {
		env: { ...process.env, QUICKCHR_DATA_DIR: dir, QUICKCHR_SHUTDOWN_TIMEOUT: timeout, NO_COLOR: "1" },
		stdout: "pipe", stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { stdout, stderr, exitCode, dir };
}

describe("shutdown CLI", () => {
	test("help is answered without resolving invalid environment settings", async () => {
		const result = await run(["--help"], "invalid");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("QUICKCHR_SHUTDOWN_TIMEOUT");
	});

	test("requires exactly one machine and rejects unsupported flags", async () => {
		for (const args of [[], ["a", "b"], ["a", "--all"], ["a", "--no-timeout"]]) {
			expect((await run(args)).exitCode).toBe(1);
		}
	});

	test("validates flag and environment before machine lookup", async () => {
		for (const args of [["absent", "--timeout"], ["absent", "--timeout", "0"], ["absent", "--timeout", "1.5"], ["absent", "--timeout", "2147484"]]) {
			const result = await run(args);
			expect(result.stderr).toContain("positive integer");
			expect(result.stderr).not.toContain("not found");
		}
		expect((await run(["absent"], "invalid")).stderr).toContain("positive integer");
	});

	test("explicit flag overrides even an invalid environment value", async () => {
		const result = await run(["absent", "--timeout", "2"], "invalid");
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain('Machine "absent" not found');
	});
});

test("CLI reports a forced power cut and reconciles state only after exit", async () => {
	const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(60_000)"], { stdout: "ignore", stderr: "ignore" });
	try {
		const result = await run(["fixture", "--timeout", "1"], "invalid", child.pid);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("forced power cut — guest shutdown not confirmed");
		expect(result.stderr).toContain("REST");
		const state = JSON.parse(readFileSync(join(result.dir, "machines", "fixture", "machine.json"), "utf8"));
		expect(state.status).toBe("stopped");
		expect(state.pid).toBeUndefined();
		expect(await Promise.race([child.exited.then(() => true), Bun.sleep(2000).then(() => false)])).toBe(true);
	} finally {
		child.kill();
		await child.exited;
	}
});
