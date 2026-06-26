import { describe, test, expect } from "bun:test";
import { parseForwardSpec, expandForwardSpec, FORWARD_RANGE_MAX } from "../../src/lib/forward-spec.ts";
import { QuickCHRError } from "../../src/lib/types.ts";

describe("parseForwardSpec", () => {
	test("known service short form fills guest+proto from registry, host=0 (auto)", () => {
		expect(parseForwardSpec("smb")).toEqual({
			name: "smb",
			host: 0,
			guest: 445,
			proto: "tcp",
		});
	});

	test("alias resolves to canonical guest/proto but preserves the typed name", () => {
		// Decision: preserve the original spelling ("cifs") as the label,
		// but inherit guest=445/tcp from the canonical "smb" entry. This keeps
		// `quickchr list` showing what the user typed.
		expect(parseForwardSpec("cifs")).toEqual({
			name: "cifs",
			host: 0,
			guest: 445,
			proto: "tcp",
		});
	});

	test("name is case-insensitive for registry lookup", () => {
		expect(parseForwardSpec("SMB")).toEqual({
			name: "SMB",
			host: 0,
			guest: 445,
			proto: "tcp",
		});
	});

	test("pinned host port for known service", () => {
		expect(parseForwardSpec("smb:9145")).toEqual({
			name: "smb",
			host: 9145,
			guest: 445,
			proto: "tcp",
		});
	});

	test("WinBox pinning recipe maps host 8291 to guest 8291", () => {
		expect(parseForwardSpec("winbox:8291")).toEqual({
			name: "winbox",
			host: 8291,
			guest: 8291,
			proto: "tcp",
		});
	});

	test("fully explicit spec name:host:guest/proto", () => {
		expect(parseForwardSpec("foo:9200:7777/udp")).toEqual({
			name: "foo",
			host: 9200,
			guest: 7777,
			proto: "udp",
		});
	});

	test("explicit proto overrides registry proto", () => {
		expect(parseForwardSpec("dns/tcp")).toEqual({
			name: "dns",
			host: 0,
			guest: 53,
			proto: "tcp",
		});
	});

	test("unknown service without explicit guest throws INVALID_FORWARD_SPEC", () => {
		expect(() => parseForwardSpec("myservice:9200")).toThrow(QuickCHRError);
		try {
			parseForwardSpec("myservice:9200");
		} catch (err) {
			expect(err).toBeInstanceOf(QuickCHRError);
			expect((err as QuickCHRError).code).toBe("INVALID_FORWARD_SPEC");
			expect((err as Error).message).toContain("myservice:9200");
			expect((err as Error).message).toContain("guest port required");
		}
	});

	test("invalid proto throws", () => {
		expect(() => parseForwardSpec("foo:1:2/sctp")).toThrow(QuickCHRError);
		try {
			parseForwardSpec("foo:1:2/sctp");
		} catch (err) {
			expect((err as QuickCHRError).code).toBe("INVALID_FORWARD_SPEC");
			expect((err as Error).message).toContain("sctp");
		}
	});

	test("host port out of range throws", () => {
		expect(() => parseForwardSpec("smb:70000")).toThrow(QuickCHRError);
	});

	test("guest port out of range throws", () => {
		expect(() => parseForwardSpec("foo:9200:70000/tcp")).toThrow(QuickCHRError);
	});

	test("guest port = 0 is rejected (0 not allowed for guest)", () => {
		expect(() => parseForwardSpec("foo:9200:0/tcp")).toThrow(QuickCHRError);
	});

	test("non-numeric host port throws", () => {
		expect(() => parseForwardSpec("smb:abc")).toThrow(QuickCHRError);
	});

	test("empty spec throws", () => {
		expect(() => parseForwardSpec("")).toThrow(QuickCHRError);
		expect(() => parseForwardSpec("   ")).toThrow(QuickCHRError);
	});

	test("missing name throws", () => {
		expect(() => parseForwardSpec(":9200")).toThrow(QuickCHRError);
	});

	test("too many colon segments throws", () => {
		expect(() => parseForwardSpec("foo:1:2:3")).toThrow(QuickCHRError);
	});

	test("host=0 host auto-allocation form (explicit)", () => {
		expect(parseForwardSpec("smb:0")).toEqual({
			name: "smb",
			host: 0,
			guest: 445,
			proto: "tcp",
		});
	});

	test("alias with explicit override of host", () => {
		expect(parseForwardSpec("cifs:9145")).toEqual({
			name: "cifs",
			host: 9145,
			guest: 445,
			proto: "tcp",
		});
	});

	test("error message includes original spec", () => {
		try {
			parseForwardSpec("nope:abc");
		} catch (err) {
			expect((err as Error).message).toContain("nope:abc");
		}
	});
});

