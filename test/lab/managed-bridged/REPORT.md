# Managed bridged network on hosted CI runners (#270)

**Question:** can a quickchr-managed `bridged:<default-route iface>` network run on
GitHub's hosted macOS runners, and what does a guest on it get?

**Method:** `runBridgedProbe()` in `test/integration/managed-network-harness.ts`:
`quickchr networks create bridged:<iface> --yes` (under `sudo -n`), `status --json`, a
CHR with `--add-network user --add-network bridged:<iface>`, a dhcp-client on ether2
(RouterOS adds one only to ether1), then from the guest: a gateway ping, the gateway's
MAC from ARP, and `:resolve` against the gateway. Evidence lands in
`<dataDir>/test-evidence/managed-network-bridged-probe-*.json`.

## Findings (2026-11-11, socket_vmnet 1.2.2, CHR 7.25.1)

Both runner images reach the internet through `en0` alone, at 192.168.64.x behind a
192.168.64.1 NAT, so bridging the default-route interface bridges the runner's only
uplink.

| Runner | create/status | QEMU attach | Lease | Gateway ARP | Gateway ICMP | Gateway DNS | Runner |
|---|---|---|---|---|---|---|---|
| macos-15 (arm64) | ok | ok | 192.168.64.x from .1 | resolved | **no reply** | **1 of 2** | survives |
| macos-15-intel (x86) | ok | — | — | — | — | — | **lost, 3 of 3** |

- **x86: the runner is lost.** Runs 43078574462, 43086378146 and 43087917622 each
  stopped reporting inside the bridged probe: no step logs, no artifact, the leg
  checkpoint left "running" on the bridged file. The shared lifecycle on the same runner
  image completed in the same period (runs 43086361945, 43091867317). Which step costs
  the runner (the daemon bridging `en0`, or the guest's traffic on it) is not known.
- **arm64: a lease and ARP, nothing above.** The lease and the gateway's MAC show
  frames reaching the guest both ways (ether2 received 714 packets in run
  43087917622). The NAT gateway never answered the guest's ping, and answered its DNS
  query in one run of two (no answer in 43092868845, 55 ms in 43093653118). RouterOS reports `dns server failure` for both a rejected answer
  and a 10 s timeout against a silent server (CHR 7.25.1), so the probe records how
  long the query took.
- **A real LAN gets all of it.** On an Intel Mac with bridged `en0` (Morpheus), the same
  guest commands get a lease, a gateway MAC, a DNS answer and a 0%-loss ping.

## Consequences

- The suite runs the bridged test on Apple Silicon only, requiring the lease and ARP,
  not ICMP or DNS.
- This lab keeps the full probe (DNS and ICMP required) for a physical Mac on a real LAN.
- External LAN reachability, Wi-Fi vs wired, roaming and sleep stay manual (#270 scope).
