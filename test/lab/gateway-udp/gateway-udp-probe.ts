/**
 * gateway-udp-probe — verify guest→host UDP via the SLIRP gateway (10.0.2.2)
 * with NO hostfwd and NO extra NIC.
 *
 * Claim under test (from issue #18): a CHR with only the default `user` NIC can
 * send UDP to the QEMU user-mode gateway `10.0.2.2:<port>` and reach a host
 * process bound (unconnected) on loopback `<port>` — with no port forward.
 *
 * Emitter: RouterOS remote syslog. We point a logging action at 10.0.2.2:<port>
 * and emit `:log info "<nonce>"`; the host's unconnected UDP socket should
 * receive an RFC3164 syslog datagram containing the nonce.
 *
 * Run:
 *   QUICKCHR_INTEGRATION=1 bun test/lab/gateway-udp/gateway-udp-probe.ts
 */

import dgram from "node:dgram";
import type { AddressInfo } from "node:net";
import { QuickCHR } from "../../../src/index.ts";

const CHR_ARCH = process.arch === "arm64" ? ("arm64" as const) : ("x86" as const);
const CHANNEL = (process.env.QUICKCHR_TEST_TARGET || "stable") as "stable";
const NONCE = `gw-probe-${Date.now().toString(36)}`;

async function main() {
	// 1. Host UDP socket — bound, UNCONNECTED (recvfrom). 0.0.0.0 so we accept the
	//    gateway-relayed datagram regardless of which loopback address SLIRP uses.
	const sock = dgram.createSocket("udp4");
	const received: { from: string; text: string }[] = [];
	sock.on("message", (msg, rinfo) => {
		received.push({ from: `${rinfo.address}:${rinfo.port}`, text: msg.toString("utf8") });
	});
	const port: number = await new Promise((res) => {
		sock.bind(0, "0.0.0.0", () => res((sock.address() as AddressInfo).port));
	});
	console.log(`[host] unconnected UDP socket bound on 0.0.0.0:${port}`);

	let instance: Awaited<ReturnType<typeof QuickCHR.start>> | undefined;
	try {
		// 2. Boot CHR with the DEFAULT single user NIC — no extra NIC, no forward.
		instance = await QuickCHR.start({
			name: "gateway-udp-probe",
			channel: CHANNEL,
			arch: CHR_ARCH,
			background: true,
			secureLogin: false,
			cpu: 1,
			mem: 256,
		});
		const booted = await instance.waitForBoot(180_000);
		console.log(`[chr] booted=${booted} gateway=${instance.tzspGatewayIp} capture=${instance.captureInterface}`);

		// 3. RouterOS: remote syslog action → gateway:port, rule on the `info` topic.
		//    NOTE: RouterOS logging-action names must be alphanumeric (no hyphens).
		await instance.exec(
			`/system/logging/action/add name=qchrgw target=remote remote=${instance.tzspGatewayIp} remote-port=${port}`,
		);
		await instance.exec("/system/logging/add action=qchrgw topics=info");

		// 4. Emit a few log lines carrying the nonce.
		for (let i = 0; i < 3; i++) {
			await instance.exec(`:log info "${NONCE}-${i}"`);
			await Bun.sleep(500);
		}

		// 5. Wait for the host socket to receive a datagram with our nonce.
		const deadline = Date.now() + 30_000;
		let hit: { from: string; text: string } | undefined;
		while (Date.now() < deadline) {
			hit = received.find((r) => r.text.includes(NONCE));
			if (hit) break;
			await Bun.sleep(1000);
		}

		if (hit) {
			console.log(`[result] PASS — guest→host UDP via gateway, no forward`);
			console.log(`[result] datagram src=${hit.from} (SLIRP-relayed) payload="${hit.text.trim()}"`);
			console.log(`[result] total datagrams received: ${received.length}`);
		} else {
			console.log(`[result] FAIL — no datagram with nonce within 30s (received ${received.length})`);
			for (const r of received) console.log(`  from ${r.from}: ${r.text.trim()}`);
			process.exitCode = 1;
		}
	} finally {
		try { sock.close(); } catch { /* ignore */ }
		try { await instance?.remove(); } catch { /* ignore */ }
	}
}

if (!process.env.QUICKCHR_INTEGRATION) {
	console.log("Set QUICKCHR_INTEGRATION=1 to run (boots a real CHR).");
} else {
	await main();
}
