import { describe, test, expect, beforeAll } from "bun:test";
import { loadMachine } from "../../src/lib/state.ts";
import { imageTarget } from "./image-target.ts";
import { bootTestTimeout } from "./timeouts.ts";

/**
 * Opt-in integration test — a CHR on two socket_vmnet bridged NICs gets real LAN leases (#256).
 *
 * Runs only with QUICKCHR_INTEGRATION=1 **and** QUICKCHR_TEST_VMNET_BRIDGED=<iface>
 * on macOS, against a socket_vmnet daemon already serving that interface: a
 * quickchr-managed `/var/run/quickchr-net-bridged-<iface>.sock`
 * (`quickchr networks create bridged:<iface>`), or a Homebrew/lima
 * `socket_vmnet.bridged.<iface>` in a directory quickchr scans. CI has no such daemon, so it never runs there. The test boots one guest
 * through the library as the current (unprivileged) user and never touches the
 * daemon: no restart, no sudo.
 *
 * `socket-vmnet-stream.test.ts` covers QEMU's attach and reconnect layer without a
 * daemon. This one covers what that cannot: library wiring end to end (resolution,
 * the pre-spawn socket probe, argv without a `socket_vmnet_client` wrapper) and guest
 * DHCP traffic over a real vmnet bridge. Two bridged NICs are used because one VM
 * holding more than one socket_vmnet network is exactly what the wrapper made
 * impossible.
 *
 * Daemon-restart recovery with a real daemon is a manual check, kept out of an
 * automated test so it cannot restart a developer's shared service. Run this with a
 * dedicated test daemon, then `sudo launchctl kickstart -k system/<label>` and confirm
 * that both leases still answer. Recorded in docs/macos-managed-services-research.md.
 */

const IFACE = process.env.QUICKCHR_TEST_VMNET_BRIDGED;
const SKIP = !process.env.QUICKCHR_INTEGRATION || !IFACE || process.platform !== "darwin";
const NAME = "integration-vmnet-bridged";
const LEASE_DEADLINE_MS = 60_000;

async function cleanupMachine(name: string): Promise<void> {
	const { QuickCHR } = await import("../../src/lib/quickchr.ts");
	const existing = QuickCHR.get(name);
	if (!existing) return;
	try { await existing.stop(); } catch { /* ignore */ }
	try { await existing.remove(); } catch { /* ignore */ }
}

describe.skipIf(SKIP)(`socket_vmnet bridged:${IFACE} on a real daemon`, () => {
	beforeAll(async () => {
		await cleanupMachine(NAME);
	});

	test("two bridged NICs attach without a wrapper and each gets a DHCP lease", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		const iface = IFACE as string;
		let instance: Awaited<ReturnType<typeof QuickCHR.start>> | undefined;
		try {
			instance = await QuickCHR.start({
				...imageTarget(),
				background: true,
				name: NAME,
				networks: ["user", { type: "bridged", iface }, { type: "bridged", iface }],
			});

			const pid = loadMachine(NAME)?.pid;
			expect(pid).toBeDefined();
			const argv = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)]).stdout.toString();
			expect(argv).not.toContain("socket_vmnet_client");
			// Whichever socket detection picked (managed sockets win over lima-named ones),
			// both NICs must be on it.
			const { detectSocketVmnet } = await import("../../src/lib/platform.ts");
			const socket = detectSocketVmnet()?.bridgedSockets[iface];
			expect(socket).toBeDefined();
			for (const id of ["net1", "net2"]) {
				expect(argv).toContain(`-netdev stream,id=${id},server=off,addr.type=unix,addr.path=${socket}`);
			}

			const guest = instance;
			await guest.exec("/ip/dhcp-client/add interface=ether2 add-default-route=no");
			await guest.exec("/ip/dhcp-client/add interface=ether3 add-default-route=no");
			const bound = await guest.waitFor(async () => {
				const out = (await guest.exec("/ip/dhcp-client/print terse where status=bound")).output;
				return out.includes("interface=ether2") && out.includes("interface=ether3");
			}, LEASE_DEADLINE_MS);
			expect(bound).toBe(true);
		} finally {
			await cleanupMachine(NAME);
		}
	}, bootTestTimeout({ extraMs: LEASE_DEADLINE_MS }));
});
