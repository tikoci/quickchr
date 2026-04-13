import { describe, test, expect } from "bun:test";
import { parseNetworkSpecifier } from "../../src/lib/network.ts";
import { QuickCHRError } from "../../src/lib/types.ts";

describe("parseNetworkSpecifier", () => {
	// ── Literal specifiers ──────────────────────────────────────────

	test("parses 'user'", () => {
		expect(parseNetworkSpecifier("user")).toBe("user");
	});

	test("parses 'shared'", () => {
		expect(parseNetworkSpecifier("shared")).toBe("shared");
	});

	test("parses 'vmnet-shared'", () => {
		expect(parseNetworkSpecifier("vmnet-shared")).toBe("vmnet-shared");
	});

	// ── Aliases ─────────────────────────────────────────────────────

	test("parses 'auto' as shared", () => {
		expect(parseNetworkSpecifier("auto")).toBe("shared");
	});

	test("parses 'wifi' as bridged:wifi", () => {
		expect(parseNetworkSpecifier("wifi")).toEqual({
			type: "bridged",
			iface: "wifi",
		});
	});

	test("parses 'ethernet' as bridged:ethernet", () => {
		expect(parseNetworkSpecifier("ethernet")).toEqual({
			type: "bridged",
			iface: "ethernet",
		});
	});

	// ── Bridged ─────────────────────────────────────────────────────

	test("parses 'bridged:en0'", () => {
		expect(parseNetworkSpecifier("bridged:en0")).toEqual({
			type: "bridged",
			iface: "en0",
		});
	});

	test("parses 'vmnet-bridged:en0'", () => {
		expect(parseNetworkSpecifier("vmnet-bridged:en0")).toEqual({
			type: "vmnet-bridged",
			iface: "en0",
		});
	});

	// ── Socket specifiers ───────────────────────────────────────────

	test("parses 'socket::mylink' (named)", () => {
		expect(parseNetworkSpecifier("socket::mylink")).toEqual({
			type: "socket",
			name: "mylink",
		});
	});

	test("parses 'socket:listen:4001'", () => {
		expect(parseNetworkSpecifier("socket:listen:4001")).toEqual({
			type: "socket-listen",
			port: 4001,
		});
	});

	test("parses 'socket:connect:4001'", () => {
		expect(parseNetworkSpecifier("socket:connect:4001")).toEqual({
			type: "socket-connect",
			port: 4001,
		});
	});

	test("parses 'socket:mcast:230.0.0.1:4001'", () => {
		expect(parseNetworkSpecifier("socket:mcast:230.0.0.1:4001")).toEqual({
			type: "socket-mcast",
			group: "230.0.0.1",
			port: 4001,
		});
	});

	// ── TAP ─────────────────────────────────────────────────────────

	test("parses 'tap:tap-chr0'", () => {
		expect(parseNetworkSpecifier("tap:tap-chr0")).toEqual({
			type: "tap",
			ifname: "tap-chr0",
		});
	});

	// ── Whitespace trimming ─────────────────────────────────────────

	test("trims whitespace", () => {
		expect(parseNetworkSpecifier("  user  ")).toBe("user");
	});

	// ── Error cases ─────────────────────────────────────────────────

	test("throws on empty string", () => {
		expect(() => parseNetworkSpecifier("")).toThrow(QuickCHRError);
	});

	test("throws on unknown specifier", () => {
		expect(() => parseNetworkSpecifier("invalid")).toThrow(QuickCHRError);
	});

	test("throws on bridged: without interface", () => {
		expect(() => parseNetworkSpecifier("bridged:")).toThrow(QuickCHRError);
	});

	test("throws on vmnet-bridged: without interface", () => {
		expect(() => parseNetworkSpecifier("vmnet-bridged:")).toThrow(
			QuickCHRError,
		);
	});

	test("throws on tap: without interface", () => {
		expect(() => parseNetworkSpecifier("tap:")).toThrow(QuickCHRError);
	});

	test("throws on socket:: without name", () => {
		expect(() => parseNetworkSpecifier("socket::")).toThrow(QuickCHRError);
	});

	test("throws on socket:listen with invalid port", () => {
		expect(() => parseNetworkSpecifier("socket:listen:abc")).toThrow(
			QuickCHRError,
		);
	});

	test("throws on socket:listen with port out of range", () => {
		expect(() => parseNetworkSpecifier("socket:listen:99999")).toThrow(
			QuickCHRError,
		);
	});

	test("throws on socket:mcast missing port", () => {
		expect(() => parseNetworkSpecifier("socket:mcast:230.0.0.1")).toThrow(
			QuickCHRError,
		);
	});

	test("throws on unknown socket subtype", () => {
		expect(() => parseNetworkSpecifier("socket:bogus:1234")).toThrow(
			QuickCHRError,
		);
	});

	test("error has INVALID_NETWORK code", () => {
		try {
			parseNetworkSpecifier("nonsense");
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(QuickCHRError);
			expect((err as QuickCHRError).code).toBe("INVALID_NETWORK");
		}
	});
});
