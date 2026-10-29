import { describe, test, expect, beforeAll } from "bun:test";
import { loadMachine } from "../../src/lib/state.ts";
import { basicAuth, chrGet } from "./chr-rest.ts";
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
const ADMIN = basicAuth("admin", "");

/** Deadline for each ping wait below: convergence first, then retry-to-clean.
 *
 *  Deliberately generous, because the cost is asymmetric: each wait returns the
 *  moment its condition lands, so a healthy link pays ~one round-trip, while
 *  a budget too tight for a loaded TCG runner reintroduces the exact flake this
 *  exists to remove. A wait only runs to expiry on persistent loss — a hard
 *  failure worth waiting to be sure of. */
const PING_CONVERGENCE_MS = 60_000;

async function cleanupMachine(name: string): Promise<void> {
	const { QuickCHR } = await import("../../src/lib/quickchr.ts");
	const existing = QuickCHR.get(name);
	if (!existing) return;
	try { await existing.stop(); } catch { /* ignore */ }
	try { await existing.remove(); } catch { /* ignore */ }
}

/** MACs RouterOS reports for its own ethernet interfaces, lowercased.
 *
 *  Read through `chrGet()` rather than `instance.rest()`: per
 *  `testing.instructions.md`, integration REST reads go through the one client so
 *  a transport failure captures post-readiness forensics instead of a bare throw. */
async function guestMacs(
	instance: Parameters<typeof chrGet>[0],
	after?: string,
): Promise<string[]> {
	const resp = await chrGet(instance, "/rest/interface/ethernet", ADMIN, { after });
	expect(resp.status).toBe(200);
	const rows = JSON.parse(resp.body) as Array<{ "mac-address"?: string }>;
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

			// Converge first, then assert. The wait proves the segment forwards —
			// it returns the moment one echo succeeds — and the retry below proves
			// it keeps forwarding, still at a zero-loss bar (#163): on a loaded
			// host an echo of the `count=3` ping can still time out while its
			// neighbors reply in ~1 ms — observed twice, both times seq 0 lost
			// with seq 1–2 at ~1 ms, one REST round trip after the `count=1`
			// probe above reported 0% loss with the neighbor freshly resolved.
			// Replies at ~1 ms next to a timeout indicate a transient stall, not
			// a drop on a segment that does not forward — and the duplicate-MAC
			// faults this test guards (#154) half-work rather than failing
			// totally, so the bar must stay at zero loss to keep its detection
			// power. Retrying to clean within a deadline lets a transient stall
			// pass on retry while persistent loss still fails at zero loss.
			const from = hub;
			const reachable = await from.waitFor(async () => {
				const probe = await from.exec("/ping 10.73.0.2 count=1");
				return probe.output.includes("packet-loss=0%");
			}, PING_CONVERGENCE_MS);
			expect(reachable).toBe(true);

			// Now the link is warm, loss is the thing under test: repeat the
			// `count=3` ping until one lands fully clean. A transient stall
			// passes on retry; persistent loss never lands clean and fails.
			const clean = await from.waitFor(async () => {
				const ping = await from.exec("/ping 10.73.0.2 count=3");
				return ping.output.includes("packet-loss=0%");
			}, PING_CONVERGENCE_MS);
			expect(clean).toBe(true);

			// 4. Addresses survive a restart — they are read from machine.json, not
			//    re-derived, so a derivation change cannot move an existing machine.
			const before = loadMachine(SPOKE)?.networks.map((n) => n.mac);
			await spoke.stop();
			spoke = await QuickCHR.start({ background: true, name: SPOKE });
			expect(loadMachine(SPOKE)?.networks.map((n) => n.mac)).toEqual(before);
			expect(await guestMacs(spoke, "stop() then start() of an existing machine")).toEqual(
				(before ?? []).map((m) => m ?? ""),
			);
		} finally {
			await cleanupMachine(SPOKE);
			await cleanupMachine(HUB);
		}
	}, bootTestTimeout({ boots: 3 }));
});
