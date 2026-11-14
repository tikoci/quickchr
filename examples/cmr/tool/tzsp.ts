/**
 * TZSP receiver and frame decoder for RouterOS `/tool/sniffer` streams.
 *
 * Standalone on purpose: this file imports nothing from quickchr or the CMR lab, only
 * `node:dgram`, so it can move to quickchr's library, centrs, or its own package without edits.
 * The lab-specific part (which routers stream, lab event marks, CMR summaries) is `wire.ts`.
 * See README.md → "Wire capture" for the design notes kept for that spin-out.
 *
 * Data path, grounded on RouterOS 7.26beta5 x86 CHR under QEMU user-mode networking:
 *
 *   router: /tool/sniffer set filter-interface=<links> streaming-enabled=yes
 *             streaming-server=10.0.2.2:<port> filter-stream=yes ; /tool/sniffer start
 *   QEMU SLIRP delivers guest UDP sent to 10.0.2.2:<port> to the host's 127.0.0.1:<port>
 *   host:   TzspReceiver bound to 127.0.0.1:<ephemeral> (one per router: SLIRP hides which
 *           guest sent a datagram, so a separate port is the only reliable label)
 *
 * TZSP as RouterOS sends it: `01 00 00 01` (version 1, type 0 "received", encapsulation 1
 * Ethernet), then tagged fields ending in tag `01`. RouterOS sends only the end tag, so the
 * Ethernet frame starts at byte 5. Tags 0 (padding) and 1 (end) are one byte; other tags are
 * tag, length, value. Frames include the router's own transmissions on the filtered interfaces.
 *
 * MNDP: the TLV table follows the routeros-mndp skill (MAC-Telnet `protocol.c`, the Wireshark
 * dissector). Two TLVs it does not list were seen on 7.26beta5 and are decoded here from lab
 * evidence (examples/cmr/FINDINGS.md → Wire): 18 and 19, both 1 byte. Every TLV keeps its raw
 * bytes (`hex`), so a later reader can re-decode a report without the original capture.
 */
import { createSocket, type Socket } from "node:dgram";

export interface TzspFrame {
	/** Milliseconds since the receiver's clock origin. */
	t: number;
	/** The label the receiver was opened with (e.g. the router name). */
	source: string;
	/** The whole TZSP datagram. */
	bytes: Buffer;
}

/**
 * One UDP socket that collects TZSP datagrams. `close()` must be called: an open dgram socket
 * keeps Bun's event loop alive, and a run that forgets it never exits.
 */
export class TzspReceiver {
	readonly frames: TzspFrame[] = [];
	private socket?: Socket;
	constructor(readonly source: string, private readonly origin: number = Date.now(), private readonly onFrame?: (frame: TzspFrame) => void) {}

	/** Bind 127.0.0.1 on an ephemeral port and return the port. */
	open(host = "127.0.0.1"): Promise<number> {
		return new Promise((resolve, reject) => {
			const socket = createSocket("udp4");
			this.socket = socket;
			socket.once("error", reject);
			socket.on("message", bytes => {
				const frame = { t: Date.now() - this.origin, source: this.source, bytes };
				this.frames.push(frame);
				this.onFrame?.(frame);
			});
			socket.bind(0, host, () => resolve(socket.address().port));
		});
	}

	close(): void {
		this.socket?.close();
		this.socket = undefined;
	}
}

/** The Ethernet frame inside a TZSP datagram, or undefined if it is not Ethernet-encapsulated. */
export function tzspPayload(datagram: Buffer): Buffer | undefined {
	if (datagram.length < 5 || datagram[0] !== 1) return undefined;
	if (datagram.readUInt16BE(2) !== 1) return undefined; // encapsulation: 1 = Ethernet
	let offset = 4;
	while (offset < datagram.length) {
		const tag = datagram[offset] as number;
		if (tag === 1) return datagram.subarray(offset + 1);
		if (tag === 0) { offset += 1; continue; }
		offset += 2 + (datagram[offset + 1] ?? 0);
	}
	return undefined;
}

export interface MndpTlv {
	type: number;
	/** A name from the table below, or `tlv-<type>` for one nobody has identified. */
	name: string;
	/** Decoded value: text, dotted/colon address, number, or hex for opaque bytes. */
	value: string;
	hex: string;
}

