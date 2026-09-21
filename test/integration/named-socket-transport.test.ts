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
 * Integration test — a named socket's default transport actually carries frames (#158).
 *
 * Requires QEMU installed. Skipped in CI unless QUICKCHR_INTEGRATION=1.
 *
 * The default is platform-dependent, so this file has two arms and each runs only where
 * its transport exists (`defaultSocketMode()`): `dgram` on POSIX, `listen-connect` on
 * Windows, which has no AF_UNIX SOCK_DGRAM. Asserting one default on both platforms is
 * what made this file red on every Windows leg — it created a `dgram` link there and got
 * the documented refusal from `resolveSocketNamed()`.
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
 *
 * The Windows arm cannot claim any of those three — `listen-connect` has a start order
 * and no reconnect — so it proves the thing that is actually unproven there: that the
 * default a Windows user gets from `networks sockets create <name>` carries frames at
 * all. Until #166 the mode was unreachable (`isFirst` was never true, so nobody ever
 * listened), and DESIGN.md's transport table still records it as never measured.
 */

const SKIP = !process.env.QUICKCHR_INTEGRATION;
/** Not a convenience: `dgram` and `listen-connect` are mutually exclusive by platform,
 *  so each arm is skipped where its transport cannot exist rather than where it is
 *  merely inconvenient. `defaultSocketMode()` is the single source of that split. */
const IS_WINDOWS = process.platform === "win32";

const FIRST = "integration-dgram-first";
const SECOND = "integration-dgram-second";
const LINK = "integration-dgram-link";

const LISTENER = "integration-lc-listener";
const CONNECTOR = "integration-lc-connector";
const LC_LINK = "integration-lc-link";

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

/** Structural, so neither arm needs a static import of quickchr.ts at module scope. */
type Pinger = {
	exec(command: string): Promise<{ output: string }>;
	waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean>;
};

/** Converge before asserting — the first echo after an address is added is consumed by
 *  neighbor resolution, so loss only becomes the thing under test once a reply has
 *  landed. Returns whatever `waitFor` decided; the caller asserts on it. */
function pingConverges(from: Pinger, peer: string): Promise<boolean> {
	return from.waitFor(async () => {
		const probe = await from.exec(`/ping ${peer} count=1`);
		return probe.output.includes("packet-loss=0%");
	}, PING_CONVERGENCE_MS);
}

describe.skipIf(SKIP || IS_WINDOWS)("named socket default transport — dgram", () => {
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

		// No `mode`, matching the Windows arm: the point is the transport a bare
		// `networks sockets create` picks here, not one this test names.
		const created = createNamedSocket(LINK);
		expect(created.mode).toBe("dgram");

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
			// Re-read, not the value `createNamedSocket` returned: the transport has to
			// survive the round-trip through the registry that both starts went through.
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
			expect(await pingConverges(from, "10.74.0.2")).toBe(true);

			expect((await second.exec("/ping 10.74.0.2 count=3")).output).toContain("packet-loss=0%");
			// Both directions: a datagram pair is two independent bindings, and only one
			// of them failing would still look like a working link from one side.
			expect((await first.exec("/ping 10.74.0.1 count=3")).output).toContain("packet-loss=0%");

			// 3. A restart keeps the slot and the link. Deriving the role from live member
			//    count instead would hand the restarting machine the other end.
			await first.stop();
			expect(getNamedSocket(LINK)?.endpoints).toEqual([SECOND, null]);
			// Not reassigned to `first`: the cleanup below goes by name, and the
			// assertions that follow read the registry and ping from `second`.
			await QuickCHR.start({ background: true, name: FIRST });

			const restarted = getNamedSocket(LINK);
			if (!restarted) throw new Error("named socket vanished");
			expect(getSocketSlot(restarted, FIRST)).toBe(1);

			expect(await pingConverges(from, "10.74.0.2")).toBe(true);
		} finally {
			await cleanupMachine(FIRST);
			await cleanupMachine(SECOND);
		}
	}, bootTestTimeout({ boots: 3 }));
});

describe.skipIf(SKIP || !IS_WINDOWS)("named socket default transport — listen-connect", () => {
	beforeAll(async () => {
		await cleanupMachine(LISTENER);
		await cleanupMachine(CONNECTOR);
		_resetSocketCache();
		removeNamedSocket(LC_LINK);
	});

	afterAll(async () => {
		await cleanupMachine(LISTENER);
		await cleanupMachine(CONNECTOR);
		removeNamedSocket(LC_LINK);
	});

	test("the default a Windows user gets carries traffic, listener first", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		type Instance = Awaited<ReturnType<typeof QuickCHR.start>>;
		let listener: Instance | undefined;
		let connector: Instance | undefined;

		// No `mode`: the point is the transport a bare `networks sockets create` picks
		// here, not one this test names.
		const created = createNamedSocket(LC_LINK);
		expect(created.mode).toBe("listen-connect");
		expect(typeof created.port).toBe("number");

		try {
			// Start order is load-bearing, unlike the dgram arm: slot 0 takes `listen=`
			// and slot 1 `connect=`, and a `connect=` with nothing listening runs on
			// silently and never retries. Slot 0 must therefore also start first.
			listener = await QuickCHR.start({
				...imageTarget(),
				background: true,
				name: LISTENER,
				networks: ["user", { type: "socket", name: LC_LINK }],
			});
			connector = await QuickCHR.start({
				...imageTarget(),
				background: true,
				name: CONNECTOR,
				networks: ["user", { type: "socket", name: LC_LINK }],
			});

			const entry = getNamedSocket(LC_LINK);
			if (!entry) throw new Error("named socket vanished");
			expect(getSocketSlot(entry, LISTENER)).toBe(0);
			expect(getSocketSlot(entry, CONNECTOR)).toBe(1);

			// ether1 is the SLIRP management NIC; ether2 is the named link.
			await listener.exec("/ip/address/add interface=ether2 address=10.75.0.1/24");
			await connector.exec("/ip/address/add interface=ether2 address=10.75.0.2/24");

			expect(await pingConverges(listener, "10.75.0.2")).toBe(true);
			expect((await listener.exec("/ping 10.75.0.2 count=3")).output).toContain("packet-loss=0%");
			expect((await connector.exec("/ping 10.75.0.1 count=3")).output).toContain("packet-loss=0%");
		} finally {
			await cleanupMachine(LISTENER);
			await cleanupMachine(CONNECTOR);
		}
		// No restart leg here, deliberately. QEMU's `listen=` accepts one peer and the
		// reconnect is not modelled, so a restart is a known-dead case for this
		// transport (DESIGN.md, "What the transports actually do") — which is exactly
		// why `dgram` is the default everywhere it exists.
	}, bootTestTimeout({ boots: 2 }));
});
