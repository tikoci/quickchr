import { describe, test, expect } from "bun:test";
import {
	allocatePortBlock,
	buildPortMappings,
	buildHostfwdString,
	toChrPorts,
	validateExplicitExtraPorts,
} from "../../src/lib/network.ts";
import { DEFAULT_PORT_BASE, PORTS_PER_BLOCK, QuickCHRError, type MachineState } from "../../src/lib/types.ts";

function fakeMachine(name: string, ports: Record<string, { name: string; host: number; guest: number; proto: "tcp" | "udp" }>): MachineState {
	return {
		name,
		version: "7.20",
		arch: "x86",
		cpu: 1,
		mem: 256,
		networks: [{ specifier: "user", id: "net0" }],
		ports,
		packages: [],
		portBase: ports.http?.host ?? 9100,
		excludePorts: [],
		extraPorts: [],
		extraDisks: [],
		bootDiskFormat: "raw",
		createdAt: "2024-01-01T00:00:00Z",
		status: "stopped",
		machineDir: `/tmp/${name}`,
	} as MachineState;
}

describe("allocatePortBlock", () => {
	test("returns default base when no existing machines", () => {
		expect(allocatePortBlock([])).toBe(DEFAULT_PORT_BASE);
	});

	test("returns requested base when specified", () => {
		expect(allocatePortBlock([9100, 9110], 9200)).toBe(9200);
	});

	test("skips over allocated blocks", () => {
		expect(allocatePortBlock([9100])).toBe(9100 + PORTS_PER_BLOCK);
		expect(allocatePortBlock([9100, 9110])).toBe(9120);
	});
});

describe("buildPortMappings", () => {
	test("builds default mappings from base", () => {
		const ports = buildPortMappings(9100);
		expect(ports.http).toEqual({ name: "http", host: 9100, guest: 80, proto: "tcp" });
		expect(ports.ssh).toEqual({ name: "ssh", host: 9102, guest: 22, proto: "tcp" });
		expect(ports.winbox).toEqual({ name: "winbox", host: 9105, guest: 8291, proto: "tcp" });
	});

	test("excludes specified ports", () => {
		const ports = buildPortMappings(9100, ["winbox", "api-ssl"]);
		expect(ports.winbox).toBeUndefined();
		expect(ports["api-ssl"]).toBeUndefined();
		expect(ports.http).toBeDefined();
	});

	test("includes extra port mappings", () => {
		const ports = buildPortMappings(9100, [], [
			{ name: "custom", host: 0, guest: 9999, proto: "tcp" },
		]);
		expect(ports.custom).toEqual({ name: "custom", host: 9106, guest: 9999, proto: "tcp" });
	});
});

describe("buildHostfwdString", () => {
	test("builds comma-separated hostfwd string", () => {
		const ports = buildPortMappings(9100, ["https", "api", "api-ssl", "winbox"]);
		const hostfwd = buildHostfwdString(ports);
		expect(hostfwd).toContain("hostfwd=tcp::9100-:80");
		expect(hostfwd).toContain("hostfwd=tcp::9102-:22");
	});

	test("returns empty string for no ports", () => {
		expect(buildHostfwdString({})).toBe("");
	});
});

describe("toChrPorts", () => {
	test("converts port mappings to ChrPorts", () => {
		const ports = buildPortMappings(9100);
		const chr = toChrPorts(ports);
		expect(chr.http).toBe(9100);
		expect(chr.ssh).toBe(9102);
		expect(chr.apiSsl).toBe(9104);
	});
});

describe("validateExplicitExtraPorts", () => {
	const otherMachine = fakeMachine("chr-other", {
		http: { name: "http", host: 9100, guest: 80, proto: "tcp" },
		ssh: { name: "ssh", host: 9102, guest: 22, proto: "tcp" },
	});

	test("no-op for empty / undefined extras", () => {
		expect(() => validateExplicitExtraPorts(undefined, 9200, [], [otherMachine])).not.toThrow();
		expect(() => validateExplicitExtraPorts([], 9200, [], [otherMachine])).not.toThrow();
	});

	test("happy path: explicit host on free port passes", () => {
		expect(() =>
			validateExplicitExtraPorts(
				[{ name: "smb", host: 4445, guest: 445, proto: "tcp" }],
				9200,
				[],
				[otherMachine],
			),
		).not.toThrow();
	});

	test("auto-allocated extras (host=0) are skipped", () => {
		expect(() =>
			validateExplicitExtraPorts(
				[{ name: "auto", host: 0, guest: 1234, proto: "tcp" }],
				9100, // would collide with otherMachine's http if checked, but host=0 means auto
				[],
				[otherMachine],
			),
		).not.toThrow();
	});

	test("throws PORT_CONFLICT on collision with another machine's port", () => {
		try {
			validateExplicitExtraPorts(
				[{ name: "smb", host: 9100, guest: 445, proto: "tcp" }],
				9200,
				[],
				[otherMachine],
			);
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(QuickCHRError);
			expect((err as QuickCHRError).code).toBe("PORT_CONFLICT");
			expect((err as QuickCHRError).message).toContain("chr-other");
			expect((err as QuickCHRError).message).toContain("9100");
		}
	});

	test("throws PORT_CONFLICT when explicit host collides with own SERVICE_PORTS", () => {
		// portBase=9200 → http=9200; explicit host=9200 collides with built-in http
		try {
			validateExplicitExtraPorts(
				[{ name: "smb", host: 9200, guest: 445, proto: "tcp" }],
				9200,
				[],
				[],
			);
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(QuickCHRError);
			expect((err as QuickCHRError).code).toBe("PORT_CONFLICT");
			expect((err as QuickCHRError).message).toContain("http");
		}
	});

	test("excluded service ports do not trigger built-in collision", () => {
		// http excluded → host 9200 is free for an extra
		expect(() =>
			validateExplicitExtraPorts(
				[{ name: "smb", host: 9200, guest: 445, proto: "tcp" }],
				9200,
				["http"],
				[],
			),
		).not.toThrow();
	});

	test("throws PORT_CONFLICT on duplicate hosts within same extras set", () => {
		try {
			validateExplicitExtraPorts(
				[
					{ name: "a", host: 5000, guest: 1, proto: "tcp" },
					{ name: "b", host: 5000, guest: 2, proto: "tcp" },
				],
				9200,
				[],
				[],
			);
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(QuickCHRError);
			expect((err as QuickCHRError).code).toBe("PORT_CONFLICT");
			expect((err as QuickCHRError).message).toContain("5000");
		}
	});

	test("self-exclusion: ownMachineName skips that machine's ports", () => {
		// otherMachine owns 9100; pass ownMachineName="chr-other" → no conflict
		expect(() =>
			validateExplicitExtraPorts(
				[{ name: "smb", host: 9100, guest: 445, proto: "tcp" }],
				9200,
				[],
				[otherMachine],
				"chr-other",
			),
		).not.toThrow();
	});
});
