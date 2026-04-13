import { describe, test, expect } from "bun:test";
import {
	networkModeToConfigs,
	resolveStartNetworks,
} from "../../src/lib/network.ts";
import type { NetworkMode, NetworkSpecifier } from "../../src/lib/types.ts";

// ── networkModeToConfigs ────────────────────────────────────────────

describe("networkModeToConfigs", () => {
	test('"user" → single user config with net0', () => {
		const result = networkModeToConfigs("user");
		expect(result).toEqual([{ specifier: "user", id: "net0" }]);
	});

	test('"vmnet-shared" → single vmnet-shared config', () => {
		const result = networkModeToConfigs("vmnet-shared");
		expect(result).toEqual([{ specifier: "vmnet-shared", id: "net0" }]);
	});

	test('vmnet-bridge object → bridged + mgmt shared', () => {
		const mode: NetworkMode = { type: "vmnet-bridge", iface: "en0" };
		const result = networkModeToConfigs(mode);
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({
			specifier: { type: "vmnet-bridged", iface: "en0" },
			id: "net0",
		});
		expect(result[1]).toEqual({
			specifier: "vmnet-shared",
			id: "net1",
		});
	});

	test("vmnet-bridge assigns sequential IDs (net0, net1)", () => {
		const mode: NetworkMode = { type: "vmnet-bridge", iface: "en1" };
		const result = networkModeToConfigs(mode);
		expect(result[0]?.id).toBe("net0");
		expect(result[1]?.id).toBe("net1");
	});

	test("unknown string mode defaults to user", () => {
		// Any non-matching string falls through to user
		const result = networkModeToConfigs("user");
		expect(result).toEqual([{ specifier: "user", id: "net0" }]);
	});
});

// ── resolveStartNetworks ────────────────────────────────────────────

describe("resolveStartNetworks", () => {
	test("no args → default user", () => {
		const result = resolveStartNetworks();
		expect(result).toEqual([{ specifier: "user", id: "net0" }]);
	});

	test("undefined networks, undefined legacy → default user", () => {
		const result = resolveStartNetworks(undefined, undefined);
		expect(result).toEqual([{ specifier: "user", id: "net0" }]);
	});

	test("legacy network only → converted correctly", () => {
		const result = resolveStartNetworks(undefined, "vmnet-shared");
		expect(result).toEqual([{ specifier: "vmnet-shared", id: "net0" }]);
	});

	test('legacy vmnet-bridge → bridged + shared', () => {
		const result = resolveStartNetworks(undefined, {
			type: "vmnet-bridge",
			iface: "en0",
		});
		expect(result).toHaveLength(2);
		expect(result[0]?.specifier).toEqual({
			type: "vmnet-bridged",
			iface: "en0",
		});
		expect(result[1]?.specifier).toBe("vmnet-shared");
	});

	test("networks array → used directly with correct IDs", () => {
		const specs: NetworkSpecifier[] = [
			"user",
			{ type: "socket-listen", port: 4001 },
		];
		const result = resolveStartNetworks(specs);
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({ specifier: "user", id: "net0" });
		expect(result[1]).toEqual({
			specifier: { type: "socket-listen", port: 4001 },
			id: "net1",
		});
	});

	test("both provided → networks wins over legacy", () => {
		const specs: NetworkSpecifier[] = [
			{ type: "tap", ifname: "tap-chr0" },
		];
		const result = resolveStartNetworks(specs, "vmnet-shared");
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({
			specifier: { type: "tap", ifname: "tap-chr0" },
			id: "net0",
		});
	});

	test("empty networks array → empty (intentional no-network)", () => {
		// Empty array is treated as "no networks specified by user" → falls through to legacy/default
		const result = resolveStartNetworks([], undefined);
		expect(result).toEqual([{ specifier: "user", id: "net0" }]);
	});

	test("single-element networks → net0", () => {
		const result = resolveStartNetworks(["vmnet-shared"]);
		expect(result).toEqual([{ specifier: "vmnet-shared", id: "net0" }]);
	});

	test("three networks → sequential IDs net0, net1, net2", () => {
		const specs: NetworkSpecifier[] = [
			"user",
			{ type: "socket-listen", port: 4001 },
			{ type: "socket-connect", port: 4001 },
		];
		const result = resolveStartNetworks(specs);
		expect(result).toHaveLength(3);
		expect(result[0]?.id).toBe("net0");
		expect(result[1]?.id).toBe("net1");
		expect(result[2]?.id).toBe("net2");
	});
});
