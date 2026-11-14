/**
 * Wire capture for the CMR lab: every router streams its topology links to the host over TZSP,
 * and lab events are marked on the same clock. `--sniff` turns it on for any run; the `wire`
 * study always uses it.
 *
 * The generic part (receiving and decoding TZSP, MNDP, TCP) is `tzsp.ts`. This file is the lab
 * glue: which interfaces each router sniffs, re-arming after a reboot, and the summary written to
 * a report. README.md → "Wire capture" has the design notes for a future shared TZSP package.
 *
 * Why RouterOS's sniffer and not a host capture: the lab's links are `socket::<name>` pairs,
 * which the host cannot join (docs/mndp.md). Each router therefore reports its own links.
 * Both ends of a link see the same packet, so MNDP and TCP are deduplicated (`packets()`),
 * keeping retransmissions from the same router.
 */
import type { ChrInstance } from "../../../src/index.ts";
import { decodeTzsp, type Packet, TzspReceiver } from "./tzsp.ts";

export interface Mark { t: number; label: string; data?: unknown }
export interface Seen { t: number; router: string; packet: Packet }

/** Both ends of a link report one packet this close together (host arrival, same machine). */
const DUPLICATE_WINDOW_MS = 250;

/** The CMR service port (`/ip/service` name `cmr`). */
export const CMR_PORT = 54321;

/** The capture the lab hooks use; undefined unless `--sniff` or the `wire` study set it. */
export const wire: { capture?: Capture } = {};

const REJECTED = /^(failure:|syntax error|bad command name|expected |input does not match|no such item|not enough permissions)/m;

export class Capture {
	readonly origin = Date.now();
	readonly marks: Mark[] = [];
	private readonly routers = new Map<string, { receiver: TzspReceiver; port: number; interfaces: string[]; attached: number[] }>();

	/** Milliseconds since the capture started; the clock every mark and packet uses. */
	now(): number { return Date.now() - this.origin; }

	mark(label: string, data?: unknown): void {
		this.marks.push({ t: this.now(), label, ...(data === undefined ? {} : { data }) });
	}

	/**
	 * Stream `interfaces` of `chr` to a host port of its own. Call again after the router reboots;
	 * it sets every sniffer setting again, so it does not depend on what survives a reboot. Never
	 * sniff the management NIC (ether1): it carries the TZSP stream and the lab's REST calls.
	 */
	async attach(chr: ChrInstance, interfaces: string[]): Promise<void> {
		let entry = this.routers.get(chr.name);
		if (!entry) {
			const receiver = new TzspReceiver(chr.name, this.origin);
			entry = { receiver, port: await receiver.open(), interfaces, attached: [] };
			this.routers.set(chr.name, entry);
		}
		const run = async (line: string) => {
			const { output } = await chr.exec(line);
			if (REJECTED.test(output)) throw new Error(`${chr.name}: ${line}: ${output}`);
		};
		await run(`/tool/sniffer/set filter-interface=${interfaces.join(",")} streaming-enabled=yes streaming-server=${chr.hostGatewayIp}:${entry.port} filter-stream=yes`);
		await chr.exec("/tool/sniffer/stop");
		await run("/tool/sniffer/start");
		entry.attached.push(this.now());
		this.mark(`sniffer on ${chr.name}`, { interfaces });
	}

	/** Close every host socket. Without this the process never exits (open dgram sockets). */
	close(): void {
		for (const { receiver } of this.routers.values()) receiver.close();
	}

	/**
	 * Every decoded packet in time order. MNDP announcements and TCP segments seen by both ends
	 * of a link are kept once (the first sighting); other protocols are kept per router.
	 */
	packets(): Seen[] {
		const all: Seen[] = [];
		for (const [router, { receiver }] of this.routers) {
			for (const frame of receiver.frames) {
				const packet = decodeTzsp(frame.bytes);
				if (packet) all.push({ t: frame.t, router, packet });
			}
		}
		all.sort((a, b) => a.t - b.t);
		// The other end's copy of a packet arrives within milliseconds. A repeat from the same
		// router is a real retransmission (a SYN that got no answer) and must stay.
		const seen = new Map<string, { router: string; t: number }>();
		return all.filter(({ t, router, packet: p }) => {
			const key = p.mndp ? `mndp|${p.mndp.fields.identity}|${p.mndp.fields.interface}|${p.family}|${p.mndp.header}`
				: p.proto === "tcp" ? `tcp|${p.src}:${p.srcPort}>${p.dst}:${p.dstPort}|${p.flags}|${p.seq}|${p.ack}|${p.length}`
				: undefined;
			if (!key) return true;
			const first = seen.get(key);
			if (first && first.router !== router && t - first.t < DUPLICATE_WINDOW_MS) return false;
			seen.set(key, { router, t });
			return true;
		});
	}