export interface Mndp {
	/** The 4-byte header, hex. On 7.26beta5 byte 0 counts up per announcement; bytes 1-3 were 0. */
	header: string;
	tlvs: MndpTlv[];
	/** Convenience lookups by name (first occurrence). */
	fields: Record<string, string>;
}

const MNDP_NAMES: Record<number, string> = {
	1: "mac", 5: "identity", 7: "version", 8: "platform", 10: "uptime", 11: "software-id", 12: "board",
	14: "unpack", 15: "ipv6", 16: "interface", 17: "ipv4",
	// Lab evidence, 7.26beta5: 0x00 normally, 0x02 while the router runs a CMR controller, and the
	// neighbor's /ip/neighbor row then shows running=cmr. A bitmask is likely; other bits unseen.
	18: "running",
};
const TEXT = new Set([5, 7, 8, 11, 12, 16]);

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const mac = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, "0")).join(":");
const ipv4 = (b: Uint8Array) => [...b].join(".");
function ipv6(b: Uint8Array): string {
	const groups: string[] = [];
	for (let i = 0; i < 16; i += 2) groups.push((((b[i] as number) << 8) | (b[i + 1] as number)).toString(16));
	// RFC 5952: compress the longest run (two or more) of zero groups, the first one on a tie.
	let best = -1, bestLength = 1;
	for (let i = 0; i < 8;) {
		let j = i;
		while (j < 8 && groups[j] === "0") j++;
		if (j - i > bestLength) { best = i; bestLength = j - i; }
		i = j === i ? i + 1 : j;
	}
	if (best < 0) return groups.join(":");
	return `${groups.slice(0, best).join(":")}::${groups.slice(best + bestLength).join(":")}`;
}

/** Parse an MNDP announcement (the UDP payload). Never throws; a truncated TLV ends the list. */
export function parseMndp(payload: Buffer): Mndp {
	const tlvs: MndpTlv[] = [];
	let offset = 4;
	while (offset + 4 <= payload.length) {
		const type = payload.readUInt16BE(offset);
		const length = payload.readUInt16BE(offset + 2);
		offset += 4;
		if (offset + length > payload.length) break;
		const v = payload.subarray(offset, offset + length);
		offset += length;
		let value = hex(v);
		if (TEXT.has(type)) value = v.toString("utf8");
		else if (type === 1 && length === 6) value = mac(v);
		else if (type === 10 && length === 4) value = String(v.readUInt32LE(0)); // the one little-endian value
		else if (type === 17 && length === 4) value = ipv4(v);
		else if (type === 15 && length === 16) value = ipv6(v);
		tlvs.push({ type, name: MNDP_NAMES[type] ?? `tlv-${type}`, value, hex: hex(v) });
	}
	const fields: Record<string, string> = {};
	for (const tlv of tlvs) fields[tlv.name] ??= tlv.value;
	return { header: hex(payload.subarray(0, 4)), tlvs, fields };
}

export interface Packet {
	/** IP source for IP packets, else the source MAC. */
	src: string;
	dst: string;
	/** The Ethernet addresses, for every packet. A forwarded IP packet keeps its IP addresses and
	 *  changes these at each hop, which tells one router's ingress and egress copies apart. */
	srcMac: string;
	dstMac: string;
	/** `arp`, `lldp`, `cdp` (802.3/LLC to Cisco's multicast), `llc`, `ether-0x…`, `udp`, `tcp`, `ospf`,
	 *  `icmp`, `icmp6`, `ip-<n>`, or `truncated` when a header is cut short. */
	proto: string;
	family?: 4 | 6;
	srcPort?: number;
	dstPort?: number;
	/** TCP flags as letters in S, F, R, P, A order, e.g. `S`, `SA`, `PA`, `FA`, `R`, `A`. */
	flags?: string;
	seq?: number;
	ack?: number;
	/** L4 payload bytes (UDP/TCP), else the frame length. */
	length: number;
	mndp?: Mndp;
	/** UDP payload for MNDP, hex: lets a report be re-decoded later. */
	payloadHex?: string;
}

