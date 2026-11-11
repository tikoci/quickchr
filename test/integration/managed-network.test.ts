import { describe, test, expect } from "bun:test";
import { existsSync } from "node:fs";

import { loadMachine } from "../../src/lib/state.ts";
import { managedSocketPath } from "../../src/lib/platform.ts";
import { SOCKET_VMNET_RELEASE, managedNetworkLabel, planManagedNetwork, sha256File, type ManagedNetworkSpec } from "../../src/lib/vmnet-service.ts";
import type { ChrInstance, NetworkSpecifier } from "../../src/lib/types.ts";
import { imageTarget } from "./image-target.ts";
import { bootTestTimeout } from "./timeouts.ts";
import {
	GUEST_NET_DEADLINE_MS,
	INTEGRATION,
	LIFECYCLE_OPTED_IN,
	MANAGED_HOST,
	assertMachineAbsent,
	cleanupMachine,
	cleanupService,
	expectExit,
	guestEvidence,
	hostEvidence,
	isAlive,
	launchctlLoaded,
	ownership,
	phase,
	preflight,
	processUid,
	qemuArgv,
	quickchr,
	sh,
	show,
	status,
	waitForGuestTraffic,
	guestReachesHost,
	hostReachesGuest,
	withCleanup,
	writeEvidence,
	type HostBaseline,
} from "./managed-network-harness.ts";

/**
 * Integration test — quickchr-managed host networks (#256, #270).
 *
 * `quickchr networks create|status|restart|remove` puts the root that every vmnet mode
 * needs into one LaunchDaemon per network (a pinned upstream socket_vmnet), and machines
 * attach to its socket unprivileged. The unit tier proves the plan and the generated
 * root scripts. This proves the parts that only exist on a real host: the installer,
 * launchd ownership, status, recovery and removal, with a real guest on the network.
 *
 * Which half runs is decided by what the host supports, not by where the suite runs:
 *
 * - **macOS** has the implementation, so it runs the lifecycle. It installs a root
 *   LaunchDaemon and removes it again, which is exactly what CI is for and what a
 *   developer's `bun test` must not do on its own: it runs on a CI runner
 *   (`GITHUB_ACTIONS=true`, where hosted macOS has passwordless sudo) and locally only
 *   with `QUICKCHR_TEST_MANAGED_NETWORK=1`. Either way it needs `sudo -n`; without it
 *   the test fails rather than skipping, since a skip would read as coverage. It also
 *   refuses to touch a managed network that already exists (these are host-wide and
 *   may carry someone's machines) or a machine with one of its names.
 * - **Every other host** asserts the honest negative: every `networks` lifecycle
 *   command, and any machine asking for `shared`/`bridged:`, is refused as
 *   NETWORK_UNAVAILABLE before anything is created. When Linux gains its own
 *   sudo-installed networks (#263), it moves from that half to a lifecycle of its own.
 *
 * quickchr itself always runs unprivileged here. Only its own root script is elevated
 * (`--yes` without a terminal runs it under `sudo -n`), plus the `launchctl bootout`
 * that simulates an admin unloading the job.
 *
 * The data dir is the normal one, not an isolated copy: the `remove` guard reads the
 * machines in the data dir the CLI sees, and the test machine has to be one of them,
 * as it is for a user. It also keeps the runner's warm image cache. Name collisions are
 * refused at preflight rather than cleaned up, so a developer's machines are never touched.
 *
 * Evidence goes to `<dataDir>/test-evidence/` (integration.yml uploads it): a summary
 * of every phase always, and on failure the plist, `launchctl print`, the helper log,
 * socket and plist ownership, the QEMU argv, guest state, and every CLI call made.
 */

const SHARED_MACHINE = "integration-managed-shared";
const UNAVAILABLE_MACHINE = "integration-managed-unavailable";

/** Traffic on `shared` beyond the gateway echo: the guest opens TCP to a listener on
 *  the host (the gateway's address). The opposite direction is recorded, not asserted:
 *  see `hostReachesGuest`. */