describe("expandForwardSpec", () => {
	test("single-port spec delegates to parseForwardSpec (parity)", () => {
		expect(expandForwardSpec("smb")).toEqual([{ name: "smb", host: 0, guest: 445, proto: "tcp" }]);
		expect(expandForwardSpec("foo:9200:7777/udp")).toEqual([
			{ name: "foo", host: 9200, guest: 7777, proto: "udp" },
		]);
	});

	test("host+guest range expands to one mapping per port with unique keys", () => {
		expect(expandForwardSpec("btest:9200-9202:2000-2002/udp")).toEqual([
			{ name: "btest-9200", host: 9200, guest: 2000, proto: "udp" },
			{ name: "btest-9201", host: 9201, guest: 2001, proto: "udp" },
			{ name: "btest-9202", host: 9202, guest: 2002, proto: "udp" },
		]);
	});

	test("host-only range defaults guest range to host numbers", () => {
		expect(expandForwardSpec("svc:9300-9301")).toEqual([
			{ name: "svc-9300", host: 9300, guest: 9300, proto: "tcp" },
			{ name: "svc-9301", host: 9301, guest: 9301, proto: "tcp" },
		]);
	});

	test("proto inherits from registry for a range when no /proto given", () => {
		// snmp is registered as udp; a host-only range keeps that proto
		expect(expandForwardSpec("snmp:9400-9401")).toEqual([
			{ name: "snmp-9400", host: 9400, guest: 9400, proto: "udp" },
			{ name: "snmp-9401", host: 9401, guest: 9401, proto: "udp" },
		]);
	});

	test("single-port range (start==end) yields one mapping", () => {
		expect(expandForwardSpec("svc:9500-9500:2000-2000/tcp")).toEqual([
			{ name: "svc-9500", host: 9500, guest: 2000, proto: "tcp" },
		]);
	});

	test("mismatched range lengths throw INVALID_FORWARD_SPEC", () => {
		try {
			expandForwardSpec("btest:9200-9210:2000-2002/udp");
			throw new Error("should have thrown");
		} catch (err) {
			expect((err as QuickCHRError).code).toBe("INVALID_FORWARD_SPEC");
			expect((err as Error).message).toContain("same length");
		}
	});

	test("host range with a single-port guest segment throws (must be a range)", () => {
		try {
			expandForwardSpec("svc:9200-9201:2000/udp");
			throw new Error("should have thrown");
		} catch (err) {
			expect((err as QuickCHRError).code).toBe("INVALID_FORWARD_SPEC");
			expect((err as Error).message).toContain("must be a range");
		}
	});

	test("reversed range throws", () => {
		try {
			expandForwardSpec("svc:9210-9200");
			throw new Error("should have thrown");
		} catch (err) {
			expect((err as QuickCHRError).code).toBe("INVALID_FORWARD_SPEC");
			expect((err as Error).message).toContain("below start");
		}
	});

	test("range over the cap throws", () => {
		const end = 9000 + FORWARD_RANGE_MAX; // span = FORWARD_RANGE_MAX + 1 ports
		try {
			expandForwardSpec(`svc:9000-${end}`);
			throw new Error("should have thrown");
		} catch (err) {
			expect((err as QuickCHRError).code).toBe("INVALID_FORWARD_SPEC");
			expect((err as Error).message).toContain("cap");
		}
	});

	test("non-numeric range bound throws", () => {
		expect(() => expandForwardSpec("svc:9200-abc")).toThrow(QuickCHRError);
	});

	test("range with bad proto throws", () => {
		expect(() => expandForwardSpec("svc:9200-9201/sctp")).toThrow(QuickCHRError);
	});

	test("empty spec throws", () => {
		expect(() => expandForwardSpec("")).toThrow(QuickCHRError);
	});
});
