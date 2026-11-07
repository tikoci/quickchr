import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { monitorCommand, channelPath } from "../../src/lib/channels.ts";
import { socketVmnetNetdev } from "../../src/lib/network.ts";
import { findQemuBinary, getQemuVersion } from "../../src/lib/platform.ts";

/**
 * Integration test — socket_vmnet NICs attach with QEMU's own `-netdev stream` (#256).
 *
 * Requires QEMU. Skipped unless QUICKCHR_INTEGRATION=1. Needs no root, no guest and no
 * socket_vmnet daemon: temporary unix listeners stand in for the daemon. socket_vmnet
 * speaks QEMU's stream framing, so what this exercises is QEMU's attach and re-attach
 * against the exact netdev strings `socketVmnetNetdev()` emits. QEMU runs paused (`-S`,
 * TCG); stream netdevs connect and reconnect regardless (verified on QEMU 11.1.1).
 * Attach state is read from the monitor's `info network`: `unix:<path>` when attached,
 * `connecting` while a reconnect-ms NIC retries, `error:` after a failed connect without
 * reconnect-ms. Without reconnect-ms a NIC whose daemon went away still reads
 * `unix:<path>` (found by mutating the gate), so only the reconnect test can prove
 * re-attachment.
 *
 * Guest traffic over a real daemon is the opt-in `socket-vmnet-chr.test.ts`.
 */

const SKIP = !process.env.QUICKCHR_INTEGRATION || process.platform === "win32";

const hostArch = process.arch === "arm64" ? "arm64" : "x86";
const qemuBin = findQemuBinary(hostArch);
const qemuVersion = qemuBin ? getQemuVersion(qemuBin) : undefined;
const machineArgs = hostArch === "arm64" ? ["-M", "virt", "-cpu", "cortex-a57"] : ["-M", "pc"];

/** `-netdev stream,…,reconnect-ms` exists from QEMU 9.2. */
function supportsReconnect(version: string | undefined): boolean {
	if (!version) return false;
	const [major = 0, minor = 0] = version.split(".").map((p) => Number.parseInt(p, 10) || 0);
	return major > 9 || (major === 9 && minor >= 2);
}

interface FakeDaemon {
	path: string;
	connections: number;
	stop(): void;
}

function fakeDaemon(path: string): FakeDaemon {
	const daemon: FakeDaemon = { path, connections: 0, stop: () => {} };
	const listener = Bun.listen({
		unix: path,
		socket: {
			open() {
				daemon.connections++;
			},
			data() {},
		},
	});
	daemon.stop = () => listener.stop(true);
	return daemon;
}

describe.skipIf(SKIP)("socket_vmnet NICs over -netdev stream (real QEMU)", () => {
	let dir: string;
	let qemu: ReturnType<typeof Bun.spawn> | undefined;
	let daemons: FakeDaemon[];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "quickchr-tmp-stream-"));
		daemons = [];
	});

	afterEach(async () => {
		if (qemu) {
			qemu.kill("SIGKILL");
			await qemu.exited;
			qemu = undefined;
		}
		for (const d of daemons) d.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	function spawnQemu(socketPaths: string[]): ReturnType<typeof Bun.spawn> {
		if (!qemuBin) throw new Error(`no QEMU binary for ${hostArch}`);
		const nicArgs = socketPaths.flatMap((path, i) => [
			"-netdev", socketVmnetNetdev(`net${i + 1}`, path, qemuVersion),
			"-device", `virtio-net-pci,netdev=net${i + 1}`,
		]);
		return Bun.spawn(
			[
				qemuBin, ...machineArgs, "-accel", "tcg", "-m", "128", "-S",
				"-display", "none", "-serial", "none",
				"-chardev", `socket,id=mon0,path=${channelPath(dir, "monitor")},server=on,wait=off`,
				"-mon", "chardev=mon0,mode=readline",
				...nicArgs,
			],
			{ stdout: "ignore", stderr: "pipe" },
		);
	}

	/** Attach state per NIC id from `info network`: the text after `type=stream,`. */
	async function streamStates(): Promise<Record<string, string>> {
		const out = await monitorCommand(dir, "info network", 3000);
		const states: Record<string, string> = {};
		for (const m of out.matchAll(/(net\d+): index=\d+,type=stream,(\S+)/g)) {
			if (m[1] && m[2]) states[m[1]] = m[2];
		}
		return states;
	}

	async function waitForStates(want: (s: Record<string, string>) => boolean, label: string): Promise<Record<string, string>> {
		let last: Record<string, string> = {};
		for (let i = 0; i < 50; i++) {
			try {
				last = await streamStates();
				if (want(last)) return last;
			} catch {
				// monitor not up yet
			}
			await Bun.sleep(200);
		}
		throw new Error(`timed out waiting for ${label}; last info network states: ${JSON.stringify(last)}`);
	}

	test("two socket_vmnet NICs attach to their own sockets in one QEMU", async () => {
		const a = fakeDaemon(join(dir, "shared.sock"));
		const b = fakeDaemon(join(dir, "bridged.sock"));
		daemons.push(a, b);
		qemu = spawnQemu([a.path, b.path]);

		const states = await waitForStates((s) => s.net1 === `unix:${a.path}` && s.net2 === `unix:${b.path}`, "both NICs attached");
		expect(states).toEqual({ net1: `unix:${a.path}`, net2: `unix:${b.path}` });
		expect(a.connections).toBe(1);
		expect(b.connections).toBe(1);
	}, 60_000);

	test("a dead socket does not stop QEMU — the NIC just stays link-down (why launch probes first)", async () => {
		qemu = spawnQemu([join(dir, "absent.sock")]);
		// With reconnect-ms the NIC keeps retrying (`connecting`); without it QEMU records
		// the failed connect (`error:` on 11.1.1) and still runs. Either way it is not
		// attached, which is all this asserts so it holds across QEMU versions.
		const notAttached = (s: Record<string, string>) => s.net1 !== undefined && !s.net1.startsWith("unix:");
		await waitForStates(notAttached, "net1 present but not attached");
		await Bun.sleep(1000);
		expect(notAttached(await streamStates())).toBe(true);
		expect(qemu.exitCode).toBeNull();
	}, 60_000);

	test.skipIf(!supportsReconnect(qemuVersion))(
		`daemon restart: both NICs re-attach without restarting QEMU (needs QEMU 9.2+, found ${qemuVersion ?? "unknown"})`,
		async () => {
			const paths = [join(dir, "shared.sock"), join(dir, "bridged.sock")];
			daemons.push(...paths.map(fakeDaemon));
			qemu = spawnQemu(paths);
			const pid = qemu.pid;
			await waitForStates((s) => s.net1?.startsWith("unix:") === true && s.net2?.startsWith("unix:") === true, "initial attach");

			for (const d of daemons) d.stop();
			daemons = [];
			await waitForStates((s) => s.net1 === "connecting" && s.net2 === "connecting", "both NICs link-down after daemon stop");

			const restarted = paths.map(fakeDaemon);
			daemons.push(...restarted);
			await waitForStates((s) => s.net1 === `unix:${paths[0]}` && s.net2 === `unix:${paths[1]}`, "both NICs re-attached");
			expect(restarted.map((d) => d.connections)).toEqual([1, 1]);
			expect(qemu.pid).toBe(pid);
			expect(qemu.exitCode).toBeNull();
		},
		60_000,
	);
});
