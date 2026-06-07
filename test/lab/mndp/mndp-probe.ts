/**
 * LAB PROBE — prove that a host process can receive RouterOS MNDP broadcasts
 * from a CHR via a QEMU mcast socket netdev.
 *
 * Not a test yet. Run directly, watch the output, pin down the gotchas:
 *   bun run test/lab/mndp/mndp-probe.ts
 *
 * Hypothesis: QEMU `-netdev socket,mcast=GROUP:PORT` emits the guest's raw
 * Ethernet frames as UDP datagrams to GROUP:PORT. A host UDP socket that joins
 * that multicast group receives those frames — including MNDP (UDP/5678
 * broadcast) — with no root, no raw sockets, no native helper.
 */

import dgram from "node:dgram";
import os from "node:os";
import { QuickCHR, type ChrInstance } from "../../../src/index.ts";

const GROUP = "230.0.0.1";
const PORT = 4001;
const MNDP_PORT = 5678;
const LISTEN_MS = 75_000;

const CHR_ARCH = process.arch === "arm64" ? ("arm64" as const) : ("x86" as const);

// ── L2/L3/L4 demux: pull the UDP payload out of a raw Ethernet frame ──────────
function ethToUdpPayload(frame: Buffer, wantDstPort: number): Buffer | null {
	if (frame.length < 14 + 20 + 8) return null;
	const ethertype = frame.readUInt16BE(12);
	if (ethertype !== 0x0800) return null; // not IPv4
	const ipStart = 14;
	const verIhl = frame.readUInt8(ipStart);
	if ((verIhl >> 4) !== 4) return null;
	const ihl = (verIhl & 0x0f) * 4;
	const proto = frame[ipStart + 9];
	if (proto !== 17) return null; // not UDP
	const udpStart = ipStart + ihl;
	if (udpStart + 8 > frame.length) return null;
	const dstPort = frame.readUInt16BE(udpStart + 2);
	if (dstPort !== wantDstPort) return null;
	const udpLen = frame.readUInt16BE(udpStart + 4);
	const payStart = udpStart + 8;
	const payEnd = Math.min(udpStart + udpLen, frame.length);
	return frame.subarray(payStart, payEnd);
}

function srcMac(frame: Buffer): string {
	return [...frame.subarray(6, 12)].map((b) => b.toString(16).padStart(2, "0")).join(":");
}

// ── MNDP TLV parser (from the routeros-mndp skill) ───────────────────────────
function parseMndp(buf: Buffer): Record<string, string | number> {
	let offset = 4; // skip 2-byte header + 2-byte sequence
	const fields: Record<string, string | number> = {};
	while (offset + 4 <= buf.length) {
		const type = buf.readUInt16BE(offset);
		const len = buf.readUInt16BE(offset + 2);
		offset += 4;
		if (offset + len > buf.length) break;
		const v = buf.subarray(offset, offset + len);
		switch (type) {
			case 1: fields.mac = [...v].map((b) => b.toString(16).padStart(2, "0")).join(":"); break;
			case 5: fields.identity = v.toString("utf8"); break;
			case 7: fields.version = v.toString("utf8"); break;
			case 8: fields.platform = v.toString("utf8"); break;
			case 10: if (len === 4) fields.uptime = v.readUInt32LE(0); break;
			case 11: fields.softwareId = v.toString("utf8"); break;
			case 12: fields.board = v.toString("utf8"); break;
			case 16: fields.ifname = v.toString("utf8"); break;
			case 17: if (len === 4) fields.ipv4 = `${v[0]}.${v[1]}.${v[2]}.${v[3]}`; break;
		}
		offset += len;
	}
	return fields;
}

// ── build an L2 MNDP refresh frame the host can inject into the mcast group ───
function ipChecksum(b: Buffer): number {
	let sum = 0;
	for (let i = 0; i < b.length; i += 2) sum += b.readUInt16BE(i);
	while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
	return ~sum & 0xffff;
}
function buildRefreshFrame(): Buffer {
	const payload = Buffer.from([0, 0, 0, 0]); // minimal MAC-Telnet refresh
	const udpLen = 8 + payload.length;
	const udp = Buffer.alloc(udpLen);
	udp.writeUInt16BE(MNDP_PORT, 0);
	udp.writeUInt16BE(MNDP_PORT, 2);
	udp.writeUInt16BE(udpLen, 4);
	udp.writeUInt16BE(0, 6); // UDP checksum optional for IPv4
	payload.copy(udp, 8);
	const ipLen = 20 + udpLen;
	const ip = Buffer.alloc(20);
	ip[0] = 0x45;
	ip.writeUInt16BE(ipLen, 2);
	ip[8] = 1; // TTL
	ip[9] = 17; // UDP
	ip.writeUInt32BE(0x00000000, 12); // src 0.0.0.0
	ip.writeUInt32BE(0xffffffff, 16); // dst 255.255.255.255
	ip.writeUInt16BE(ipChecksum(ip), 10);
	const eth = Buffer.alloc(14);
	Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]).copy(eth, 0);
	Buffer.from([0x02, 0x00, 0x00, 0x00, 0x00, 0x01]).copy(eth, 6); // host src MAC
	eth.writeUInt16BE(0x0800, 12);
	return Buffer.concat([eth, ip, udp]);
}

