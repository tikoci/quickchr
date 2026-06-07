/**
 * LAB PROBE — host receives MNDP via QEMU's `-netdev stream` over an AF_UNIX path.
 *
 * Motivation: the legacy `-netdev socket` (TCP) path quickchr uses for host L2
 * capture allocates a loopback TCP port and prefixes every guest frame with a
 * 4-byte big-endian length (see socket-connect-probe.ts / REPORT.md). The newer
 * `-netdev stream` (QEMU 7.2+) with `addr.type=unix` was floated as a cleaner
 * option: no TCP port, a filesystem socket instead. The open question this probe
 * answers EMPIRICALLY (rather than trusting docs): on macOS, does `stream`+unix
 * carry guest L2 frames at all, and is the byte stream length-prefixed like the
 * legacy socket netdev, or unframed?
 *
 * Approach: boot a user-only CHR through the normal quickchr path (image, disk,
 * ports, REST all handled), capture its REST identity/version, then STOP it and
 * relaunch the same disk with the user NIC (ether1, management) plus a
 * hand-crafted launch-time `-netdev stream,...,server=off,addr.type=unix` NIC
 * (ether2). The host listens on the unix socket first; QEMU connects to it
 * (server=off), mirroring the socket-connect host-listener model. We then sniff
 * the raw bytes, auto-detect the framing, parse MNDP, and cross-check vs REST.
 *
 *   bun run test/lab/mndp/stream-unix-probe.ts
 *   KEEP=1 bun run test/lab/mndp/stream-unix-probe.ts   # leave machine running
 */
import net from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { QuickCHR } from "../../../src/index.ts";
import { buildQemuArgs, spawnQemu, stopQemu } from "../../../src/lib/qemu.ts";
import { resolveAllNetworks, buildHostfwdString } from "../../../src/lib/network.ts";
import { detectPlatform, detectAccel } from "../../../src/lib/platform.ts";
import type { NetworkConfig } from "../../../src/lib/types.ts";

const MNDP_PORT = 5678;
const LISTEN_MS = 70_000;
const CHR_ARCH = process.arch === "arm64" ? ("arm64" as const) : ("x86" as const);
const KNOWN_ETHERTYPES = new Set([0x0800, 0x86dd, 0x88cc, 0x0806]);

