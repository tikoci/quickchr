/**
 * LAB PROBE — host receives MNDP via QEMU's TCP `socket` netdev (cross-platform).
 *
 * The mcast netdev is broken on macOS (QEMU uses SO_REUSEADDR only; macOS needs
 * SO_REUSEPORT to share a multicast port). The portable alternative: the host runs
 * a TCP server; the CHR's NIC uses `socket-connect` to it. QEMU streams every guest
 * Ethernet frame to the host, length-prefixed (4-byte big-endian length + frame).
 * Loopback only — no multicast, no LAN leak, deterministic.
 *
 *   bun run test/lab/mndp/socket-connect-probe.ts
 */
import net from "node:net";
import { QuickCHR, type ChrInstance } from "../../../src/index.ts";

const PORT = 4101;
const MNDP_PORT = 5678;
const LISTEN_MS = 50_000;
const CHR_ARCH = process.arch === "arm64" ? ("arm64" as const) : ("x86" as const);

function ethToUdpPayload(frame: Buffer, wantDstPort: number): Buffer | null {
	if (frame.length < 14 + 20 + 8) return null;
	if (frame.readUInt16BE(12) !== 0x0800) return null;
	const ip = 14;
	const vihl = frame.readUInt8(ip);
	if ((vihl >> 4) !== 4) return null;
	const ihl = (vihl & 0x0f) * 4;
	if (frame[ip + 9] !== 17) return null;
	const udp = ip + ihl;
	if (udp + 8 > frame.length) return null;
	if (frame.readUInt16BE(udp + 2) !== wantDstPort) return null;
	const udpLen = frame.readUInt16BE(udp + 4);
	if (udpLen < 8) return null;
	return frame.subarray(udp + 8, Math.min(udp + udpLen, frame.length));
}
function srcMac(f: Buffer) { return [...f.subarray(6, 12)].map((b) => b.toString(16).padStart(2, "0")).join(":"); }
function parseMndp(buf: Buffer): Record<string, string | number> {
	let o = 4; const f: Record<string, string | number> = {};
	while (o + 4 <= buf.length) {
		const t = buf.readUInt16BE(o), l = buf.readUInt16BE(o + 2); o += 4;
		if (o + l > buf.length) break;
		const v = buf.subarray(o, o + l);
		switch (t) {
			case 1: f.mac = [...v].map((b) => b.toString(16).padStart(2, "0")).join(":"); break;
			case 5: f.identity = v.toString("utf8"); break;
			case 7: f.version = v.toString("utf8"); break;
			case 8: f.platform = v.toString("utf8"); break;
			case 10: if (l === 4) f.uptime = v.readUInt32LE(0); break;
			case 11: f.softwareId = v.toString("utf8"); break;
			case 12: f.board = v.toString("utf8"); break;
			case 16: f.ifname = v.toString("utf8"); break;
			case 17: if (l === 4) f.ipv4 = `${v[0]}.${v[1]}.${v[2]}.${v[3]}`; break;
		}
		o += l;
	}
	return f;
}
// Length-prefixed (QEMU stream framing) MAC-Telnet minimal refresh packet the host can write back.
// Note: the UDP/5678 framing here is transport; the 4-byte body is a MAC-Telnet refresh trigger, not an MNDP TLV payload.
function buildRefreshStreamFrame(): Buffer {
	const payload = Buffer.from([0, 0, 0, 0]); // Minimal MAC-Telnet refresh payload.
	const udpLen = 8 + payload.length;
	const udp = Buffer.alloc(udpLen);
	udp.writeUInt16BE(MNDP_PORT, 0); udp.writeUInt16BE(MNDP_PORT, 2); udp.writeUInt16BE(udpLen, 4);
	payload.copy(udp, 8);
	const ip = Buffer.alloc(20);
	ip[0] = 0x45; ip.writeUInt16BE(20 + udpLen, 2); ip[8] = 1; ip[9] = 17;
	ip.writeUInt32BE(0, 12); ip.writeUInt32BE(0xffffffff, 16);
	let sum = 0; for (let i = 0; i < 20; i += 2) sum += ip.readUInt16BE(i);
	while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16); ip.writeUInt16BE(~sum & 0xffff, 10);
	const eth = Buffer.alloc(14);
	Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]).copy(eth, 0);
	Buffer.from([0x02, 0x00, 0x00, 0x00, 0x00, 0x01]).copy(eth, 6);
	eth.writeUInt16BE(0x0800, 12);
	const frame = Buffer.concat([eth, ip, udp]);
	const hdr = Buffer.alloc(4); hdr.writeUInt32BE(frame.length, 0);
	return Buffer.concat([hdr, frame]);
}

async function main() {
	let instance: ChrInstance | undefined;
	const stats = { frames: 0, eth: new Map<number, number>(), mndp: 0 };
	let conn: net.Socket | undefined;

	const server = net.createServer((c) => {
		conn = c;
		console.log("QEMU connected to host TCP listener");
		let buf = Buffer.alloc(0);
		c.on("data", (d) => {
			buf = Buffer.concat([buf, d as Buffer]);
			while (buf.length >= 4) {
				const len = buf.readUInt32BE(0);
				if (len > 0xffff || buf.length < 4 + len) break;
				const frame = buf.subarray(4, 4 + len);
				buf = buf.subarray(4 + len);
				stats.frames++;
				const et = frame.length >= 14 ? frame.readUInt16BE(12) : 0;
				stats.eth.set(et, (stats.eth.get(et) ?? 0) + 1);
				const udp = ethToUdpPayload(frame, MNDP_PORT);
				if (!udp) continue;
				const fields = parseMndp(udp);
				if (Object.keys(fields).length > 0) {
					stats.mndp++;
					console.log(`  [${new Date().toISOString().slice(11, 23)}] MNDP from ${srcMac(frame)}:`, fields);
				}
			}
		});
	});
	await new Promise<void>((res) => server.listen(PORT, "127.0.0.1", res));
	console.log(`host: TCP listener on 127.0.0.1:${PORT}`);

	try {
		console.log("starting CHR (user + socket-connect)…");
		instance = await QuickCHR.start({
			name: "mndp-sc", version: "stable", arch: CHR_ARCH, background: true,
			secureLogin: false, cpu: 1, mem: 256,
			networks: ["user", { type: "socket-connect", port: PORT }],
		});
		console.log("boot ready:", await instance.waitForBoot(180_000));
		await instance.exec("/system/identity/set name=mndp-sc");
		await instance.exec("/ip/neighbor/discovery-settings/set discover-interface-list=all");
		await instance.exec("/ip/address/add address=10.99.99.1/24 interface=ether2").catch(() => {});

		console.log(`listening ${LISTEN_MS / 1000}s; injecting refresh in 3s…`);
		setTimeout(() => { if (conn) { conn.write(buildRefreshStreamFrame()); console.log("injected refresh"); } }, 3000);
		await new Promise((r) => setTimeout(r, LISTEN_MS));
	} finally {
		server.close();
		console.log("\n── stats ──");
		console.log("frames:", stats.frames);
		console.log("ethertypes:", [...stats.eth].map(([k, n]) => `0x${k.toString(16)}=${n}`).join(" ") || "(none)");
		console.log("parsed MNDP:", stats.mndp);
		if (!process.env.KEEP) { try { await instance?.remove(); } catch {} }
		else console.log("KEEP set — machine left running");
	}
}
main().catch((e) => { console.error(e); process.exit(1); });
