import { describe, test, expect, afterAll } from "bun:test";
import dgram from "node:dgram";
import type { AddressInfo } from "node:net";
import type { ChrInstance } from "../../src/index.ts";
import { QuickCHR } from "../../src/index.ts";

/**
 * udp-gateway — receive UDP a CHR *sends*, on the host, with no port forward
 *
 * QEMU user-mode (SLIRP) networking terminates Layer 2, but the gateway address
 * `10.0.2.2` IS the host as seen from inside the VM. Any datagram the guest sends
 * to `10.0.2.2:<port>` is relayed to a host process bound on loopback `<port>` —
 * no `hostfwd`, no extra NIC. This is the general form of the TZSP path that
 * `ChrInstance.tzspGatewayIp` already exposes (see src/lib/types.ts).
 *
 * The one catch: the relayed datagrams arrive from a SLIRP-rewritten loopback
 * source (`127.0.0.1:<ephemeral>`), not the guest's `10.0.2.15`. So the host
 * socket must be left **unconnected** (recvfrom) — a connected socket filters
 * them out. (This is why issue #18's btest peer needed an unconnected socket.)
 *
 * Emitter here: RouterOS remote syslog → gateway:<port>. NOTE RouterOS logging
 * action names must be alphanumeric (no hyphens).
 *
 * Evidence: ../../test/lab/gateway-udp/REPORT.md. For host→guest forwards (incl.
 * UDP port ranges for dynamic data ports) and the full decision guide, see
 * ../../docs/networking-recipes.md.
 *
 * Run:
 *   QUICKCHR_INTEGRATION=1 bun test examples/udp-gateway/udp-gateway.test.ts
 */

const SKIP = !process.env.QUICKCHR_INTEGRATION;
const CHR_ARCH = process.arch === "arm64" ? ("arm64" as const) : ("x86" as const);
const NONCE = `udp-gw-${Date.now().toString(36)}`;

describe.skipIf(SKIP)("udp-gateway — receive guest-originated UDP on the host with no forward", () => {
	let instance: ChrInstance | undefined;
	let sock: dgram.Socket | undefined;

	afterAll(async () => {
		try { sock?.close(); } catch { /* ignore */ }
		try { await instance?.remove(); } catch { /* ignore */ }
	});

	test(
		"a guest syslog datagram to 10.0.2.2 reaches an unconnected host UDP socket",
		async () => {
			// 1. Host UDP socket — bound, UNCONNECTED. Record sender so we can assert
			//    the SLIRP-rewritten source (the reason it must stay unconnected).
			const received: { from: string; text: string }[] = [];
			sock = dgram.createSocket("udp4");
			sock.on("message", (msg, rinfo) => {
				received.push({ from: `${rinfo.address}:${rinfo.port}`, text: msg.toString("utf8") });
			});
			const port: number = await new Promise((res) => {
				sock!.bind(0, "0.0.0.0", () => res((sock!.address() as AddressInfo).port));
			});

			// 2. Boot CHR with the DEFAULT single user NIC — no extra NIC, no forward.
			instance = await QuickCHR.start({
				name: "udp-gateway-example",
				channel: "stable",
				arch: CHR_ARCH,
				background: true,
				secureLogin: false,
				cpu: 1,
				mem: 256,
			});
			expect(await instance.waitForBoot(180_000)).toBe(true);
			expect(instance.tzspGatewayIp).toBe("10.0.2.2");

			// 3. Point RouterOS remote syslog at the gateway:port, route the info topic.
			await instance.exec(
				`/system/logging/action/add name=qchrgw target=remote remote=${instance.tzspGatewayIp} remote-port=${port}`,
			);
			await instance.exec("/system/logging/add action=qchrgw topics=info");

			// 4. Emit a few log lines carrying the nonce.
			for (let i = 0; i < 3; i++) {
				await instance.exec(`:log info "${NONCE}-${i}"`);
				await Bun.sleep(500);
			}

			// 5. Wait for the host's unconnected socket to receive a nonce-bearing datagram.
			let hit: { from: string; text: string } | undefined;
			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline) {
				hit = received.find((r) => r.text.includes(NONCE));
				if (hit) break;
				await Bun.sleep(1000);
			}

			expect(hit, "no guest UDP reached the host within 30s").toBeDefined();
			// Delivered from the SLIRP relay on loopback, not the guest's 10.0.2.15.
			expect(hit!.from.startsWith("127.0.0.1:")).toBe(true);
			console.log(`  guest→host UDP (no forward): src=${hit!.from} payload="${hit!.text.trim()}"`);
		},
		240_000,
	);
});
