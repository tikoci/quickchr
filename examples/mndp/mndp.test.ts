import { describe, test, expect, afterAll } from "bun:test";
import net from "node:net";
import type { ChrInstance } from "../../src/index.ts";
import { QuickCHR } from "../../src/index.ts";

/**
 * mndp — receive RouterOS MNDP neighbor-discovery broadcasts from a CHR on the host
 *
 * MNDP is a UDP/5678 Layer-2 broadcast (the protocol WinBox uses to find routers).
 * QEMU user-mode (SLIRP) networking terminates L2 in a userspace NAT, so MNDP
 * broadcasts never reach the host — a caller listening for neighbors sees nothing.
 *
 * The fix is an L2-capable netdev. The portable, rootless one is QEMU's TCP
 * `socket` netdev: the host runs a TCP server, the CHR's second NIC uses
 * `socket-connect` to it, and QEMU streams every guest Ethernet frame to the host,
 * length-prefixed (4-byte big-endian length + raw frame). The host strips the
 * prefix and parses Ethernet → IPv4 → UDP/5678 → MNDP TLVs.
 *
 * NOTE — why not mcast? QEMU's `socket,mcast=` netdev is the documented multi-VM
 * path and works on Linux, but is broken on macOS: QEMU sets only SO_REUSEADDR,
 * while macOS/BSD require SO_REUSEPORT on every socket sharing a multicast port.
 * The TCP `socket-connect` path has no such limitation and is loopback-only
 * (no multicast leak onto the LAN). See ../../docs/mndp.md and
 * ../../test/lab/mndp/REPORT.md for the evidence.
 *
 * Run:
 *   QUICKCHR_INTEGRATION=1 bun test examples/mndp/mndp.test.ts
 */

const SKIP = !process.env.QUICKCHR_INTEGRATION;
const CHR_ARCH = process.arch === "arm64" ? ("arm64" as const) : ("x86" as const);
const MNDP_PORT = 5678;
const IDENTITY = "mndp-example";

// ── parse the UDP payload out of a raw Ethernet frame (IPv4/UDP only) ─────────
function ethToUdpPayload(frame: Buffer, wantDstPort: number): Buffer | null {
	if (frame.length < 14 + 20 + 8) return null;
	if (frame.readUInt16BE(12) !== 0x0800) return null; // not IPv4
	const ip = 14;
	const vihl = frame.readUInt8(ip);
	if ((vihl >> 4) !== 4) return null;
	const ihl = (vihl & 0x0f) * 4;
	if (frame[ip + 9] !== 17) return null; // not UDP
	const udp = ip + ihl;
	if (udp + 8 > frame.length) return null;
	if (frame.readUInt16BE(udp + 2) !== wantDstPort) return null;
	const udpLen = frame.readUInt16BE(udp + 4);
	return frame.subarray(udp + 8, Math.min(udp + udpLen, frame.length));
}

// ── MNDP TLV parser (see the routeros-mndp skill for the full type table) ─────
function parseMndp(buf: Buffer): Record<string, string | number> {
	let o = 4; // skip 2-byte header + 2-byte sequence
	const f: Record<string, string | number> = {};
	while (o + 4 <= buf.length) {
		const type = buf.readUInt16BE(o);
		const len = buf.readUInt16BE(o + 2);
		o += 4;
		if (o + len > buf.length) break;
		const v = buf.subarray(o, o + len);
		switch (type) {
			case 1: f.mac = [...v].map((b) => b.toString(16).padStart(2, "0")).join(":"); break;
			case 5: f.identity = v.toString("utf8"); break;
			case 7: f.version = v.toString("utf8"); break;
			case 8: f.platform = v.toString("utf8"); break;
			case 10: if (len === 4) f.uptime = v.readUInt32LE(0); break; // the only LE value
			case 11: f.softwareId = v.toString("utf8"); break;
			case 12: f.board = v.toString("utf8"); break;
			case 16: f.ifname = v.toString("utf8"); break;
			case 17: if (len === 4) f.ipv4 = `${v[0]}.${v[1]}.${v[2]}.${v[3]}`; break;
		}
		o += len;
	}
	return f;
}

