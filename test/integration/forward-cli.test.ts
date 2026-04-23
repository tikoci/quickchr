import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createConnection } from "node:net";

/**
 * Integration test — `quickchr add --forward smb` end-to-end.
 *
 * Verifies that:
 *  1. `quickchr add --forward smb` records an `smb` extra port in machine state
 *     with guest=445/tcp and a non-zero auto-allocated host port.
 *  2. After `start` (background), the host-side hostfwd port accepts a TCP
 *     connect (QEMU SLiRP accepts the connect even though no guest service
 *     listens — this proves the forward is wired into the QEMU command line).
 *
 * Drives the CLI directly via `bun run src/cli/index.ts` to exercise the
 * argv-parsing path that real users hit.
 */

const SKIP = !process.env.QUICKCHR_INTEGRATION;
const MACHINE = "integration-forward-cli";
const CLI = ["run", "src/cli/index.ts"];

async function cleanupMachine(name: string): Promise<void> {
	const { QuickCHR } = await import("../../src/lib/quickchr.ts");
	const existing = QuickCHR.get(name);
	if (!existing) return;
	try { await existing.stop(); } catch { /* ignore */ }
	try { await existing.remove(); } catch { /* ignore */ }
}

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["bun", ...CLI, ...args], {
		cwd: process.cwd(),
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env },
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const exitCode = await proc.exited;
	return { stdout, stderr, exitCode };
}

function tcpConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection({ host, port });
		const timer = setTimeout(() => {
			socket.destroy();
			resolve(false);
		}, timeoutMs);
		socket.once("connect", () => {
			clearTimeout(timer);
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => {
			clearTimeout(timer);
			resolve(false);
		});
	});
}

describe.skipIf(SKIP)("CLI --forward flag end-to-end", () => {
	beforeAll(async () => {
		await cleanupMachine(MACHINE);
	});

	afterAll(async () => {
		await cleanupMachine(MACHINE);
	});

	test("`add --forward smb` records mapping, `start` exposes hostfwd", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");

		// 1. Create the machine via CLI with a single short-form forward.
		const addRes = await runCli(["add", MACHINE, "--forward", "smb"]);
		if (addRes.exitCode !== 0) {
			throw new Error(`add failed (exit ${addRes.exitCode}):\nSTDOUT:\n${addRes.stdout}\nSTDERR:\n${addRes.stderr}`);
		}

		// 2. Read state and assert the smb mapping is present and well-formed.
		const machine = QuickCHR.get(MACHINE);
		expect(machine).toBeDefined();
		const state = machine?.state;
		expect(state).toBeDefined();
		const smb = state?.ports?.smb;
		expect(smb).toBeDefined();
		expect(smb?.guest).toBe(445);
		expect(smb?.proto).toBe("tcp");
		expect(typeof smb?.host).toBe("number");
		expect(smb?.host).toBeGreaterThan(0);
		const smbHostPort = smb?.host as number;

		// Also assert config.extraPorts captured the user request.
		const extra = state?.extraPorts ?? [];
		expect(extra.some((p: { name: string; guest: number }) => p.name === "smb" && p.guest === 445)).toBe(true);

		// 3. Boot the machine (background). Use library directly to get an
		//    instance handle so cleanup is reliable; CLI `start` would also work
		//    but the library path lets us await boot completion cleanly.
		const instance = await QuickCHR.start({ name: MACHINE, background: true });

		try {
			// 4. Verify host-side hostfwd port accepts TCP. SLiRP completes the
			//    host-side handshake immediately even with nothing listening on
			//    the guest, so a successful connect proves the forward is wired.
			const ok = await tcpConnect("127.0.0.1", smbHostPort, 5_000);
			expect(ok).toBe(true);
		} finally {
			try { await instance.stop(); } catch { /* ignore */ }
		}
	}, 300_000);
});