	/** CMR TCP segments between two capture times (ms), deduplicated. */
	cmrBetween(from: number, to = Number.POSITIVE_INFINITY): Seen[] {
		return this.packets().filter(s => s.t >= from && s.t <= to && s.packet.proto === "tcp" && (s.packet.srcPort === CMR_PORT || s.packet.dstPort === CMR_PORT));
	}

	/** The last MNDP announcement from `identity` before time `t`, if any. */
	lastMndp(identity: string, t: number): Seen | undefined {
		return this.packets().filter(s => s.t < t && s.packet.mndp?.fields.identity === identity).at(-1);
	}

	/** The report section: marks, MNDP announcements, CMR sessions, and counts of everything else. */
	report(): WireReport {
		const packets = this.packets();
		const routers: WireReport["routers"] = {};
		for (const [name, { port, interfaces, attached, receiver }] of this.routers) routers[name] = { port, interfaces, attachedAt: attached, frames: receiver.frames.length };

		// MNDP: one row per announcement. TLVs and raw bytes only when they differ from that
		// sender's previous announcement on the same interface and family, so a report stays small.
		const mndp: WireReport["mndp"] = [];
		const previous = new Map<string, { t: number; signature: string }>();
		const intervals = new Map<string, number[]>();
		for (const { t, packet: p } of packets) {
			if (!p.mndp) continue;
			const sender = `${p.mndp.fields.identity}/${p.mndp.fields.interface}/v${p.family}`;
			const signature = p.mndp.tlvs.filter(tlv => tlv.name !== "uptime").map(tlv => `${tlv.type}=${tlv.hex}`).join(" ");
			const last = previous.get(sender);
			if (last) intervals.set(sender, [...(intervals.get(sender) ?? []), t - last.t]);
			const row: WireReport["mndp"][number] = { t, sender, header: p.mndp.header };
			if (last?.signature !== signature) {
				row.tlvs = Object.fromEntries(p.mndp.tlvs.map(tlv => [`${tlv.type}:${tlv.name}`, tlv.value]));
				row.payloadHex = p.payloadHex;
			}
			mndp.push(row);
			previous.set(sender, { t, signature });
		}
		const mndpIntervals: WireReport["mndpIntervals"] = {};
		for (const [sender, list] of intervals) {
			const sorted = [...list].sort((a, b) => a - b);
			mndpIntervals[sender] = { count: list.length + 1, minMs: sorted[0] ?? 0, medianMs: sorted[Math.floor(sorted.length / 2)] ?? 0, maxMs: sorted.at(-1) ?? 0 };
		}

		// CMR sessions, keyed by the client's ephemeral port. Bare ACKs (keepalives included) are
		// counted, not listed; everything with a flag other than ACK, or with payload, is listed.
		const sessions = new Map<string, WireReport["cmr"][number]>();
		for (const { t, packet: p } of packets) {
			if (p.proto !== "tcp" || (p.srcPort !== CMR_PORT && p.dstPort !== CMR_PORT)) continue;
			const toServer = p.dstPort === CMR_PORT;
			const client = toServer ? `${p.src}:${p.srcPort}` : `${p.dst}:${p.dstPort}`;
			const server = toServer ? `${p.dst}:${p.dstPort}` : `${p.src}:${p.srcPort}`;
			const key = `${client}>${server}`;
			let session = sessions.get(key);
			if (!session) { session = { client, server, first: t, last: t, bareAcks: 0, segments: [] }; sessions.set(key, session); }
			session.last = t;
			if (p.flags === "A" && p.length === 0) session.bareAcks++;
			else session.segments.push([t, toServer ? ">" : "<", p.flags ?? "", p.length]);
		}

		const other: WireReport["other"] = {};
		for (const { t, router, packet: p } of packets) {
			if (p.mndp || (p.proto === "tcp" && (p.srcPort === CMR_PORT || p.dstPort === CMR_PORT))) continue;
			const key = `${router} ${p.proto}${p.dstPort !== undefined ? `/${Math.min(p.srcPort ?? 0, p.dstPort)}` : ""}`;
			const entry = other[key] ?? { count: 0, first: t, last: t };
			other[key] = entry;
			entry.count++;
			entry.last = t;
		}
		return { startedAt: new Date(this.origin).toISOString(), clock: "ms since startedAt", routers, marks: this.marks, mndp, mndpIntervals, cmr: [...sessions.values()], other };
	}
}

export interface WireReport {
	startedAt: string;
	clock: string;
	routers: Record<string, { port: number; interfaces: string[]; attachedAt: number[]; frames: number }>;
	marks: Mark[];
	mndp: { t: number; sender: string; header: string; tlvs?: Record<string, string>; payloadHex?: string }[];
	mndpIntervals: Record<string, { count: number; minMs: number; medianMs: number; maxMs: number }>;
	/** Segments are [t, direction (> to the controller, < from it), TCP flags, payload bytes]. */
	cmr: { client: string; server: string; first: number; last: number; bareAcks: number; segments: [number, string, string, number][] }[];
	other: Record<string, { count: number; first: number; last: number }>;
}
