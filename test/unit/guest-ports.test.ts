import { describe, expect, test } from "bun:test";
import { lookupGuestPort, WELL_KNOWN_GUEST_PORTS } from "../../src/lib/guest-ports.ts";

describe("guest-ports registry", () => {
	test("lookupGuestPort('smb') returns the SMB entry", () => {
		const entry = lookupGuestPort("smb");
		expect(entry).toBeDefined();
		expect(entry?.name).toBe("smb");
		expect(entry?.guest).toBe(445);
		expect(entry?.proto).toBe("tcp");
	});

	test("lookupGuestPort('cifs') resolves to the SMB entry via alias", () => {
		const smb = lookupGuestPort("smb");
		const cifs = lookupGuestPort("cifs");
		expect(cifs).toBeDefined();
		expect(cifs).toBe(smb as NonNullable<typeof smb>);
	});

	test("lookupGuestPort('nonsense') returns undefined", () => {
		expect(lookupGuestPort("nonsense")).toBeUndefined();
	});

	test("lookupGuestPort is case-insensitive", () => {
		const lower = lookupGuestPort("smb");
		expect(lookupGuestPort("SMB")).toBe(lower as NonNullable<typeof lower>);
		expect(lookupGuestPort("Smb")).toBe(lower as NonNullable<typeof lower>);
		expect(lookupGuestPort("WINBOX")?.guest).toBe(8291);
	});

	test("lookupGuestPort returns undefined for empty string", () => {
		expect(lookupGuestPort("")).toBeUndefined();
	});

	test("all entries have unique canonical names", () => {
		const names = WELL_KNOWN_GUEST_PORTS.map((e) => e.name);
		const unique = new Set(names);
		expect(unique.size).toBe(names.length);
	});

	test("all aliases are unique and don't collide with canonical names", () => {
		const names = new Set(WELL_KNOWN_GUEST_PORTS.map((e) => e.name));
		const seenAliases = new Set<string>();
		for (const entry of WELL_KNOWN_GUEST_PORTS) {
			for (const alias of entry.aliases ?? []) {
				const key = alias.toLowerCase();
				expect(names.has(key)).toBe(false);
				expect(seenAliases.has(key)).toBe(false);
				seenAliases.add(key);
			}
		}
	});

	test("all ports are valid integers in 1..65535", () => {
		for (const entry of WELL_KNOWN_GUEST_PORTS) {
			expect(Number.isInteger(entry.guest)).toBe(true);
			expect(entry.guest).toBeGreaterThanOrEqual(1);
			expect(entry.guest).toBeLessThanOrEqual(65535);
		}
	});

	test("all entries have valid proto", () => {
		for (const entry of WELL_KNOWN_GUEST_PORTS) {
			expect(["tcp", "udp"]).toContain(entry.proto);
		}
	});

	test("canonical names are lowercase", () => {
		for (const entry of WELL_KNOWN_GUEST_PORTS) {
			expect(entry.name).toBe(entry.name.toLowerCase());
		}
	});

	test("includes core RouterOS services", () => {
		expect(lookupGuestPort("winbox")?.guest).toBe(8291);
		expect(lookupGuestPort("api")?.guest).toBe(8728);
		expect(lookupGuestPort("api-ssl")?.guest).toBe(8729);
		expect(lookupGuestPort("ssh")?.guest).toBe(22);
		expect(lookupGuestPort("http")?.guest).toBe(80);
		expect(lookupGuestPort("https")?.guest).toBe(443);
	});
});