// ── an MNDP refresh frame, length-prefixed for QEMU's stream socket ───────────
// Writing this back over the TCP connection makes RouterOS reply immediately
// instead of waiting for the next periodic (~30s) announce.
function buildRefreshStreamFrame(): Buffer {
	const payload = Buffer.from([0, 0, 0, 0]); // minimal MAC-Telnet refresh
	const udp = Buffer.alloc(8 + payload.length);
	udp.writeUInt16BE(MNDP_PORT, 0);
	udp.writeUInt16BE(MNDP_PORT, 2);
	udp.writeUInt16BE(udp.length, 4);
	payload.copy(udp, 8);
	const ip = Buffer.alloc(20);
	ip[0] = 0x45;
	ip.writeUInt16BE(20 + udp.length, 2);
	ip[8] = 1; // TTL
	ip[9] = 17; // UDP
	ip.writeUInt32BE(0, 12); // src 0.0.0.0
	ip.writeUInt32BE(0xffffffff, 16); // dst 255.255.255.255
	let sum = 0;
	for (let i = 0; i < 20; i += 2) sum += ip.readUInt16BE(i);
	while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
	ip.writeUInt16BE(~sum & 0xffff, 10);
	const eth = Buffer.alloc(14);
	Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]).copy(eth, 0); // broadcast
	Buffer.from([0x02, 0x00, 0x00, 0x00, 0x00, 0x01]).copy(eth, 6); // host MAC
	eth.writeUInt16BE(0x0800, 12);
	const frame = Buffer.concat([eth, ip, udp]);
	const hdr = Buffer.alloc(4);
	hdr.writeUInt32BE(frame.length, 0);
	return Buffer.concat([hdr, frame]);
}

describe.skipIf(SKIP)("mndp — receive CHR neighbor-discovery broadcasts on the host", () => {
	let instance: ChrInstance | undefined;
	let server: net.Server | undefined;

	afterAll(async () => {
		try { server?.close(); } catch { /* ignore */ }
		try { await instance?.remove(); } catch { /* ignore */ }
	});

	test(
		"CHR MNDP arrives over a socket-connect NIC and matches REST",
		async () => {
			// 1. Host TCP listener on an ephemeral port; collect parsed MNDP records.
			const records: Record<string, string | number>[] = [];
			let conn: net.Socket | undefined;
			server = net.createServer((c) => {
				conn = c;
				let buf = Buffer.alloc(0);
				c.on("data", (d) => {
					buf = Buffer.concat([buf, d as Buffer]);
					while (buf.length >= 4) {
						const len = buf.readUInt32BE(0);
						if (len > 0xffff || buf.length < 4 + len) break;
						const frame = buf.subarray(4, 4 + len);
						buf = buf.subarray(4 + len);
						const udp = ethToUdpPayload(frame, MNDP_PORT);
						if (!udp) continue;
						const rec = parseMndp(udp);
						if (rec.identity) records.push(rec);
					}
				});
			});
			const port: number = await new Promise((res) => {
				server!.listen(0, "127.0.0.1", () => res((server!.address() as net.AddressInfo).port));
			});

			// 2. Boot CHR: ether1 = user (REST/mgmt), ether2 = socket-connect to the host.
			instance = await QuickCHR.start({
				name: "mndp-example",
				channel: "stable",
				arch: CHR_ARCH,
				background: true,
				secureLogin: false,
				cpu: 1,
				mem: 256,
				networks: ["user", { type: "socket-connect", port }],
			});
			expect(await instance.waitForBoot(180_000)).toBe(true);

			// 3. Make discovery deterministic: set a known identity, ensure MNDP on ether2.
			await instance.exec(`/system/identity/set name=${IDENTITY}`);
			await instance.exec("/ip/neighbor/discovery-settings/set discover-interface-list=all");

			// 4. Nudge an immediate reply, then wait for an announcement carrying our identity.
			setTimeout(() => conn?.write(buildRefreshStreamFrame()), 1000);
			let got: Record<string, string | number> | undefined;
			const deadline = Date.now() + 40_000;
			while (Date.now() < deadline) {
				got = records.find((r) => r.identity === IDENTITY);
				if (got) break;
				await Bun.sleep(1000);
			}

			expect(got, "no MNDP announcement with our identity within 40s").toBeDefined();

			// 5. Cross-check the L2-discovered values against REST (the source of truth).
			const id = await instance.rest("/system/identity") as Record<string, string>;
			const res = await instance.rest("/system/resource") as Record<string, string>;
			expect(got!.identity).toBe(id.name);
			expect(typeof got!.version).toBe("string");
			expect((got!.version as string).startsWith(res.version ?? "")).toBe(true);
			expect(got!.platform).toBe("MikroTik");
			expect(got!.board).toBe("CHR");
			console.log(`  MNDP via L2: identity=${got!.identity} version="${got!.version}" board=${got!.board}`);
		},
		240_000,
	);
});
