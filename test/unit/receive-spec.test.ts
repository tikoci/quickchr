import { describe, expect, test } from "bun:test";
import { lookupReceivePort, WELL_KNOWN_GUEST_PORTS, WELL_KNOWN_RECEIVE_PORTS } from "../../src/lib/guest-ports.ts";
import { parseForwardSpec } from "../../src/lib/forward-spec.ts";
import {
	normalizeReceivePort,
	parseReceiveSpec,
	receiveEndpoint,
	receiveEndpoints,
	validateReceivePorts,
	type ReceiveCheckMachine,
} from "../../src/lib/receive-spec.ts";
import type { PortMapping } from "../../src/lib/types.ts";

describe("parseReceiveSpec", () => {
	test("a known name fills the port and proto from the registry", () => {
		expect(parseReceiveSpec("tzsp")).toEqual({ name: "tzsp", port: 37008, proto: "udp" });
		expect(parseReceiveSpec("netflow")).toEqual({ name: "netflow", port: 2055, proto: "udp" });
		expect(parseReceiveSpec("ipfix")).toEqual({ name: "ipfix", port: 4739, proto: "udp" });
	});

	test("syslog defaults to an unprivileged port, not 514", () => {
		expect(parseReceiveSpec("syslog")).toEqual({ name: "syslog", port: 5514, proto: "udp" });
		expect(lookupReceivePort("syslog")?.wellKnown).toBe(514);
	});

	test("explicit port wins over the registry", () => {
		expect(parseReceiveSpec("tzsp:37009")).toEqual({ name: "tzsp", port: 37009, proto: "udp" });
	});

	test("an unknown name takes a port and defaults to udp", () => {
		expect(parseReceiveSpec("myapp:9400")).toEqual({ name: "myapp", port: 9400, proto: "udp" });
		expect(parseReceiveSpec("myapp:9400/tcp")).toEqual({ name: "myapp", port: 9400, proto: "tcp" });
	});

	test("names are stored lowercase, aliases keep the typed label", () => {
		expect(parseReceiveSpec("TZSP")).toEqual({ name: "tzsp", port: 37008, proto: "udp" });
		expect(parseReceiveSpec("traffic-flow")).toEqual({ name: "traffic-flow", port: 2055, proto: "udp" });
	});

	test.each([
		["", "Empty"],
		["myapp", "a port is required"],
		["tzsp:abc", "not a number"],
		["tzsp:0", "out of range"],
		["tzsp:70000", "out of range"],
		["tzsp:1:2", "one port"],
		["tzsp/sctp", "protocol"],
		["bad name:9400", "letters, digits"],
		[":9400", "name is required"],
	])("rejects %p", (spec, message) => {
		expect(() => parseReceiveSpec(spec)).toThrow(message);
		try {
			parseReceiveSpec(spec);
		} catch (e) {
			expect((e as { code?: string }).code).toBe("INVALID_RECEIVE_SPEC");
		}
	});
});

describe("normalizeReceivePort", () => {
	test("accepts a spec string or an object, lowercasing the name", () => {
		expect(normalizeReceivePort("tzsp")).toEqual({ name: "tzsp", port: 37008, proto: "udp" });
		expect(normalizeReceivePort({ name: "Flow", port: 9400, proto: "udp" })).toEqual({ name: "flow", port: 9400, proto: "udp" });
	});

	test("rejects a bad object", () => {
		expect(() => normalizeReceivePort({ name: "x", port: 0, proto: "udp" })).toThrow("out of range");
		expect(() => normalizeReceivePort({ name: "x", port: 9400, proto: "sctp" as "udp" })).toThrow("protocol");
	});
});

describe("receive endpoints", () => {
	test("guest sends to the gateway, host binds loopback, same port both sides", () => {
		expect(receiveEndpoint({ name: "tzsp", port: 37008, proto: "udp" })).toEqual({
			transport: "udp",
			host: "127.0.0.1",
			hostPort: 37008,
			guestHost: "10.0.2.2",
			guestPort: 37008,
		});
	});

	test("keyed by name; empty for none", () => {
		expect(Object.keys(receiveEndpoints([{ name: "tzsp", port: 37008, proto: "udp" }, { name: "syslog", port: 5514, proto: "udp" }]))).toEqual(["tzsp", "syslog"]);
		expect(receiveEndpoints(undefined)).toEqual({});
	});
});

