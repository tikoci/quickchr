import { describe, test, expect } from "bun:test";

import { imageTarget } from "../../integration/image-target.ts";
import { bootTestTimeout } from "../../integration/timeouts.ts";
import { GUEST_NET_DEADLINE_MS, runBridgedProbe } from "../../integration/managed-network-harness.ts";

/**
 * Lab probe — a quickchr-managed `bridged:` network on the host's default-route
 * interface, on any Mac, with everything required including the gateway's ICMP echo
 * (#270). The suite's arm64-only version (`test/integration/managed-network-bridged.test.ts`)
 * leaves ICMP out and skips x86; see REPORT.md for why.
 *
 * Installs and removes a root LaunchDaemon, so it runs only when asked:
 *
 *   QUICKCHR_LAB_MANAGED_BRIDGED=1 QUICKCHR_INTEGRATION=1 bun test test/lab/managed-bridged/
 *
 * Needs `sudo -n` (run `sudo -v` first, or use a host with passwordless sudo) and no
 * existing managed network on that interface: it refuses to touch one it did not create.
 * On a hosted macos-15-intel runner it costs the runner (REPORT.md).
 */

const RUN = process.env.QUICKCHR_LAB_MANAGED_BRIDGED === "1" && Boolean(process.env.QUICKCHR_INTEGRATION) && process.platform === "darwin";

describe.skipIf(!RUN)("lab: managed bridged network, full LAN probe", () => {
	test("lease, ARP, DNS and an ICMP echo from the gateway", async () => {
		const probe = await runBridgedProbe("lab-managed-bridged", imageTarget());
		expect(probe.lan?.gatewayMac).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/i);
		expect(probe.lan?.dns).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
		expect(probe.lan?.icmp).toBe(true);
	}, bootTestTimeout({ extraMs: 2 * GUEST_NET_DEADLINE_MS }));
});
