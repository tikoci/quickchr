import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createConnection } from "node:net";
import { bootTestTimeout } from "./timeouts.ts";

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
	}, bootTestTimeout());
});

/** Send one HTTP request over a raw socket and return whatever answers first.
 *  Deliberately not `chrGet()`: the question is *who* answers on the port — RouterOS's
 *  web server or one of QEMU's own sockets (the monitor greets with a "QEMU …" banner,
 *  which an HTTP client would only report as a parse error). */
function firstBytes(port: number, timeoutMs: number): Promise<string> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		const socket = createConnection({ host: "127.0.0.1", port });
		const done = () => {
			clearTimeout(timer);
			socket.destroy();
			resolve(Buffer.concat(chunks).toString("utf8").slice(0, 200));
		};
		const timer = setTimeout(done, timeoutMs);
		socket.once("connect", () => socket.write("GET / HTTP/1.0\r\nHost: chr\r\n\r\n"));
		socket.on("data", (d: Buffer) => {
			chunks.push(d);
			if (Buffer.concat(chunks).length > 64) done();
		});
		socket.once("close", done);
		socket.once("error", done);
	});
}

/**
 * Automatic forwards take offsets +6, +7, +8 of the port block. On Windows those are
 * also QEMU's monitor, serial and QGA TCP sockets (#57), and Windows lets both bind
 * the same port, so nothing fails at startup. This checks who actually answers on each
 * forward, and that quickchr still reaches its own monitor.
 *
 * Grounded on windows-latest, QEMU 11.1.0 (integration.yml run 44915869197): QEMU's
 * sockets win. +6 answers with the monitor banner, +7 is the guest's serial console
 * (the request is typed in as a login), +8 is silent. Linux and macOS (Unix sockets for
 * IPC) reach RouterOS on all three.
 */
describe.skipIf(SKIP)("automatic forwards on the Windows IPC offsets (#57)", () => {
	const NAME = "integration-forward-ipc";

	beforeAll(async () => { await cleanupMachine(NAME); });
	afterAll(async () => { await cleanupMachine(NAME); });

	test("each forward at +6..+8 reaches the guest's web server, and the monitor still answers", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		const { monitorCommand } = await import("../../src/lib/channels.ts");
		const extraPorts = ["ipc6", "ipc7", "ipc8"].map((name) => ({ name, host: 0, guest: 80, proto: "tcp" as const }));
		const instance = await QuickCHR.start({ name: NAME, background: true, extraPorts });
		try {
			const base = instance.state.portBase;
			const answers: Record<string, string> = {};
			for (const name of ["ipc6", "ipc7", "ipc8"]) {
				const host = instance.state.ports[name]?.host as number;
				answers[`${name} (${host}, +${host - base})`] = await firstBytes(host, 5_000);
			}
			const monitor = await monitorCommand(instance.state.machineDir, "info status", 5_000, base).catch((e: unknown) => `ERROR: ${e}`);
			console.log(`[#57 probe] platform=${process.platform} portBase=${base}`);
			for (const [k, v] of Object.entries(answers)) console.log(`[#57 probe] ${k}: ${JSON.stringify(v)}`);
			console.log(`[#57 probe] monitor "info status": ${JSON.stringify(monitor.slice(0, 200))}`);
			expect(monitor).toContain("running");
			if (process.platform === "win32") {
				// Known #57 behaviour, asserted exactly so a different failure is not
				// mistaken for it. When #57 moves extras off +6..+8 this goes red: delete
				// this branch so Windows takes the assertion below like everyone else.
				const at6 = Object.entries(answers).find(([k]) => k.endsWith("+6)"))?.[1] ?? "";
				expect(at6).toStartWith("QEMU ");
				expect(at6).toContain("monitor");
				return;
			}
			for (const v of Object.values(answers)) expect(v).toStartWith("HTTP/1.");
		} finally {
			try { await instance.stop(); } catch { /* ignore */ }
		}
	}, bootTestTimeout());
});
