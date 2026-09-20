import { describe, test, expect } from "bun:test";

import { assignMacs, deriveMac, resolveStartNetworks } from "../../src/lib/network.ts";
import { buildQemuArgs, type QemuLaunchConfig } from "../../src/lib/qemu.ts";
import type { NetworkConfig, NetworkSpecifier } from "../../src/lib/types.ts";

const MAC_RE = /^02:[0-9a-f]{2}(:[0-9a-f]{2}){4}$/;

function makeInterfaces(...specs: NetworkSpecifier[]): NetworkConfig[] {
	return resolveStartNetworks(specs);
}

function macsOf(networks: NetworkConfig[]): string[] {
	return networks.map((n) => n.mac ?? "");
}

describe("deriveMac", () => {
	test("is locally administered and unicast", () => {
		// 0x02: bit 1 set (locally administered), bit 0 clear (unicast) — so a derived
		// address can never collide with a vendor-assigned one.
		const mac = deriveMac("sun", 0);
		expect(mac).toMatch(MAC_RE);
		const first = Number.parseInt(mac.split(":")[0] ?? "", 16);
		expect(first & 0b10).toBe(0b10);
		expect(first & 0b01).toBe(0);
	});

	test("is stable for a given machine and NIC index", () => {
		expect(deriveMac("sun", 1)).toBe(deriveMac("sun", 1));
	});

	test("differs by machine, by NIC index, and by salt", () => {
		expect(deriveMac("sun", 0)).not.toBe(deriveMac("earth", 0));
		expect(deriveMac("sun", 0)).not.toBe(deriveMac("sun", 1));
		expect(deriveMac("sun", 0)).not.toBe(deriveMac("sun", 0, 1));
	});

	test("name and index cannot be confused with each other", () => {
		// A naive `${name}${index}` would make ("sun1", 0) and ("sun", 10) collide.
		expect(deriveMac("sun1", 0)).not.toBe(deriveMac("sun", 10));
	});
});

describe("assignMacs", () => {
	test("gives every NIC a distinct address", () => {
		const networks = assignMacs("sun", makeInterfaces("user", { type: "socket-listen", port: 5201 }));
		const macs = macsOf(networks);
		expect(macs.every((m) => MAC_RE.test(m))).toBe(true);
		expect(new Set(macs).size).toBe(2);
	});

	test("two machines with identical NIC layouts do not collide — #154", () => {
		const layout = (): NetworkSpecifier[] => ["user", { type: "socket-listen", port: 5201 }];
		const sun = macsOf(assignMacs("sun", makeInterfaces(...layout())));
		const earth = macsOf(assignMacs("earth", makeInterfaces(...layout())));
		expect(new Set([...sun, ...earth]).size).toBe(4);
	});

	test("is idempotent — an assigned NIC keeps its address", () => {
		const networks = assignMacs("sun", makeInterfaces("user"));
		const first = macsOf(networks);
		assignMacs("sun", networks);
		expect(macsOf(networks)).toEqual(first);
	});

	test("backfills only the NICs that lack an address", () => {
		const networks = makeInterfaces("user", { type: "socket-listen", port: 5201 });
		const [first] = networks;
		if (!first) throw new Error("expected two NICs");
		first.mac = "02:aa:bb:cc:dd:ee";
		assignMacs("sun", networks);
		expect(networks[0]?.mac).toBe("02:aa:bb:cc:dd:ee");
		expect(networks[1]?.mac).toMatch(MAC_RE);
	});

	test("never changes an address a machine has already booted with", () => {
		// Grounded, not stylistic. A/B against a live CHR (7.24.2 x86, HVF): the same
		// machine and disk boots with its original MAC, fails to boot after the MAC is
		// changed (REST never answers; every forwarded port SYN is dropped), and boots
		// again once the MAC is restored. RouterOS ties its persisted interface identity
		// to the address, so a changed MAC orphans the `ether1` holding the DHCP client.
		//
		// This is why MACs are assigned at creation ONLY and are never backfilled onto
		// an existing machine — a machine that predates #154 keeps QEMU's defaults and
		// must be recreated to get a stable address.
		const booted = makeInterfaces("user");
		booted[0] = { ...booted[0], mac: "02:aa:bb:cc:dd:ee" } as NetworkConfig;
		assignMacs("sun", booted, new Set(["02:aa:bb:cc:dd:ee"]));
		expect(booted[0]?.mac).toBe("02:aa:bb:cc:dd:ee");
	});

	test("salts around an address another machine already holds", () => {
		// Force the collision the `taken` set exists to prevent.
		const taken = new Set([deriveMac("sun", 0)]);
		const networks = assignMacs("sun", makeInterfaces("user"), taken);
		expect(networks[0]?.mac).not.toBe(deriveMac("sun", 0));
		expect(networks[0]?.mac).toBe(deriveMac("sun", 0, 1));
	});
});

describe("buildQemuArgs NIC devices", () => {
	const base: QemuLaunchConfig = {
		arch: "x86",
		machineDir: "/tmp/quickchr-mac-test",
		bootDisk: { path: "/tmp/quickchr-mac-test/disk.img", format: "raw" },
		mem: 1024,
		cpu: 1,
		ports: {},
		portBase: 9100,
		networks: [{ specifier: "user", id: "net0" }],
		background: true,
	};

	async function deviceLines(name: string, specs: NetworkSpecifier[]): Promise<string[]> {
		const args = await buildQemuArgs({
			...base,
			networks: assignMacs(name, resolveStartNetworks(specs)),
		});
		return args.map(String).filter((a) => a.startsWith("virtio-net-pci"));
	}

	test("every NIC device carries its MAC", async () => {
		const lines = await deviceLines("sun", ["user", { type: "socket-listen", port: 5201 }]);
		expect(lines).toHaveLength(2);
		for (const line of lines) {
			expect(line).toMatch(/,mac=02:/);
		}
	});

	test("three machines on one L2 segment share no address — #154", async () => {
		const layout: NetworkSpecifier[] = ["user", { type: "socket-listen", port: 5201 }];
		const lines = [
			...(await deviceLines("sun", layout)),
			...(await deviceLines("earth", layout)),
			...(await deviceLines("comet", layout)),
		];
		const macs = lines.map((l) => l.split("mac=")[1]);
		expect(macs).toHaveLength(6);
		expect(new Set(macs).size).toBe(6);
	});

	test("the qemu.ts fallback path carries the MAC too", async () => {
		// `resolved` is absent here, so buildQemuArgs takes its own specifier branch
		// rather than resolveAllNetworks' output. Both must emit the address.
		const lines = await deviceLines("mir", [
			{ type: "socket-connect", port: 5201 },
			{ type: "tap", ifname: "tap0" },
			{ type: "socket-mcast", group: "230.0.0.1", port: 4000 },
		]);
		expect(lines).toHaveLength(3);
		for (const line of lines) {
			expect(line).toMatch(/,mac=02:/);
		}
		expect(new Set(lines.map((l) => l.split("mac=")[1])).size).toBe(3);
	});
});
