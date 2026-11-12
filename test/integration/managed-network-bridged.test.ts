import { describe, test, expect } from "bun:test";

import { imageTarget } from "./image-target.ts";
import { bootTestTimeout } from "./timeouts.ts";
import { GUEST_NET_DEADLINE_MS, INTEGRATION, LIFECYCLE_OPTED_IN, MANAGED_HOST, runBridgedProbe } from "./managed-network-harness.ts";

/**
 * Integration test — a quickchr-managed `bridged:` network on the host's default-route
 * interface (#270). Same gating and harness as `managed-network.test.ts` (macOS, CI or
 * QUICKCHR_TEST_MANAGED_NETWORK=1, `sudo -n`), plus **Apple Silicon only**.
 *
 * On a hosted runner that interface is the runner's only uplink (`en0`, behind the
 * runner VM's 192.168.64.1 NAT on both arches). On macos-15-intel, bridging it lost the
 * runner three times out of three, with no logs (runs 43078574462, 43086378146,
 * 43087917622), while the shared lifecycle on the same runner image completed. A
 * bridged `en0` on a physical Intel Mac works (Morpheus), so this is the hosted x86
 * runner's network, not quickchr; the full probe lives in `test/lab/managed-bridged/`.
 *
 * What is asserted is what a bridged guest on the arm64 runner gets: the service serves,
 * QEMU attaches to the managed socket, a DHCP lease, and the gateway's MAC by ARP (a
 * unicast reply delivered to the guest). The gateway's ICMP echo and DNS answer are
 * recorded, not required: the runner's NAT gateway (192.168.64.1) never answered a
 * bridged guest's ping and answered its DNS in one run of two (43092868845 no,
 * 43093653118 yes), while a real LAN answers both (lab probe).
 */

const SKIP = !INTEGRATION || !MANAGED_HOST || !LIFECYCLE_OPTED_IN || process.arch !== "arm64";

describe.skipIf(SKIP)("managed bridged network (macOS arm64, sudo)", () => {
	test("bridged on the default-route interface: a lease, and the gateway answers ARP", async () => {
		const probe = await runBridgedProbe("integration-managed-bridged", imageTarget());
		expect(probe.lease).toBeDefined();
		expect(probe.lan?.gatewayMac).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/i);
	}, bootTestTimeout({ extraMs: 2 * GUEST_NET_DEADLINE_MS }));
});
