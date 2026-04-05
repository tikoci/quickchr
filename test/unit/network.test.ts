import { describe, test, expect } from "bun:test";
import {
	allocatePortBlock,
	buildPortMappings,
	buildHostfwdString,
	toChrPorts,
} from "../../src/lib/network.ts";
import { DEFAULT_PORT_BASE, PORTS_PER_BLOCK } from "../../src/lib/types.ts";

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
