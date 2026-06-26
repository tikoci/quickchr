#!/usr/bin/env bun
/**
 * mndp — receive RouterOS MNDP neighbor-discovery broadcasts from a CHR on the host
 *
 * MNDP is a UDP/5678 Layer-2 broadcast (what WinBox uses to find routers). QEMU
 * user-mode (SLIRP) terminates L2, so MNDP never reaches the host. The fix is an
 * L2-capable netdev: the host runs a TCP server, the CHR's second NIC uses
 * `socket-connect` to it, and QEMU streams every guest Ethernet frame to the host
 * length-prefixed (4-byte big-endian length + raw frame). The host strips the
 * prefix and parses Ethernet → IPv4 → UDP/5678 → MNDP TLVs.
 *
 * Why not mcast? QEMU's `socket,mcast=` is broken on macOS (SO_REUSEADDR vs the
 * SO_REUSEPORT macOS needs). socket-connect is loopback-only and cross-platform.
 * See ../../docs/mndp.md and ../../test/lab/mndp/REPORT.md.
 *
 * Run:  bun run examples/mndp/mndp.ts
 * Time: ~25–40 s with KVM/HVF.
 */
import net from "node:net";
import { QuickCHR } from "../../src/index.ts";
import { check, exampleMachineName, runExample } from "../lib.ts";

const MNDP_PORT = 5678;
const IDENTITY = "mndp-example";

// ── parse the UDP payload out of a raw Ethernet frame (IPv4/UDP only) ─────────
function ethToUdpPayload(frame: Buffer, wantDstPort: number): Buffer | null {
	if (frame.length < 14 + 20 + 8) return null;
	if (frame.readUInt16BE(12) !== 0x0800) return null; // not IPv4
	const ip = 14;
	const vihl = frame.readUInt8(ip);
	if (vihl >> 4 !== 4) return null;
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

if (import.meta.main) {
	await runExample(async (track) => {
		// 1. Host TCP listener on an ephemeral port; collect parsed MNDP records.
		const records: Record<string, string | number>[] = [];
		let conn: net.Socket | undefined;
		const server = net.createServer((c) => {
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
			server.listen(0, "127.0.0.1", () => res((server.address() as net.AddressInfo).port));
		});

		try {
			// 2. Boot CHR: ether1 = user (REST/mgmt), ether2 = socket-connect to the host.
			const chr = track(
				await QuickCHR.start({
					name: exampleMachineName("mndp"),
					channel: "stable",
					secureLogin: false,
					mem: 256,
					networks: ["user", { type: "socket-connect", port }],
				}),
			);
			check(await chr.waitForBoot(180_000), "CHR did not become REST-ready");

			// 3. Deterministic discovery: known identity, MNDP on ether2.
			await chr.exec(`/system/identity/set name=${IDENTITY}`);
			await chr.exec("/ip/neighbor/discovery-settings/set discover-interface-list=all");

			// 4. Nudge an immediate reply, then wait for an announcement with our identity.
			setTimeout(() => conn?.write(buildRefreshStreamFrame()), 1000);
			let got: Record<string, string | number> | undefined;
			const deadline = Date.now() + 40_000;
			while (Date.now() < deadline) {
				got = records.find((r) => r.identity === IDENTITY);
				if (got) break;
				await Bun.sleep(1000);
			}
			check(got !== undefined, "no MNDP announcement with our identity within 40s");

			// 5. Cross-check the L2-discovered values against REST (the source of truth).
			const id = (await chr.rest("/system/identity")) as Record<string, string>;
			const res = (await chr.rest("/system/resource")) as Record<string, string>;
			check(got.identity === id.name, "MNDP identity should match REST identity");
			check(
				String(got.version).startsWith(res.version ?? ""),
				"MNDP version should match REST version",
			);
			check(got.platform === "MikroTik", "MNDP platform should be MikroTik");
			check(got.board === "CHR", "MNDP board should be CHR");
			console.log(
				`  MNDP via L2: identity=${got.identity} version="${got.version}" board=${got.board} ip=${got.ipv4}`,
			);
		} finally {
			try {
				server.close();
			} catch {
				/* ignore */
			}
		}
	});
}
