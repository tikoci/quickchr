import { describe, test, expect, beforeAll } from "bun:test";
import { loadMachine } from "../../src/lib/state.ts";
import { imageTarget } from "./image-target.ts";
import { bootTestTimeout } from "./timeouts.ts";

/**
 * Integration test — two machines on one L2 segment present distinct MACs (#154).
 *
 * Requires QEMU installed. Skipped in CI unless QUICKCHR_INTEGRATION=1.
 *
 * The unit tier proves the argument strings carry `mac=`. It cannot prove the
 * three facts that actually matter, all of which live past QEMU:
 *
 *   1. the address is persisted in `machine.json` at creation;
 *   2. RouterOS reports that same address on the guest interface;
 *   3. two machines sharing a socket link can actually pass traffic.
 *
 * Before the fix, (1) did not exist, (2) reported QEMU's default
 * `52:54:00:12:34:56` sequence identically on both guests, and (3) half-worked in
 * a way that read as a RouterOS fault. A regression in state wiring or runtime
 * emission passes every unit test, so this is the gate that would catch it.
 */

const SKIP = !process.env.QUICKCHR_INTEGRATION;

const HUB = "integration-mac-hub";
const SPOKE = "integration-mac-spoke";
const LINK_PORT = 5473;

async function cleanupMachine(name: string): Promise<void> {
	const { QuickCHR } = await import("../../src/lib/quickchr.ts");
	const existing = QuickCHR.get(name);
	if (!existing) return;
	try { await existing.stop(); } catch { /* ignore */ }
	try { await existing.remove(); } catch { /* ignore */ }
}

/** MACs RouterOS reports for its own ethernet interfaces, lowercased. */
async function guestMacs(
	instance: { rest(path: string): Promise<unknown> },
): Promise<string[]> {
	const rows = await instance.rest("/interface/ethernet") as Array<{ "mac-address"?: string }>;
	return rows.map((r) => (r["mac-address"] ?? "").toLowerCase()).filter(Boolean);
}

describe.skipIf(SKIP)("NIC MAC addressing across a shared L2 segment", () => {
	beforeAll(async () => {
		await cleanupMachine(HUB);
		await cleanupMachine(SPOKE);
	});

	test("two machines on one socket link present distinct MACs and pass traffic", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		type Instance = Awaited<ReturnType<typeof QuickCHR.start>>;
		let hub: Instance | undefined;
		let spoke: Instance | undefined;

		try {
			// The listener must be running before the connector starts, or the
			// connector fails immediately.
			hub = await QuickCHR.start({
				...imageTarget(),
				background: true,
				name: HUB,
				networks: ["user", { type: "socket-listen", port: LINK_PORT }],
			});
			spoke = await QuickCHR.start({
				...imageTarget(),
				background: true,
				name: SPOKE,
				networks: ["user", { type: "socket-connect", port: LINK_PORT }],
			});

			// 1. Persisted at creation, one per NIC, all distinct.
			const persisted = [HUB, SPOKE].flatMap(
				(n) => loadMachine(n)?.networks.map((x) => x.mac) ?? [],
			);
			expect(persisted).toHaveLength(4);
			for (const mac of persisted) {
				expect(mac).toMatch(/^02:[0-9a-f]{2}(:[0-9a-f]{2}){4}$/);
			}
			expect(new Set(persisted).size).toBe(4);

			// 2. RouterOS reports the same addresses. This is the assertion that
			//    fails against QEMU's defaults — both guests would report the
			//    identical 52:54:00:12:34:56 sequence.
			const hubGuest = await guestMacs(hub);
			const spokeGuest = await guestMacs(spoke);
			expect(hubGuest).toEqual(
				loadMachine(HUB)?.networks.map((n) => n.mac ?? "") ?? [],
			);
			expect(spokeGuest).toEqual(
				loadMachine(SPOKE)?.networks.map((n) => n.mac ?? "") ?? [],
			);
			expect(new Set([...hubGuest, ...spokeGuest]).size).toBe(4);

			// 3. The segment carries traffic. ether1 is the SLIRP management NIC;
			//    ether2 is the socket link.
			await hub.exec("/ip/address/add interface=ether2 address=10.73.0.1/24");
			await spoke.exec("/ip/address/add interface=ether2 address=10.73.0.2/24");
			const ping = await hub.exec("/ping 10.73.0.2 count=3");
			expect(ping.output).toContain("packet-loss=0%");

			// 4. Addresses survive a restart — they are read from machine.json, not
			//    re-derived, so a derivation change cannot move an existing machine.
			const before = loadMachine(SPOKE)?.networks.map((n) => n.mac);
			await spoke.stop();
			spoke = await QuickCHR.start({ background: true, name: SPOKE });
			expect(loadMachine(SPOKE)?.networks.map((n) => n.mac)).toEqual(before);
			expect(await guestMacs(spoke)).toEqual(
				(before ?? []).map((m) => m ?? ""),
			);
		} finally {
			await cleanupMachine(SPOKE);
			await cleanupMachine(HUB);
		}
	}, bootTestTimeout({ boots: 3 }));
});