async function expectGuestReachesHost(instance: ChrInstance, lease: { address: string; gateway: string }, record: Record<string, unknown>, key: string): Promise<void> {
	const guestToHost = await guestReachesHost(instance, lease.gateway);
	record[key] = { guestToHost, hostToGuest: await hostReachesGuest(lease.address.split("/")[0] as string) };
	if (!guestToHost.ok) throw new Error(`the guest could not fetch from the host over shared: ${guestToHost.detail}`);
}

// ── macOS: the lifecycle ───────────────────────────────────────────────────────

describe.skipIf(!INTEGRATION || !MANAGED_HOST || !LIFECYCLE_OPTED_IN)("managed host network lifecycle (macOS, sudo)", () => {
	test("shared: create, attach a guest, restart under it, reload an unloaded job, guarded remove", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		const spec: ManagedNetworkSpec = { mode: "shared" };
		const label = managedNetworkLabel(spec);
		const plan = planManagedNetwork(spec);
		const socketPath = managedSocketPath("shared");
		const record: Record<string, unknown> = { host: { arch: process.arch, uid: process.getuid?.() }, helper: SOCKET_VMNET_RELEASE.version };
		let baseline: HostBaseline | undefined;
		let instance: ChrInstance | undefined;
		let qemuPid: number | undefined;
		const evidence = async () => ({ ...(await hostEvidence(spec, qemuPid)), guest: await guestEvidence(instance) });

		await withCleanup(async () => {
			baseline = await phase(record, "preflight", evidence, () => preflight(spec, [SHARED_MACHINE]));

			await phase(record, "refused-before-create", evidence, async () => {
				// No daemon serves shared yet, and QEMU's native vmnet would need root: the
				// launch is refused with the one-sudo fix, and leaves no machine behind.
				const err = await QuickCHR.start({ ...imageTarget(), background: true, name: SHARED_MACHINE, networks: ["user", "shared"] })
					.then(() => undefined, (e: unknown) => e as { code?: string; installHint?: string });
				expect(err?.code).toBe("NETWORK_UNAVAILABLE");
				expect(err?.installHint).toContain("quickchr networks create shared");
				expect(QuickCHR.get(SHARED_MACHINE)).toBeNull();
			});

			await phase(record, "create", evidence, async () => {
				const r = await quickchr("networks", "create", "shared", "--yes");
				expectExit(r, 0);
				expect(r.stdout).toContain("socket accepting");

				const { result, row } = await status("shared");
				expectExit(result, 0);
				expect(row).toMatchObject({ specifier: "shared", label, plistPath: plan.plistPath, socketPath, loaded: true, running: true, ok: true, socket: { state: "accepting" } });
				expect(row?.pid).toBeGreaterThan(0);
				record.helperPid = row?.pid;

				// What runs as root is root's and nobody else can change it; the socket is
				// open to the staff group, which is how an unprivileged QEMU attaches.
				expect(ownership(plan.plistPath)).toBe("root wheel -rw-r--r--");
				expect(ownership(plan.helperPath)).toBe("root wheel -rwxr-xr-x");
				expect(await sha256File(plan.helperPath)).toBe(plan.asset.binarySha256);
				expect(ownership(socketPath)).toBe("root staff srwxrwx---");
				expect(launchctlLoaded(label)).toBe(true);

				// A second create of the same network is a no-op, not a reinstall.
				const again = await quickchr("networks", "create", "shared", "--yes");
				expectExit(again, 0);
				expect(again.stdout).toContain("Nothing to do");
				expect((await status("shared")).row?.pid).toBe(row?.pid);
			});

			const firstLease = await phase(record, "attach", evidence, async () => {
				instance = await QuickCHR.start({ ...imageTarget(), background: true, name: SHARED_MACHINE, networks: ["user", "shared"] });
				qemuPid = loadMachine(SHARED_MACHINE)?.pid;
				expect(qemuPid).toBeGreaterThan(0);
				const pid = qemuPid as number;
				// QEMU runs as this user, not root: the root is all in the daemon.
				expect(processUid(pid)).toBe(process.getuid?.() as number);
				const argv = qemuArgv(pid);
				expect(argv).toContain(`-netdev stream,id=net1,server=off,addr.type=unix,addr.path=${socketPath}`);
				expect(argv).toMatch(/addr\.path=\/var\/run\/quickchr-net-shared\.sock,reconnect-ms=\d+/);
				expect(argv).not.toContain("socket_vmnet_client");

				const guest = instance;
				await guest.exec("/ip/dhcp-client/add interface=ether2 add-default-route=no");
				const lease = await waitForGuestTraffic(guest, "ether2");
				if (!lease) throw new Error("no DHCP lease with a gateway echo on ether2 (shared) before the deadline");
				await expectGuestReachesHost(guest, lease, record, "tcpAfterAttach");
				return lease;
			});
			record.firstLease = firstLease;

			await phase(record, "restart-under-a-guest", evidence, async () => {
				const before = (await status("shared")).row?.pid;
				const r = await quickchr("networks", "restart", "shared", "--yes");
				expectExit(r, 0);
				const { row } = await status("shared");
				expect(row?.ok).toBe(true);
				expect(row?.pid).toBeGreaterThan(0);
				expect(row?.pid).not.toBe(before);
				record.restartPids = { before, after: row?.pid };

				// The VM was not restarted with it: same QEMU, still alive, and its NIC
				// re-attached by itself (reconnect-ms). Traffic, not just the socket, is back.
				expect(loadMachine(SHARED_MACHINE)?.pid).toBe(qemuPid);
				expect(isAlive(qemuPid as number)).toBe(true);
				const lease = await waitForGuestTraffic(instance as ChrInstance, "ether2");
				if (!lease) throw new Error("guest traffic on ether2 did not recover after networks restart");
				await expectGuestReachesHost(instance as ChrInstance, lease, record, "tcpAfterRestart");
				record.leaseAfterRestart = lease;
			});

			await phase(record, "reload-an-unloaded-job", evidence, async () => {
				// An admin's `launchctl bootout` (or a bootstrap that failed) leaves the plist
				// but no job. status says so, and restart loads it again rather than failing
				// on a kickstart of a job launchd does not have.
				expectExit(await sh(["sudo", "-n", "launchctl", "bootout", `system/${label}`]), 0);
				// bootout returns while the job is still `SIGTERMed`; the core's own scripts
				// wait for the unload the same way (unloadLabel in vmnet-service.ts).
				const deadline = Date.now() + 10_000;
				while (launchctlLoaded(label) && Date.now() < deadline) await Bun.sleep(100);
				expect(launchctlLoaded(label)).toBe(false);
				const down = await status("shared");
				expectExit(down.result, 1);
				expect(down.row).toMatchObject({ loaded: false, running: false, ok: false });

				// create on an installed service that is not serving changes nothing (no root
				// step) and says why, with the helper's log rather than a pointer to it.
				const recreate = await quickchr("networks", "create", "shared", "--yes");
				expectExit(recreate, 1);
				expect(recreate.stderr).toContain("Error [NETWORK_UNAVAILABLE]");
				expect(recreate.stderr).toContain(`Last lines of ${plan.logPath}`);
				expect(recreate.stderr).toContain("quickchr networks restart shared");

				const r = await quickchr("networks", "restart", "shared", "--yes");
				expectExit(r, 0);
				const up = await status("shared");
				expectExit(up.result, 0);
				expect(up.row).toMatchObject({ loaded: true, running: true, ok: true });
				expect(isAlive(qemuPid as number)).toBe(true);
				const lease = await waitForGuestTraffic(instance as ChrInstance, "ether2");
				if (!lease) throw new Error("guest traffic on ether2 did not recover after the job was reloaded");
				await expectGuestReachesHost(instance as ChrInstance, lease, record, "tcpAfterReload");
			});

			await phase(record, "remove", evidence, async () => {
				// A running machine on the network blocks remove, and nothing is touched.
				const refused = await quickchr("networks", "remove", "shared", "--yes");
				expectExit(refused, 1);
				expect(refused.stderr).toContain("MACHINE_RUNNING");
				expect(refused.stderr).toContain(SHARED_MACHINE);
				expect((await status("shared")).row?.ok).toBe(true);

				await (instance as ChrInstance).stop();
				instance = undefined;
				const removed = await quickchr("networks", "remove", "shared", "--yes");
				expectExit(removed, 0);
				expect(existsSync(plan.plistPath)).toBe(false);
				expect(existsSync(socketPath)).toBe(false);
				expect(launchctlLoaded(label)).toBe(false);
				const gone = await status("shared");
				expectExit(gone.result, 1);
				expect(gone.row).toBeUndefined();

				// The stopped machine still asks for shared, which no longer exists: it is
				// refused with the fix rather than booting with its NIC down.
				const err = await QuickCHR.start({ background: true, name: SHARED_MACHINE })
					.then(() => undefined, (e: unknown) => e as { code?: string; installHint?: string });
				expect(err?.code).toBe("NETWORK_UNAVAILABLE");
				expect(err?.installHint).toContain("quickchr networks create shared");
			});
		}, async () => {
			// Only after preflight (baseline): the machine did not exist, so it is this run's.
			const problems = baseline ? [...(await cleanupMachine(SHARED_MACHINE)), ...(await cleanupService(spec, baseline, "shared"))] : [];
			record.cleanup = problems.length === 0 ? "clean" : problems;
			const where = await writeEvidence("shared-summary", record);
			console.log(`managed-network shared summary (${where}):\n${JSON.stringify(record, null, 2)}`);
			return problems;
		});
	}, bootTestTimeout({ extraMs: 4 * GUEST_NET_DEADLINE_MS }));
});