/**
 * Decode one Ethernet frame into the fields a protocol timeline needs. Never throws: a frame whose
 * IP or transport header is cut short decodes as `proto: "truncated"`, so one bad datagram cannot
 * stop a report.
 */
export function decodeEthernet(frame: Buffer): Packet {
	const dstMac = mac(frame.subarray(0, 6));
	const srcMac = mac(frame.subarray(6, 12));
	const l2 = (proto: string): Packet => ({ src: srcMac, dst: dstMac, srcMac, dstMac, proto, length: frame.length });
	if (frame.length < 14) return l2("truncated");
	let type = frame.readUInt16BE(12);
	let o = 14;
	if (type === 0x8100) {
		if (frame.length < 18) return l2("truncated");
		type = frame.readUInt16BE(16);
		o = 18;
	}
	if (type < 0x0600) return l2(dstMac === "01:00:0c:cc:cc:cc" ? "cdp" : "llc");
	if (type === 0x0806) return l2("arp");
	if (type === 0x88cc) return l2("lldp");
	let src: string, dst: string, protocol: number, l4: number, l4End: number;
	let family: 4 | 6;
	if (type === 0x0800) {
		if (frame.length < o + 20) return l2("truncated");
		family = 4;
		const ihl = ((frame[o] as number) & 0x0f) * 4;
		if (ihl < 20 || frame.length < o + ihl) return l2("truncated");
		protocol = frame[o + 9] as number;
		src = ipv4(frame.subarray(o + 12, o + 16));
		dst = ipv4(frame.subarray(o + 16, o + 20));
		l4 = o + ihl;
		l4End = Math.min(frame.length, o + frame.readUInt16BE(o + 2));
	} else if (type === 0x86dd) {
		if (frame.length < o + 40) return l2("truncated");
		family = 6;
		protocol = frame[o + 6] as number; // extension headers are not followed
		src = ipv6(frame.subarray(o + 8, o + 24));
		dst = ipv6(frame.subarray(o + 24, o + 40));
		l4 = o + 40;
		l4End = Math.min(frame.length, l4 + frame.readUInt16BE(o + 4));
	} else {
		return l2(`ether-0x${type.toString(16).padStart(4, "0")}`);
	}
	const base = { src, dst, srcMac, dstMac, family };
	const truncated: Packet = { ...base, proto: "truncated", length: frame.length };
	if (protocol === 17) {
		if (l4End < l4 + 8) return truncated;
		const srcPort = frame.readUInt16BE(l4), dstPort = frame.readUInt16BE(l4 + 2);
		const payload = frame.subarray(l4 + 8, l4End);
		const packet: Packet = { ...base, proto: "udp", srcPort, dstPort, length: payload.length };
		if (srcPort === 5678 && dstPort === 5678) {
			packet.mndp = parseMndp(payload);
			packet.payloadHex = payload.toString("hex");
		}
		return packet;
	}
	if (protocol === 6) {
		if (l4End < l4 + 20) return truncated;
		const srcPort = frame.readUInt16BE(l4), dstPort = frame.readUInt16BE(l4 + 2);
		const bits = frame[l4 + 13] as number;
		const dataOffset = ((frame[l4 + 12] as number) >> 4) * 4;
		if (dataOffset < 20 || l4End < l4 + dataOffset) return truncated;
		const flags = [[0x02, "S"], [0x01, "F"], [0x04, "R"], [0x08, "P"], [0x10, "A"]].filter(([bit]) => bits & (bit as number)).map(([, l]) => l).join("");
		return { ...base, proto: "tcp", srcPort, dstPort, flags, seq: frame.readUInt32BE(l4 + 4), ack: frame.readUInt32BE(l4 + 8), length: l4End - l4 - dataOffset };
	}
	const names: Record<number, string> = { 1: "icmp", 58: "icmp6", 89: "ospf" };
	return { ...base, proto: names[protocol] ?? `ip-${protocol}`, length: Math.max(0, l4End - l4) };
}

/** Decode a TZSP datagram end to end; undefined when it does not carry Ethernet. */
export function decodeTzsp(datagram: Buffer): Packet | undefined {
	const frame = tzspPayload(datagram);
	return frame && frame.length >= 12 ? decodeEthernet(frame) : undefined;
}
