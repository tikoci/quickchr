#!/usr/bin/env bun
/**
 * udp-gateway — receive UDP that a CHR *sends*, on the host, with no port forward
 *
 * QEMU user-mode (SLIRP) terminates Layer 2, but the gateway `10.0.2.2` IS the
 * host as seen from the VM. Any datagram the guest sends to `10.0.2.2:<port>` is
 * relayed to a host process bound on loopback `<port>` — no `hostfwd`, no extra
 * NIC. This is the general form of the TZSP path `ChrInstance.tzspGatewayIp`
 * exposes.
 *
 * The catch: relayed datagrams arrive from a SLIRP-rewritten loopback source
 * (`127.0.0.1:<ephemeral>`), not the guest's `10.0.2.15`. So the host socket must
 * be left **unconnected** (recvfrom) — a connected socket filters them out.
 *
 * Emitter here: RouterOS remote syslog → gateway:<port>. (Logging action names
 * must be alphanumeric — no hyphens.) Evidence: ../../test/lab/gateway-udp/REPORT.md.
 *
 * Run:  bun run examples/udp-gateway/udp-gateway.ts
 * Time: ~30–50 s.
 */
import dgram from "node:dgram";
import type { AddressInfo } from "node:net";
import { QuickCHR } from "../../src/index.ts";
import { check, exampleMachineName, runExample } from "../lib.ts";

if (import.meta.main) {
	await runExample(async (track) => {
		// 1. Host UDP socket — bound, UNCONNECTED. Record the sender so we can see
		//    the SLIRP-rewritten source (the reason it must stay unconnected).
		const received: { from: string; text: string }[] = [];
		const sock = dgram.createSocket("udp4");
		sock.on("message", (msg, rinfo) => {
			received.push({ from: `${rinfo.address}:${rinfo.port}`, text: msg.toString("utf8") });
		});
		const port: number = await new Promise((res) => {
			sock.bind(0, "0.0.0.0", () => res((sock.address() as AddressInfo).port));
		});

		try {
			// 2. Boot CHR with the DEFAULT single user NIC — no extra NIC, no forward.
			const chr = track(
				await QuickCHR.start({
					name: exampleMachineName("udp-gateway"),
					channel: "stable",
					secureLogin: false,
					mem: 256,
				}),
			);
			check(await chr.waitForBoot(180_000), "CHR did not become REST-ready");
			check(chr.tzspGatewayIp === "10.0.2.2", "expected SLIRP gateway 10.0.2.2");

			// 3. Point RouterOS remote syslog at gateway:port, route the info topic.
			await chr.exec(
				`/system/logging/action/add name=qchrgw target=remote remote=${chr.tzspGatewayIp} remote-port=${port}`,
			);
			await chr.exec("/system/logging/add action=qchrgw topics=info");

			// 4. Emit a few nonce-bearing log lines.
			const nonce = `udp-gw-${Date.now().toString(36)}`;
			for (let i = 0; i < 3; i++) {
				await chr.exec(`:log info "${nonce}-${i}"`);
				await Bun.sleep(500);
			}

			// 5. Wait for the unconnected host socket to receive a nonce-bearing datagram.
			let hit: { from: string; text: string } | undefined;
			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline) {
				hit = received.find((r) => r.text.includes(nonce));
				if (hit) break;
				await Bun.sleep(1000);
			}

			check(hit !== undefined, "no guest UDP reached the host within 30s");
			// Delivered from the SLIRP relay on loopback, not the guest's 10.0.2.15.
			check(hit.from.startsWith("127.0.0.1:"), `expected loopback source, got ${hit.from}`);
			console.log(`  guest→host UDP (no forward): src=${hit.from} payload="${hit.text.trim()}"`);
		} finally {
			try {
				sock.close();
			} catch {
				/* ignore */
			}
		}
	});
}