// ── every other host: an honest "not available" ────────────────────────────────

describe.skipIf(!INTEGRATION || MANAGED_HOST)(`managed host networks are unavailable on ${process.platform}`, () => {
	test("every networks lifecycle command is refused as NETWORK_UNAVAILABLE, naming this host", async () => {
		for (const args of [["create", "shared", "--yes"], ["status"], ["status", "shared"], ["restart", "shared", "--yes"], ["remove", "shared", "--yes"]]) {
			const r = await quickchr("networks", ...args);
			if (r.exitCode !== 1 || !r.stderr.includes("Error [NETWORK_UNAVAILABLE]") || !r.stderr.includes(`this host is ${process.platform}`)) {
				throw new Error(`expected a NETWORK_UNAVAILABLE refusal naming ${process.platform}\n${show(r)}`);
			}
		}
		const overview = await quickchr("networks");
		expectExit(overview, 0);
		expect(overview.stdout).toContain("socket_vmnet:   n/a (macOS only)");
	}, 120_000);

	test("a machine asking for shared or bridged is refused before anything is created", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		await assertMachineAbsent(UNAVAILABLE_MACHINE);
		await withCleanup(async () => {
			const asked: NetworkSpecifier[] = ["shared", { type: "bridged", iface: "eth0" }];
			for (const net of asked) {
				const err = await QuickCHR.start({ ...imageTarget(), background: true, name: UNAVAILABLE_MACHINE, networks: ["user", net] })
					.then(() => undefined, (e: unknown) => e as { code?: string; message?: string });
				expect(err?.code).toBe("NETWORK_UNAVAILABLE");
				expect(QuickCHR.get(UNAVAILABLE_MACHINE)).toBeNull();
			}
		}, () => cleanupMachine(UNAVAILABLE_MACHINE));
	}, bootTestTimeout());
});
