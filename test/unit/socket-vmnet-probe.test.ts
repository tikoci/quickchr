import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertSocketVmnetReachable } from "../../src/lib/network.ts";
import type { NetworkConfig } from "../../src/lib/types.ts";
import { QuickCHRError } from "../../src/lib/types.ts";

/**
 * `-netdev stream` does not fail QEMU at startup when its socket is dead: the NIC
 * just stays link-down (QEMU 11.1.1, `info network` reads `connecting`). The
 * `socket_vmnet_client` wrapper used to fail the spawn instead, so launch now probes
 * every requested socket_vmnet socket before spawning. These tests pin that probe,
 * including a stale socket file next to an unrelated live daemon. The old
 * `isSocketVmnetDaemonRunning()` check (socket file + global `pgrep socket_vmnet`)
 * passed that case.
 */

const SKIP = process.platform === "win32";

function vmnetNic(id: string, socketVmnetPath: string): NetworkConfig {
	return { id, specifier: "shared", resolved: { qemuNetdevArgs: [], socketVmnetPath } };
}

async function expectUnavailable(networks: NetworkConfig[], message: RegExp): Promise<void> {
	try {
		await assertSocketVmnetReachable(networks, 1000);
		throw new Error("expected NETWORK_UNAVAILABLE");
	} catch (e) {
		expect(e).toBeInstanceOf(QuickCHRError);
		expect((e as QuickCHRError).code).toBe("NETWORK_UNAVAILABLE");
		expect((e as QuickCHRError).message).toMatch(message);
	}
}

/** A socket file whose listener died without unlinking it, as a crashed daemon leaves.
 *  Closing a listener cleanly removes the file (Bun and node:net both unlink), so the
 *  listener lives in a child that is SIGKILLed. */
async function staleSocket(path: string): Promise<void> {
	const child = Bun.spawn(
		[process.execPath, "-e", `Bun.listen({ unix: ${JSON.stringify(path)}, socket: { data() {} } }); setInterval(() => {}, 1000);`],
		{ env: { ...process.env }, stdout: "ignore", stderr: "ignore" },
	);
	for (let i = 0; i < 100 && !existsSync(path); i++) await Bun.sleep(20);
	child.kill("SIGKILL");
	await child.exited;
	expect(existsSync(path)).toBe(true);
}

describe.skipIf(SKIP)("assertSocketVmnetReachable", () => {
	let dir: string;
	let listeners: Array<{ stop(closeActive?: boolean): void }>;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "quickchr-tmp-vmnet-"));
		listeners = [];
	});

	afterEach(() => {
		for (const l of listeners) l.stop(true);
		rmSync(dir, { recursive: true, force: true });
	});

	function liveSocket(name: string): string {
		const path = join(dir, name);
		listeners.push(Bun.listen({ unix: path, socket: { data() {} } }));
		return path;
	}

	test("passes when every socket accepts a connection", async () => {
		const shared = liveSocket("shared.sock");
		const bridged = liveSocket("bridged.sock");
		await assertSocketVmnetReachable([vmnetNic("net1", shared), vmnetNic("net2", bridged)], 1000);
	});

	test("refuses a stale socket even while another daemon is live", async () => {
		const live = liveSocket("live.sock");
		const stale = join(dir, "stale.sock");
		await staleSocket(stale);
		await expectUnavailable([vmnetNic("net1", live), vmnetNic("net2", stale)], /stale\.sock refused the connection.*stale/);
	});

	test("refuses a missing socket", async () => {
		await expectUnavailable([vmnetNic("net1", join(dir, "absent.sock"))], /does not exist/);
	});

	test.skipIf(process.getuid?.() === 0)("refuses a socket the user may not connect to", async () => {
		const path = liveSocket("private.sock");
		chmodSync(path, 0o000);
		await expectUnavailable([vmnetNic("net1", path)], /Not permitted to connect/);
	});

	test("ignores NICs that are not socket_vmnet-backed", async () => {
		const user: NetworkConfig = { id: "net0", specifier: "user", resolved: { qemuNetdevArgs: ["-netdev", "user,id=net0"] } };
		await assertSocketVmnetReachable([user, { id: "net9", specifier: "user" }], 1000);
	});
});
