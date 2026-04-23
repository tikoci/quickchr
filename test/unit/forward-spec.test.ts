import { describe, test, expect } from "bun:test";
import { parseForwardSpec } from "../../src/lib/forward-spec.ts";
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