async function main() {
	let instance: ChrInstance | undefined;
	const stats = { datagrams: 0, ethertypes: new Map<number, number>(), udpPorts: new Map<number, number>(), mndp: 0 };

	const sock = dgram.createSocket({ type: "udp4", reuseAddr: true, reusePort: true });
	sock.on("message", (msg, rinfo) => {
		stats.datagrams++;
		const frame = Buffer.from(msg);
		if (frame.length >= 14) {
			const et = frame.readUInt16BE(12);
			stats.ethertypes.set(et, (stats.ethertypes.get(et) ?? 0) + 1);
		}
		const mac = frame.length >= 12 ? srcMac(frame) : "?";
		console.log(`  rx ${msg.length}B from udp ${rinfo.address}:${rinfo.port}  ethSrc=${mac} ethType=0x${frame.length >= 14 ? frame.readUInt16BE(12).toString(16) : "?"}`);
		if (mac === "02:00:00:00:00:01") return; // our own injected refresh (looped back)
		const udp = ethToUdpPayload(frame, MNDP_PORT);
		if (!udp) return;
		stats.udpPorts.set(MNDP_PORT, (stats.udpPorts.get(MNDP_PORT) ?? 0) + 1);
		const fields = parseMndp(udp);
		if (Object.keys(fields).length > 0) {
			stats.mndp++;
			console.log(`  [${new Date().toISOString().slice(11, 23)}] MNDP from ${mac}:`, fields);
		}
	});

	const joinGroup = () => new Promise<void>((resolve, reject) => {
		sock.once("error", reject);
		// QEMU binds PORT first (started above), so the host shares it.
		sock.bind(PORT, () => {
			try { sock.setMulticastLoopback(true); } catch {}
			const ifaceAddrs: string[] = ["127.0.0.1"];
			for (const addrs of Object.values(os.networkInterfaces())) {
				for (const a of addrs ?? []) {
					if (a.family === "IPv4" && !a.internal) ifaceAddrs.push(a.address);
				}
			}
			let joined = 0;
			for (const ifaddr of ifaceAddrs) {
				try { sock.addMembership(GROUP, ifaddr); joined++; console.log(`  joined ${GROUP} on ${ifaddr}`); }
				catch (e) { console.log(`  join ${ifaddr} failed: ${(e as Error).message}`); }
			}
			console.log(`host: ${joined} memberships on ${GROUP}:${PORT}`);
			resolve();
		});
	});

	try {
		console.log("starting CHR (user + mcast)…");
		instance = await QuickCHR.start({
			name: "mndp-probe",
			version: "stable",
			arch: CHR_ARCH,
			background: true,
			secureLogin: false,
			cpu: 1,
			mem: 256,
			networks: ["user", { type: "socket-mcast", group: GROUP, port: PORT }],
		});
		const ready = await instance.waitForBoot(180_000);
		console.log("boot ready:", ready);

		// ── diagnostics: what did QEMU actually do? ──────────────────────────
		const md = instance.state.machineDir;
		const qemuLog = await Bun.file(`${md}/qemu.log`).text().catch(() => "");
		const netLines = qemuLog.split("\n").filter((l) => /socket|mcast|netdev|error|fail|bind/i.test(l));
		console.log("qemu.log netdev/error lines:", netLines.length ? "\n  " + netLines.join("\n  ") : "(none)");
		const mj = JSON.parse(await Bun.file(`${md}/machine.json`).text());
		console.log("machine.json networks:", JSON.stringify(mj.networks?.map((n: { resolved?: { qemuNetdevArgs?: string[] } }) => n.resolved?.qemuNetdevArgs)));

		await instance.exec("/system/identity/set name=mndp-probe");
		await instance.exec("/ip/neighbor/discovery-settings/set discover-interface-list=all");
		await instance.exec("/ip/address/add address=10.99.99.1/24 interface=ether2").catch(() => {});
		const ifc = await instance.exec("/interface/print");
		console.log("interfaces:\n", ifc.output?.trim());

		await joinGroup();

		console.log(`listening ${LISTEN_MS / 1000}s; injecting refresh in 3s…`);
		setTimeout(() => {
			const f = buildRefreshFrame();
			sock.send(f, PORT, GROUP, (e) => console.log(e ? `refresh send err: ${e}` : `injected refresh (${f.length}B)`));
		}, 3000);

		await new Promise((r) => setTimeout(r, LISTEN_MS));
	} finally {
		sock.close();
		console.log("\n── stats ──");
		console.log("datagrams:", stats.datagrams);
		console.log("ethertypes:", [...stats.ethertypes].map(([k, n]) => `0x${k.toString(16)}=${n}`).join(" "));
		console.log("udp/5678 frames:", stats.udpPorts.get(MNDP_PORT) ?? 0);
		console.log("parsed MNDP:", stats.mndp);
		if (process.env.KEEP) console.log(`KEEP set — leaving machine "${instance?.name}" running (dir: ${instance?.state.machineDir})`);
		else { try { await instance?.remove(); } catch {} }
	}
}

main().catch((e) => { console.error(e); process.exit(1); });
