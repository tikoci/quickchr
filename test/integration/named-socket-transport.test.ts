import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
	_resetSocketCache,
	createNamedSocket,
	getNamedSocket,
	getSocketSlot,
	removeNamedSocket,
} from "../../src/lib/socket-registry.ts";
import { imageTarget } from "./image-target.ts";
import { bootTestTimeout } from "./timeouts.ts";

/**
 * Integration test — a named socket's default transport actually carries frames,
 * in either start order (#158).
 *
 * Requires QEMU installed. Skipped in CI unless QUICKCHR_INTEGRATION=1.
 *
 * The unit tier proves the argument strings are right. It cannot prove the three
 * things the #158 decision rests on, all of which live past QEMU:
 *
 *   1. `dgram` over unix sockets carries guest L2 frames at all — this was the open
 *      question that gated the decision, since the earlier probe confirmed only that
 *      both processes *started*;
 *   2. start order genuinely does not matter, which is the whole reason it beat the
 *      TCP pair (a `connect=` netdev with no listener runs happily and silently never
 *      links, and never retries);
 *   3. a machine can stop and start again without the link going dead — the failure
 *      the old member-count role derivation caused.
 *
 * The connector-first case is the one that matters: it is exactly the case
 * `listen-connect` cannot serve.
 */

const SKIP = !process.env.QUICKCHR_INTEGRATION;

const FIRST = "integration-dgram-first";
const SECOND = "integration-dgram-second";
const LINK = "integration-dgram-link";

/** Generous, and it costs nothing on a healthy link: the wait returns on the first
 *  reply. It only runs to expiry when the segment truly does not forward, which is a
 *  hard failure worth waiting to be sure of. */
const PING_CONVERGENCE_MS = 60_000;

async function cleanupMachine(name: string): Promise<void> {
	const { QuickCHR } = await import("../../src/lib/quickchr.ts");
	const existing = QuickCHR.get(name);
	if (!existing) return;
	try { await existing.stop(); } catch { /* ignore */ }
	try { await existing.remove(); } catch { /* ignore */ }
}

describe.skipIf(SKIP)("named socket default transport", () => {
	beforeAll(async () => {
		await cleanupMachine(FIRST);
		await cleanupMachine(SECOND);
		_resetSocketCache();
		removeNamedSocket(LINK);
	});

	afterAll(async () => {
		await cleanupMachine(FIRST);
		await cleanupMachine(SECOND);
		removeNamedSocket(LINK);
	});

	test("a dgram link carries traffic whichever machine starts first, and survives a restart", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		type Instance = Awaited<ReturnType<typeof QuickCHR.start>>;
		let second: Instance | undefined;
		let first: Instance | undefined;

		createNamedSocket(LINK, { mode: "dgram" });

		try {
			// SECOND joins and starts first, so it holds slot 0 and names a peer socket
			// that does not exist yet. On a TCP pair this is the dead-link case.
			second = await QuickCHR.start({
				...imageTarget(),
				background: true,
				name: SECOND,
				networks: ["user", { type: "socket", name: LINK }],
			});
			first = await QuickCHR.start({
				...imageTarget(),
				background: true,
				name: FIRST,
				networks: ["user", { type: "socket", name: LINK }],
			});

			// 1. The endpoints are persisted, one per machine, and the starter took slot 0.
			const entry = getNamedSocket(LINK);
			if (!entry) throw new Error("named socket vanished");
			expect(entry.mode).toBe("dgram");
			expect(getSocketSlot(entry, SECOND)).toBe(0);
			expect(getSocketSlot(entry, FIRST)).toBe(1);

			// 2. The segment carries traffic. ether1 is the SLIRP management NIC;
			//    ether2 is the named link.
			await second.exec("/ip/address/add interface=ether2 address=10.74.0.1/24");
			await first.exec("/ip/address/add interface=ether2 address=10.74.0.2/24");

			// Converge first, then assert — the first echo after an address is added is
			// consumed by neighbor resolution, so loss only becomes the thing under test
			// once a reply has landed.
			const from = second;
			const reachable = await from.waitFor(async () => {
				const probe = await from.exec("/ping 10.74.0.2 count=1");
				return probe.output.includes("packet-loss=0%");
			}, PING_CONVERGENCE_MS);
			expect(reachable).toBe(true);

			expect((await second.exec("/ping 10.74.0.2 count=3")).output).toContain("packet-loss=0%");
			// Both directions: a datagram pair is two independent bindings, and only one
			// of them failing would still look like a working link from one side.
			expect((await first.exec("/ping 10.74.0.1 count=3")).output).toContain("packet-loss=0%");

			// 3. A restart keeps the slot and the link. Deriving the role from live member
			//    count instead would hand the restarting machine the other end.
			await first.stop();
			expect(getNamedSocket(LINK)?.endpoints).toEqual([SECOND, null]);
			first = await QuickCHR.start({ background: true, name: FIRST });

			const restarted = getNamedSocket(LINK);
			if (!restarted) throw new Error("named socket vanished");
			expect(getSocketSlot(restarted, FIRST)).toBe(1);

			const backUp = await from.waitFor(async () => {
				const probe = await from.exec("/ping 10.74.0.2 count=1");
				return probe.output.includes("packet-loss=0%");
			}, PING_CONVERGENCE_MS);
			expect(backUp).toBe(true);
		} finally {
			await cleanupMachine(FIRST);
			await cleanupMachine(SECOND);
		}
	}, bootTestTimeout({ boots: 3 }));
});