// --- Ethernet / IPv4 / MNDP parsing (shared shape with socket-connect-probe) ---
function ethToUdpPayload(frame: Buffer, wantDstPort: number): Buffer | null {
	if (frame.length < 14 + 20 + 8) return null;
	if (frame.readUInt16BE(12) !== 0x0800) return null;
	const ip = 14;
	const vihl = frame.readUInt8(ip);
	if ((vihl >> 4) !== 4) return null;
	const ihl = (vihl & 0x0f) * 4;
	if (frame.readUInt8(ip + 9) !== 17) return null;
	const udp = ip + ihl;
	if (udp + 8 > frame.length) return null;
	if (frame.readUInt16BE(udp + 2) !== wantDstPort) return null;
	const udpLen = frame.readUInt16BE(udp + 4);
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

// --- framing auto-detection ------------------------------------------------
// Returns the ethertype if `off` looks like the start of an Ethernet frame.
function ethertypeAt(b: Buffer, off: number): number | null {
	if (off + 14 > b.length) return null;
	const et = b.readUInt16BE(off + 12);
	return KNOWN_ETHERTYPES.has(et) ? et : null;
}
type Framing = "length-prefixed" | "unframed" | "unknown";
function detectFraming(b: Buffer): Framing {
	if (b.length >= 18) {
		const len = b.readUInt32BE(0);
		if (len >= 14 && len <= 2048 && ethertypeAt(b, 4) !== null) return "length-prefixed";
	}
	if (ethertypeAt(b, 0) !== null) return "unframed";
	return "unknown";
}

async function main() {
	const stats = { frames: 0, eth: new Map<number, number>(), mndp: 0 };
	let framing: Framing = "unknown";
	let firstHex = "";
	let conn: net.Socket | undefined;

	console.log(`== phase 1: boot user-only CHR (image/disk/ports/REST via quickchr) ==`);
	const chr = await QuickCHR.start({
		name: "mndp-stream", version: "stable", arch: CHR_ARCH, background: true,
		secureLogin: false, cpu: 1, mem: 256, networks: ["user"],
	});
	console.log("boot ready:", await chr.waitForBoot(180_000));
	await chr.exec("/system/identity/set name=mndp-stream");
	await chr.exec("/ip/neighbor/discovery-settings/set discover-interface-list=all");
	const res = await chr.rest("/system/resource") as Record<string, string>;
	const id = await chr.rest("/system/identity") as Record<string, string>;
	console.log(`REST: identity=${id.name} version="${res.version}" board=${res["board-name"]} platform=${res.platform}`);

	const state = chr.state;
	const machineDir = state.machineDir;
	const sockPath = join(machineDir, "stream.sock");
	let relaunchPid = 0;

	try {
		console.log(`== phase 2: stop, relaunch with user + -netdev stream (unix) ==`);
		await chr.stop();
		if (existsSync(sockPath)) unlinkSync(sockPath);

		// Host listens on the AF_UNIX socket first; QEMU connects (server=off).
		const server = net.createServer((c) => {
			conn = c;
			console.log(`QEMU connected to host AF_UNIX listener (${sockPath})`);
			let buf = Buffer.alloc(0);
			c.on("data", (d) => {
				buf = Buffer.concat([buf, d as Buffer]);
				if (!firstHex) firstHex = buf.subarray(0, Math.min(64, buf.length)).toString("hex");
				if (framing === "unknown") framing = detectFraming(buf);
				if (framing === "length-prefixed") {
					while (buf.length >= 4) {
						const len = buf.readUInt32BE(0);
						if (len > 0xffff || buf.length < 4 + len) break;
						handleFrame(buf.subarray(4, 4 + len));
						buf = buf.subarray(4 + len);
					}
				} else if (framing === "unframed") {
					// Concatenated frames: advance by IPv4 total-length when possible.
					while (buf.length >= 14) {
						const et = buf.readUInt16BE(12);
						if (!KNOWN_ETHERTYPES.has(et)) { buf = Buffer.alloc(0); break; } // desynced
						let frameLen: number | null = null;
						if (et === 0x0800 && buf.length >= 14 + 20) frameLen = 14 + buf.readUInt16BE(14 + 2);
						if (frameLen === null || buf.length < frameLen) break;
						handleFrame(buf.subarray(0, frameLen));
						buf = buf.subarray(frameLen);
					}
				}
			});
		});
		await new Promise<void>((r) => server.listen(sockPath, r));
		console.log(`host: AF_UNIX listener on ${sockPath}`);

		// Rebuild launch args: resolved user NIC (net0) + hand-crafted stream-unix NIC (net1).
		const platform = await detectPlatform();
		const accel = await detectAccel(state.arch);
		const hostfwd = buildHostfwdString(state.ports);
		const userResolved = resolveAllNetworks(state.networks, { platform }, hostfwd);
		const streamNet: NetworkConfig = {
			specifier: { type: "socket-connect", port: 0 }, // placeholder; resolved args below win
			id: "net1",
			resolved: {
				qemuNetdevArgs: [
					"-netdev", `stream,id=net1,server=off,addr.type=unix,addr.path=${sockPath}`,
					"-device", "virtio-net-pci,netdev=net1",
				],
			},
		};
		const bootFmt = state.bootDiskFormat ?? "raw";
		const qemuArgs = await buildQemuArgs({
			arch: state.arch,
			machineDir,
			bootDisk: { path: join(machineDir, bootFmt === "qcow2" ? "boot.qcow2" : "disk.img"), format: bootFmt },
			mem: state.mem,
			cpu: state.cpu,
			ports: state.ports,
			networks: [...userResolved, streamNet],
			background: true,
			portBase: state.portBase,
			accel,
		});
		console.log(`-netdev stream arg: ${qemuArgs.find((a) => a.startsWith("stream,"))}`);
		const { pid } = await spawnQemu(qemuArgs, machineDir, true);
		relaunchPid = pid;
		console.log(`relaunched pid=${pid}; waiting for REST…`);
		console.log("boot ready:", await chr.waitForBoot(180_000));

		console.log(`listening ${LISTEN_MS / 1000}s for MNDP over stream-unix…`);
		await new Promise((r) => setTimeout(r, LISTEN_MS));

		console.log("\n── stream-unix findings ──");
		console.log("framing:", framing);
		console.log("first bytes (hex):", firstHex || "(none received)");
		console.log("frames:", stats.frames);
		console.log("ethertypes:", [...stats.eth].map(([k, n]) => `0x${k.toString(16)}=${n}`).join(" ") || "(none)");
		console.log("parsed MNDP:", stats.mndp);
		console.log(`REST cross-check: identity=${id.name} version="${res.version}" board=${res["board-name"]}`);

		server.close();
	} finally {
		if (relaunchPid) { try { await stopQemu(relaunchPid); } catch {} }
		if (!process.env.KEEP) { try { await chr.remove(); } catch {} }
		else console.log("KEEP set — machine left (stopped) for inspection");
	}

	function handleFrame(frame: Buffer) {
		stats.frames++;
		const et = frame.length >= 14 ? frame.readUInt16BE(12) : 0;
		stats.eth.set(et, (stats.eth.get(et) ?? 0) + 1);
		const udp = ethToUdpPayload(frame, MNDP_PORT);
		if (!udp) return;
		const fields = parseMndp(udp);
		if (Object.keys(fields).length > 0) {
			stats.mndp++;
			console.log(`  [${new Date().toISOString().slice(11, 23)}] MNDP from ${srcMac(frame)}:`, fields);
			// Inject a refresh back in the detected framing to prove write-back works.
			if (conn && stats.mndp === 1) injectRefresh(conn, framing);
		}
	}
}

// length-prefixed or raw refresh frame (broadcast, payload 00 00 00 00)
function buildRefreshFrame(withLen: boolean): Buffer {
	const payload = Buffer.from([0, 0, 0, 0]);
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
	if (!withLen) return frame;
	const hdr = Buffer.alloc(4); hdr.writeUInt32BE(frame.length, 0);
	return Buffer.concat([hdr, frame]);
}
function injectRefresh(c: net.Socket, framing: Framing) {
	if (framing === "unknown") return;
	c.write(buildRefreshFrame(framing === "length-prefixed"));
	console.log(`  injected refresh (${framing})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
