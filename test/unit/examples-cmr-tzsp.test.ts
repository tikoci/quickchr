// cspell:ignore sgsol Abxlr fefa -- fields of a captured RouterOS announcement (software-id, IPv6)
import { describe, expect, test } from "bun:test";
import { decodeEthernet, decodeTzsp, type Packet, parseMndp, tzspPayload } from "../../examples/cmr/tool/tzsp.ts";
import { dedupe, type Seen, spread } from "../../examples/cmr/tool/wire.ts";

/**
 * The CMR lab's TZSP/MNDP decoder (examples/cmr/tool/tzsp.ts) against datagrams captured from
 * RouterOS 7.26beta5 x86 CHR `/tool/sniffer` streaming, 2026-11-14 (FINDINGS.md → Wire).
 * Real bytes, so a decoder regression or a spin-out that changes byte handling shows here.
 */

// The CMR controller's IPv4 MNDP announcement on its link, before (`off`) and after (`cmr`) `/cmr set enabled=yes`.
const MNDP_OFF = "0100000101ffffffffffff02fcb1face5f0800450000bc000000004011b830c0000201ffffffff162e162e00a8327d050000000001000602fcb1face5f0005000e636d722d636f6e74726f6c6c65720007001d372e3236626574613520323032362d31302d33302031313a31333a3535000800084d696b726f54696b000a000442000000000b000b7367736f6c4162786c7244000c0003434852000e000101001000066574686572320012000100001300017900110004c0000201000f0010fe8000000000000000fcb1fffeface5f";
const MNDP_CMR = "0100000101ffffffffffff02fcb1face5f0800450000bc000000004011b830c0000201ffffffff162e162e00a82d32080000000001000602fcb1face5f0005000e636d722d636f6e74726f6c6c65720007001d372e3236626574613520323032362d31302d33302031313a31333a3535000800084d696b726f54696b000a00048d000000000b000b7367736f6c4162786c7244000c0003434852000e000101001000066574686572320012000102001300017900110004c0000201000f0010fe8000000000000000fcb1fffeface5f";
// The client's first SYN to the controller's CMR service.
const CMR_SYN = "010000010102fcb1face5f026401f40b5808004500003c3b13400040067ba5c0000202c00002018c50d431a771961b00000000a002faf00c960000020405b40402080a0deb107c0000000001030306";

describe("tzsp", () => {
	test("strips the RouterOS header (version 1, Ethernet, end tag only)", () => {
		const frame = tzspPayload(Buffer.from(CMR_SYN, "hex"));
		expect(frame?.subarray(0, 6).toString("hex")).toBe("02fcb1face5f");
	});

	test("rejects a datagram that is not TZSP v1 Ethernet", () => {
		expect(tzspPayload(Buffer.from("02000001010000", "hex"))).toBeUndefined();
		expect(tzspPayload(Buffer.from("0100001201", "hex"))).toBeUndefined();
	});

	test("decodes an MNDP announcement with the 7.26 TLVs", () => {
		const packet = decodeTzsp(Buffer.from(MNDP_CMR, "hex"));
		expect(packet).toMatchObject({ proto: "udp", family: 4, src: "192.0.2.1", dst: "255.255.255.255", srcPort: 5678, dstPort: 5678 });
		const mndp = packet?.mndp;
		expect(mndp?.header).toBe("08000000");
		expect(mndp?.fields).toMatchObject({
			mac: "02:fc:b1:fa:ce:5f", identity: "cmr-controller", version: "7.26beta5 2026-10-30 11:13:55",
			platform: "MikroTik", uptime: "141", "software-id": "sgsolAbxlrD", board: "CHR", unpack: "01",
			interface: "ether2", running: "02", "tlv-19": "79", ipv4: "192.0.2.1", ipv6: "fe80::fc:b1ff:fefa:ce5f",
		});
		// Every TLV keeps its raw bytes, so a report can be re-decoded after the TLV table changes.
		expect(mndp?.tlvs.find(t => t.type === 19)?.hex).toBe("79");
		expect(packet?.payloadHex?.startsWith("08000000")).toBe(true);
	});

	test("TLV 18 is the only TLV besides uptime and the counter that changed when CMR started", () => {
		const off = parseMndp(Buffer.from(decodeTzsp(Buffer.from(MNDP_OFF, "hex"))?.payloadHex ?? "", "hex"));
		const on = parseMndp(Buffer.from(decodeTzsp(Buffer.from(MNDP_CMR, "hex"))?.payloadHex ?? "", "hex"));
		const changed = on.tlvs.filter((tlv, i) => tlv.hex !== off.tlvs[i]?.hex).map(t => t.name);
		expect(changed).toEqual(["uptime", "running"]);
		expect([off.fields.running, on.fields.running]).toEqual(["00", "02"]);
	});

	test("decodes a TCP SYN to the CMR port", () => {
		expect(decodeTzsp(Buffer.from(CMR_SYN, "hex"))).toMatchObject({
			proto: "tcp", src: "192.0.2.2", dst: "192.0.2.1", srcPort: 35920, dstPort: 54321, flags: "S", length: 0,
		});
	});

	test("a truncated TLV ends the list instead of throwing", () => {
		const mndp = parseMndp(Buffer.from("00000000000500ff6162", "hex"));
		expect(mndp.tlvs).toEqual([]);
	});

	test("a frame cut short in its IP or TCP header decodes as truncated instead of throwing", () => {
		const syn = tzspPayload(Buffer.from(CMR_SYN, "hex")) as Buffer;
		for (const length of [12, 14, 20, 33, 40, 50]) {
			expect(decodeEthernet(syn.subarray(0, length)).proto).toBe("truncated");
		}
		expect(decodeEthernet(syn).proto).toBe("tcp");
	});
});

describe("wire capture helpers", () => {
	const segment = (srcMac: string, seq = 1): Packet => ({
		src: "198.51.100.2", dst: "10.255.0.1", srcMac, dstMac: "02:00:00:00:00:ff", proto: "tcp", family: 4,
		srcPort: 40000, dstPort: 54321, flags: "PA", seq, ack: 1, length: 145,
	});
	const at = (t: number, router: string, packet: Packet): Seen => ({ t, router, packet });

	test("one forwarded segment seen at four capture points is kept once", () => {
		// remote sends; transit sees it arrive (remote's MAC) and leave (its own MAC); controller receives.
		const kept = dedupe([
			at(0, "remote", segment("02:00:00:00:00:0b")),
			at(1, "transit", segment("02:00:00:00:00:0b")),
			at(1, "transit", segment("02:00:00:00:00:0a")),
			at(2, "controller", segment("02:00:00:00:00:0a")),
		]);
		expect(kept.map(s => s.router)).toEqual(["remote"]);
	});

	test("a retransmission is kept, even one sent sooner than the duplicate window", () => {
		const kept = dedupe([
			at(0, "client", segment("02:00:00:00:00:0b")),
			at(1, "controller", segment("02:00:00:00:00:0b")),
			at(200, "client", segment("02:00:00:00:00:0b")),
			at(201, "controller", segment("02:00:00:00:00:0b")),
			at(2000, "client", segment("02:00:00:00:00:0b")),
		]);
		expect(kept.map(s => s.t)).toEqual([0, 200, 2000]);
	});

	test("median averages the middle two for an even count", () => {
		expect(spread([30, 10, 40, 20])).toEqual({ minMs: 10, medianMs: 25, maxMs: 40 });
		expect(spread([3, 1, 2])).toEqual({ minMs: 1, medianMs: 2, maxMs: 3 });
		expect(spread([])).toEqual({ minMs: 0, medianMs: 0, maxMs: 0 });
	});
});
