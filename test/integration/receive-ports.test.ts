import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import dgram from "node:dgram";
import type { AddressInfo } from "node:net";
import { imageTarget } from "./image-target.ts";
import { bootTestTimeout } from "./timeouts.ts";

/**
 * Integration test — receive slots (#299): two machines each send UDP to their own
 * `--receive` port, and a host listener on each port gets only its machine's datagrams.
 *
 * SLIRP rewrites the source of every gateway-relayed datagram to
 * `127.0.0.1:<ephemeral>`, so the destination port is the only label. Emitter:
 * RouterOS remote syslog pointed at the slot's `guestHost:guestPort` (the same
 * mechanism as test/lab/gateway-udp).
 *
 * Machine A is created through the CLI (`add --receive`), machine B through the
 * library (`receivePorts`), so both entry points are covered.
 */

const SKIP = !process.env.QUICKCHR_INTEGRATION;
const A = "integration-receive-a";
const B = "integration-receive-b";
const CLI = ["run", "src/cli/index.ts"];

type Listener = { socket: dgram.Socket; port: number; messages: string[] };

/** An unconnected UDP listener on loopback. Binding first guarantees the port is free. */
function listen(): Promise<Listener> {
	return new Promise((resolve, reject) => {
		const socket = dgram.createSocket("udp4");
		const messages: string[] = [];
		socket.on("message", (msg) => messages.push(msg.toString("utf8")));
		socket.once("error", reject);
		socket.bind(0, "127.0.0.1", () => resolve({ socket, port: (socket.address() as AddressInfo).port, messages }));
	});
}

async function cleanupMachine(name: string): Promise<void> {
	const { QuickCHR } = await import("../../src/lib/quickchr.ts");
	const existing = QuickCHR.get(name);
	if (!existing) return;
	try { await existing.remove(); } catch { /* ignore */ }
}

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["bun", ...CLI, ...args], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe", env: { ...process.env } });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	return { stdout, stderr, exitCode: await proc.exited };
}

describe.skipIf(SKIP)("receive slots — per-machine guest→host UDP", () => {
	let la: Listener | undefined;
	let lb: Listener | undefined;

	beforeAll(async () => {
		await cleanupMachine(A);
		await cleanupMachine(B);
	});

	afterAll(async () => {
		try { la?.socket.close(); } catch { /* ignore */ }
		try { lb?.socket.close(); } catch { /* ignore */ }
		await cleanupMachine(A);
		await cleanupMachine(B);
	});

	test("two machines stream to their own receive ports; each listener sees only its machine", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		la = await listen();
		lb = await listen();
		const target = imageTarget();

		const addRes = await runCli([
			"add", A,
			...("channel" in target ? ["--channel", target.channel] : ["--version", target.version]),
			"--receive", `syslog:${la.port}`,
			"--no-secure-login",
		]);
		if (addRes.exitCode !== 0) {
			throw new Error(`add failed (exit ${addRes.exitCode}):\nSTDOUT:\n${addRes.stdout}\nSTDERR:\n${addRes.stderr}`);
		}
		expect(QuickCHR.get(A)?.state.receivePorts).toEqual([{ name: "syslog", port: la.port, proto: "udp" }]);

		const [a, b] = await Promise.all([
			QuickCHR.start({ name: A, background: true }),
			QuickCHR.start({
				...target,
				name: B,
				background: true,
				secureLogin: false,
				receivePorts: [{ name: "syslog", port: lb.port, proto: "udp" }],
			}),
		]);

		// The descriptor is what consumers (tzsp-sniff) read.
		const da = await a.descriptor();
		const db = await b.descriptor();
		expect(da.hostGateway?.address).toBe("10.0.2.2");
		expect(da.receive?.syslog).toMatchObject({ hostPort: la.port, guestHost: "10.0.2.2", guestPort: la.port });
		expect(db.receive?.syslog).toMatchObject({ hostPort: lb.port, guestPort: lb.port });

		// Unique across machines: B cannot take A's port.
		await expect(b.addReceivePort(`other:${la.port}`)).rejects.toMatchObject({ code: "PORT_CONFLICT" });

		const nonce = Date.now().toString(36);
		for (const [chr, tag] of [[a, "A"], [b, "B"]] as const) {
			const slot = chr.receive.syslog;
			if (!slot) throw new Error(`${chr.name} has no syslog receive slot`);
			await chr.exec(`/system/logging/action/add name=qchrrx target=remote remote=${slot.guestHost} remote-port=${slot.guestPort}`);
			await chr.exec("/system/logging/add action=qchrrx topics=info");
			for (let i = 0; i < 3; i++) {
				await chr.exec(`:log info "rx-${tag}-${nonce}-${i}"`);
				await Bun.sleep(300);
			}
		}

		const deadline = Date.now() + 30_000;
		const has = (l: Listener, tag: string) => l.messages.some((m) => m.includes(`rx-${tag}-${nonce}`));
		while (Date.now() < deadline && !(has(la, "A") && has(lb, "B"))) await Bun.sleep(500);

		expect(has(la, "A")).toBe(true);
		expect(has(lb, "B")).toBe(true);
		expect(has(la, "B")).toBe(false);
		expect(has(lb, "A")).toBe(false);
	}, bootTestTimeout({ boots: 2 }));
});
