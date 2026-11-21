import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createConnection } from "node:net";
import { imageTarget } from "./image-target.ts";
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
		const target = imageTarget();
		const addRes = await runCli([
			"add", MACHINE, "--forward", "smb",
			...("channel" in target ? ["--channel", target.channel] : ["--version", target.version]),
		]);
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

type Answer = { text: string; reason: "line" | "close" | "refused" | "error" | "timeout" };

/** Who answers on a port: read an unsolicited greeting if one comes (QEMU's monitor
 *  sends a "QEMU …" banner on connect), otherwise send one HTTP request, and settle once
 *  on the first complete line, a close, an error or the timeout. The reason tells a
 *  refused port from an accepted-but-silent one.
 *
 *  Deliberately not `chrGet()`: the question is *who* answers — RouterOS's web server
 *  or one of QEMU's own sockets — which an HTTP client would only report as a parse
 *  error. Nothing is written to a port that greets first, so the monitor gets no input. */
function whoAnswers(port: number, timeoutMs: number): Promise<Answer> {
	return new Promise((resolve) => {
		let text = "";
		let settled = false;
		const socket = createConnection({ host: "127.0.0.1", port });
		const settle = (reason: Answer["reason"]) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(greetWait);
			socket.destroy();
			resolve({ text: text.slice(0, 200), reason });
		};
		const timer = setTimeout(() => settle("timeout"), timeoutMs);
		let greetWait: ReturnType<typeof setTimeout> | undefined;
		socket.once("connect", () => {
			greetWait = setTimeout(() => {
				if (!text) socket.write("GET / HTTP/1.0\r\nHost: chr\r\n\r\n");
			}, 1_000);
		});
		socket.on("data", (d: Buffer) => {
			text += d.toString("utf8");
			if (text.includes("\n")) settle("line");
		});
		socket.once("close", () => settle("close"));
		socket.once("error", (e: NodeJS.ErrnoException) => settle(e.code === "ECONNREFUSED" ? "refused" : "error"));
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
		const { parseUsernetTable } = await import("../../src/lib/diagnostics.ts");
		const names = ["ipc6", "ipc7", "ipc8"];
		const extraPorts = names.map((name) => ({ name, host: 0, guest: 80, proto: "tcp" as const }));
		const instance = await QuickCHR.start({ ...imageTarget(), name: NAME, background: true, extraPorts });
		try {
			const base = instance.state.portBase;
			const hosts = names.map((name) => instance.state.ports[name]?.host);
			// The premise: automatic extras take +6, +7, +8 of the block.
			expect(hosts).toEqual([base + 6, base + 7, base + 8]);

			// QEMU itself has all three forwards, whatever answers on the ports.
			// On Windows the FD column is a hex socket handle — the probe found the parser
			// dropping those rows (diagnostics.ts).
			const usernet = parseUsernetTable(await monitorCommand(instance.state.machineDir, "info usernet", 5_000, base));
			for (const host of hosts) {
				expect(usernet.some((r) => r.proto === "TCP" && r.state === "HOST_FORWARD" && r.srcPort === host && r.dstPort === 80)).toBe(true);
			}

			const answers: Answer[] = [];
			for (const host of hosts) answers.push(await whoAnswers(host as number, 5_000));
			const monitor = await monitorCommand(instance.state.machineDir, "info status", 5_000, base);
			console.log(`[#57 probe] platform=${process.platform} portBase=${base}`);
			for (const [i, a] of answers.entries()) console.log(`[#57 probe] ${names[i]} (+${6 + i}): ${a.reason} ${JSON.stringify(a.text)}`);
			console.log(`[#57 probe] monitor "info status": ${JSON.stringify(monitor.slice(0, 200))}`);
			expect(monitor).toContain("VM status: running");

			if (process.platform === "win32") {
				// Known #57 behaviour, asserted exactly so a different failure is not
				// mistaken for it: QEMU's monitor greets on +6 before any request. When
				// #57 moves extras off +6..+8 this goes red: delete this branch so Windows
				// takes the assertions below like everyone else.
				expect(answers[0]?.reason).toBe("line");
				expect(answers[0]?.text).toStartWith("QEMU ");
				expect(answers[0]?.text).toContain("monitor");
				return;
			}
			for (const a of answers) {
				expect(a.reason).toBe("line");
				expect(a.text).toStartWith("HTTP/1.");
			}
		} finally {
			try { await instance.stop(); } catch { /* ignore */ }
		}
	}, bootTestTimeout());
});