describe("validateReceivePorts", () => {
	const ownPorts: Record<string, PortMapping> = {
		http: { name: "http", host: 9100, guest: 80, proto: "tcp" },
		snmp: { name: "snmp", host: 9106, guest: 161, proto: "udp" },
	};
	const other: ReceiveCheckMachine = {
		name: "lab1",
		ports: { http: { name: "http", host: 9110, guest: 80, proto: "tcp" } },
		receivePorts: [{ name: "tzsp", port: 37008, proto: "udp" }],
	};

	test("a free port passes", () => {
		expect(() => validateReceivePorts([{ name: "tzsp", port: 37009, proto: "udp" }], "lab2", ownPorts, [], [other])).not.toThrow();
	});

	test("another machine's receive port is a PORT_CONFLICT that names the next free port", () => {
		let err: unknown;
		try {
			validateReceivePorts([{ name: "tzsp", port: 37008, proto: "udp" }], "lab2", ownPorts, [], [other]);
		} catch (e) {
			err = e;
		}
		expect(err).toMatchObject({ code: "PORT_CONFLICT" });
		expect(String((err as Error).message)).toContain('machine "lab1"');
		expect(String((err as Error).message)).toContain("--receive tzsp:37009");
	});

	test("another machine's forward and this machine's own forward both clash", () => {
		expect(() => validateReceivePorts([{ name: "x", port: 9110, proto: "udp" }], "lab2", ownPorts, [], [other])).toThrow('machine "lab1"');
		expect(() => validateReceivePorts([{ name: "x", port: 9106, proto: "udp" }], "lab2", ownPorts, [], [other])).toThrow("this machine's forward");
	});

	test("the machine's own record is skipped by name (re-validating itself)", () => {
		expect(() => validateReceivePorts([{ name: "tzsp", port: 37008, proto: "udp" }], "lab1", other.ports, [], [other])).not.toThrow();
	});

	test("an existing slot of this machine clashes unless it is the one being replaced", () => {
		const own = [{ name: "syslog", port: 5514, proto: "udp" as const }];
		expect(() => validateReceivePorts([{ name: "flow", port: 5514, proto: "udp" }], "lab2", ownPorts, own, [])).toThrow('receive "syslog"');
		expect(() => validateReceivePorts([{ name: "syslog", port: 5514, proto: "udp" }], "lab2", ownPorts, own, [])).not.toThrow();
	});

	test("duplicate names and duplicate ports within one request", () => {
		expect(() =>
			validateReceivePorts([{ name: "a", port: 9400, proto: "udp" }, { name: "a", port: 9401, proto: "udp" }], "lab2", ownPorts, [], []),
		).toThrow("given twice");
		expect(() =>
			validateReceivePorts([{ name: "a", port: 9400, proto: "udp" }, { name: "b", port: 9400, proto: "udp" }], "lab2", ownPorts, [], []),
		).toThrow("--receive b:9401");
	});
});

describe("registry separation", () => {
	test("receive names are not forward names (a forward is the wrong direction)", () => {
		const guestNames = new Set(WELL_KNOWN_GUEST_PORTS.map((g) => g.name));
		for (const r of WELL_KNOWN_RECEIVE_PORTS) {
			if (r.name === "syslog") continue; // a guest syslog *server* is a real forward target
			expect(guestNames.has(r.name)).toBe(false);
		}
	});

	test("--forward tzsp points at --receive", () => {
		expect(() => parseForwardSpec("tzsp")).toThrow("use --receive tzsp");
	});

	test("defaults are unprivileged", () => {
		for (const r of WELL_KNOWN_RECEIVE_PORTS) expect(r.defaultPort).toBeGreaterThanOrEqual(1024);
	});
});
