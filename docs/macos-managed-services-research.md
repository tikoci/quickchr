# Managed macOS networks and persistent machines — research direction

<!-- cspell:ignore mxcl AMFI feth dylibs pmset fdesetup authrestart scz bigdude traceroute brlab vmenet dstnat GPG daemonizing -->

Discussion captured: 2026-11-07; see "Plan: two tracks" for the current split. **Research direction, not an accepted service
API or implemented feature.** This is a multi-session investigation; final CLI
and library surfacing comes after the networking and lifecycle model is grounded.

## Purpose and ownership

Use this Intel Mac (Morpheus) as the proving host, with app-t3code running inside
a persistent quickchr CHR as the real workload. The requirement includes a usable
LAN connection through native vmnet bridging to en0, not just an always-running
QEMU with localhost forwards. The goal is a model suitable for incorporation
into quickchr, rather than a one-off deployment that happens to keep T3 running.

**Replace Homebrew service management, not necessarily socket_vmnet.** Homebrew
may supply the binary. Quickchr should own the reviewed installation, launchd
jobs, network configuration, socket endpoints, access permissions, health checks,
and the mapping from a machine NIC to the intended network. There is no current
proposal to rewrite socket_vmnet's packet transport or Apple's vmnet framework.

The desired experience is one concrete, bounded `sudo` setup path, followed by
ordinary owner-level machine use. The setup installs approved service definitions
and an explicit authorization boundary; it must not grant unrestricted execution
of future editable scripts or arbitrary privileged arguments. Changes outside the
approved network configuration and trusted upgrades may require elevation again.
A one-time setup is not a promise that every future administrative change is free
of authorization.

Socket networks remain useful for many tests. When a consumer needs a real LAN,
the eventual quickchr model should describe and expose the required plumbing
itself, rather than making each consumer maintain its own Homebrew/launchctl
runbook or encode host-specific setup in public skills.

## Research map

- [Launchd feasibility assessment](macos-launchd-research.md): direct-QEMU
  supervision, privileges, state, deployment, and lifecycle boundaries.
- [Mac experiment report](../test/lab/macos-launchd/REPORT.md): actual results on
  this host, with installed plist, generator manifest, and daemon stderr.
- [Networking reference](networking.md): existing transports, platform details,
  and earlier privilege-once proposals. Examples there are not evidence that a
  managed-network command has shipped.
- [UTM research](utm-integration-research.md): separate, lower-priority UTM-native
  creation/provisioning direction. UTM does not own this persistent guest.

The initial experiment was prepared at commit `32a288b` on 2026-11-06. Its Mac
results were left uncommitted on this Mac, while Orca's main checkout retained
"Mac validation pending" wording. Inspection on 2026-11-07 found Orca clean at
`faac687`, also GitHub main, and this Mac four commits behind with the report and
evidence uncommitted. UTM research and the lab generator matched across machines.
The lab was cleaned up; it did not leave a permanent service installed.

## Host observations, 2026-11-07

These were read-only inspections, not a new failure reproduction or bridge test.

- `gui/506/sh.brew.socket_vmnet` is a user LaunchAgent, not running, last exit
  **78 / EX_CONFIG**. Its plist is
  `~/Library/LaunchAgents/sh.brew.socket_vmnet.plist`.
- `system/homebrew.mxcl.socket_vmnet` is a system LaunchDaemon, not running,
  last exit **1**, installed under `/Library/LaunchDaemons`.
- Both jobs execute `/usr/local/opt/socket_vmnet/bin/socket_vmnet` with
  `--vmnet-gateway=192.168.105.1` and socket `/usr/local/var/run/socket_vmnet`.
  Both use the same stderr/stdout files under `/usr/local/var/log/socket_vmnet`.
  Both set `RunAtLoad`; neither plist sets `KeepAlive`. Neither requests bridged
  mode or en0. These are competing definitions, not proof of concurrent running.
- The socket still exists, owned by root with group staff, despite no matching
  process from `pgrep`. Shared stderr includes repeated
  `vmnet_start_interface: [1001] VMNET_FAILURE` and older successful starts.
  Shared logs have insufficient attribution to assign each failure to a job.
  Exit 78 alone does not prove a particular permission or configuration cause.
- `isSocketVmnetDaemonRunning()` in `src/lib/platform.ts` combines socket
  existence/type with a global `pgrep socket_vmnet`. It does not verify that
  the requested socket has a responsive listener belonging to the intended job.
  Detection scans conventional paths; it does not manage network definitions.
- `shared` and `bridged:<iface>` resolution in `src/lib/network.ts` depends on
  detected helper sockets, otherwise choosing native QEMU vmnet with a privilege
  warning. A discovered but dead helper socket errors rather than falling back.
  The wrapper integration currently supports only one helper-backed NIC per VM.
- en0 is Wi-Fi on this Mac. The earlier lab tested raw bridged backend startup
  on en0, but no guest traffic. Its wired-only deferral does not settle whether
  this workload works over Wi-Fi; actual DHCP and LAN service delivery are open.
- The pre-existing `t3code` guest was running as the owner, x86/HVF, with a boot
  disk plus an app data disk, using user networking and host port 9156 forwarded
  to guest port 3773. `/.well-known/t3/environment` on that forwarded endpoint
  returned `serverVersion: 0.1.6`. No quickchr LaunchDaemon was installed.
  Pairing/environment-link status and LAN reachability were not verified.

## Grounding: where root has to live, 2026-11-07 (second session)

Unprivileged probes on this Mac (macOS 26.6.2, SIP on, QEMU 11.1.1, socket_vmnet
1.2.2). Sources live in [`test/lab/macos-launchd/grounding/`](../test/lab/macos-launchd/grounding/).
No sudo was used, nothing was installed, and both brew jobs were left untouched.

### Every vmnet path is privileged; the entitlement cannot be self-granted

`vmnet-probe.c` (clang, `-framework vmnet`, ad-hoc signed, euid 506):

| Call | Result as owner |
|---|---|
| legacy `vmnet_start_interface` shared / host / bridged en0 | `1001 VMNET_FAILURE` (all three) |
| macOS 26 `vmnet_network_create` shared / host / shared+`set_external_interface(en0)` | `1002 VMNET_MEM_FAILURE` (misleading code; same binary under root is untested) |
| macOS 26 `vmnet_network_configuration_create(BRIDGED)` | `1001`; the header says the new API is **shared or host only** |
| same binary ad-hoc signed with `com.apple.vm.networking` | **SIGKILL (exit 137)** at exec: AMFI rejects the restricted entitlement |

`vmnet_copy_shared_interface_list()` reports `en0` plus six `feth*` interfaces
as bridgeable. So root is unavoidable for any vmnet mode with Homebrew QEMU
or any quickchr-built helper. The design question is **which process holds root**:
the QEMU per machine (native `-netdev vmnet-*`) or a helper per network (socket_vmnet).
The macOS 26 network-object API (DHCP reservations, port forwarding, NAT on/off,
cross-process serialization) maps closely onto a named-network concept. It is a
later option for shared/host networks only. QEMU does not consume it, and it
does not remove the need for root.

### The Homebrew breakage has concrete causes, none in socket_vmnet

1. Homebrew changed service labels in Sept. 2026 (`fdf5b3be68`, "recognize both
   macOS service labels"; `7997bf55b7`). The old root daemon
   `homebrew.mxcl.socket_vmnet` (Aug 30) still exists beside the new
   `sh.brew.socket_vmnet` agent (Nov 2).
2. The Nov 2 agent was created by a non-sudo `brew services start`. As a user
   job, socket_vmnet cannot succeed: running it as owner reproduces the exact
   `vmnet_start_interface: [1001] VMNET_FAILURE` lines in the shared log.
3. The agent never reaches exec. A `/usr/bin/true` user job given the same
   root-owned `StandardErrorPath` exits **78 EX_CONFIG**. The value comes from
   launchd failing to open stdio, not socket_vmnet. A user-level `brew services
   list` shows only the agent and hides the system daemon.

The daemon's own `last exit = 1` (`runs = 1`) remains unattributed.

### Attachment: the one-network limit has two sources

Homebrew's one-liner (`sudo brew services start socket_vmnet`) installs exactly one
shared-mode daemon. A second network, such as bridged en0, means copying and
editing a plist by hand (socket_vmnet's README does this with `sed`). On the
quickchr side, it attaches through `socket_vmnet_client <sock> qemu … -netdev socket,fd=3`
and rejects a second wrapper (`resolveAllNetworks`). QEMU 11's
`-netdev stream,server=off,addr.type=unix,addr.path=<sock>` needs no wrapper.
`stream-listener.ts` with two stream NICs on one unprivileged QEMU (`-boot n`,
iPXE DHCP) gave two connections and received 4-byte big-endian length-prefixed
frames carrying the expected source MAC. This is the length-prefixed framing
socket_vmnet speaks. **End-to-end against a live root socket_vmnet is not yet
run.**

### Trust surface of each root placement

| | Native vmnet (root QEMU, `-run-with user=`) | socket_vmnet (root helper) |
|---|---|---|
| Root executable | QEMU plus **18 direct non-system dylibs** under owner-writable `/usr/local/opt` | 30 KB binary linking only libSystem and vmnet; Cellar file is already `root:admin r-x` |
| Owner-controlled input opened as root | Disk images and the machine directory (opened before the drop), plus the sockets the lab found root-owned | Its own socket path |
| Machine start/stop | System-domain `launchctl` requires sudo on every start and stop (or a sudoers rule) | Machine can be an owner LaunchAgent with no sudo after network setup |
| Interactive `quickchr start` | Still needs sudo, so persistent and ad-hoc runs diverge | Same named network for disposable and persistent machines |
| Network lifetime | Tied to each VM; no helper to fail | Separate job; needs health check and reconnection research |

`/usr/local/opt/socket_vmnet` is a symlink in owner-writable `/usr/local/opt`.
A root plist must name a root-owned real path, not that symlink.

### Host facts that shape persistence

FileVault is **on** and auto-login is not configured; `pmset sleep 0`. After an
unattended reboot, nothing in the home directory runs until a password is entered
at the console, which also logs in the owner. On this host, then, an owner
LaunchAgent (`gui/506`) loses little against a LaunchDaemon with `UserName`.
The agent stays fully owner-controllable. `fdesetup authrestart` is the planned-reboot
exception to test later. en0 is Wi-Fi `192.168.74.123/24`, gateway `.254`.

### Recommendation from this grounding (not yet decided)

Put root in the network, not in the machine. Keep the invariant "quickchr never runs
QEMU as root." Privileged set-once: one quickchr-labeled LaunchDaemon per named
network (`shared`, `bridged:en0`, …), each running a root-owned socket_vmnet with
explicit mode/interface, its own socket and its own root-owned log. Unprivileged
always: machines attach via `-netdev stream` (any number of NICs). They are persisted
as owner LaunchAgents. This is also the Linux shape: root creates a bridge and an
owner-owned TAP once, then unprivileged QEMU attaches. Keep native vmnet as the
`sudo quickchr start` one-off path and as the comparison arm of the en0 test.
It should not be the daemon model.

Framing the plan: root is a question of **when and who**, not whether. Root is
needed once, at network setup, by the network service. After that, machine
creation, start, stop and persistence are owner operations.

## Bridged en0 lab, 2026-11-07 (sudo, all removed afterwards)

Evidence: `grounding/dev.tikoci.quickchr.lab.net.{bridged-en0,shared}.plist`
(the exact installed bytes) and `grounding/net-bridged-en0.log` (helper log).
Isolated `QUICKCHR_DATA_DIR=/private/tmp/qchr-br`; guest `brlab`, CHR 7.25.1 x86,
NICs `user` plus `bridged:auto`. Homebrew jobs and the user's machines were untouched.

**Network service.** socket_vmnet 1.2.2 installed with `install -o root -g wheel` to
`/opt/quickchr-lab/bin/`, run by
`/Library/LaunchDaemons/dev.tikoci.quickchr.lab.net.bridged-en0.plist`
(`RunAtLoad`, `KeepAlive`, `--vmnet-mode=bridged --vmnet-interface=en0
--socket-group=staff`). The socket was `/var/run/socket_vmnet.bridged.en0`, so
quickchr's existing detection found it unchanged. The socket came up `root:staff 770`
with `bridge100`/`vmenet0`. A second shared-mode daemon
(`--vmnet-gateway=192.168.106.1`, socket `/var/run/quickchr-lab.shared.sock`)
took one `sed` of the first plist.

| Arm | QEMU | Attachment | Result |
|---|---|---|---|
| 1 | uid 506 via `quickchr start` | existing `socket_vmnet_client` wrapper, `bridged:auto`→en0 | ether2 DHCP `192.168.74.179/24` from LAN router `.254` |
| 2 | uid 506, same argv | `-netdev stream,…,reconnect-ms=1000` ×2, **no wrapper** | same lease on ether2; ether3 `192.168.106.2` from the shared daemon; 3 NICs on one VM |
| 3 | root, `-run-with user=amm0` → uid 506 | native `vmnet-bridged,ifname=en0` | same lease; gateway and orca reachable |

Reachability (arms 1 and 2, guest via REST `/ping interface=ether2`): router, two
LAN MikroTik routers, orca, the host, and `1.1.1.1` all 0% loss. Guest MNDP on ether2
listed LAN routers (`scz-bigdude` RB1100Dx4, `KNOT`), so LAN broadcast reaches the
guest. Host→guest ping and `http://192.168.74.179/` returned 200.
**From another LAN device:** orca (Linux, wired, `192.168.74.157`, same subnet)
had ping 0% loss, HTTP 200 and a one-hop traceroute to the guest.

**Wi-Fi bridging rewrites the guest MAC on the LAN.** The Mac's ARP shows the guest at
its own MAC `02:c2:f1:ef:4f:4e`, but orca sees `192.168.74.179` at
`9a:24:88:ff:8a:85`, the Mac's en0 **private Wi-Fi address**. Every guest on a
Wi-Fi bridge shares the host's MAC toward the LAN. IP services work, but this is
not a transparent L2 segment. Expect MAC-based features from LAN peers (MAC-Telnet,
WinBox-by-MAC, per-MAC filtering) to misbehave; these were not tested. A rotation of
the private Wi-Fi address would also change every guest's LAN MAC. For arm 3,
orca's entry was still cached (`REACHABLE`) from arm 2, so a fresh native-vmnet
resolution is unverified. Wired bridging remains a separate test.

**Helper restart without VM restart (arm 2).** SIGKILL of the bridged socket_vmnet:
launchd relaunched it immediately (`runs = 2`), QEMU's `reconnect-ms` re-attached,
and the guest reached the gateway within about 3 s. The helper log shows the
reconnection (three accepts: arm 1, arm 2, post-kill). The wrapper's one-shot
`fd=3` has no reconnect path; that is inferred and was not tested. The restart gave
vmnet a new random interface ID and MAC, so a managed network should pin
`--vmnet-interface-id`.

**`bridged:auto`** resolved to en0 because no Ethernet hardware port exists.
`resolveInterfaceAlias("auto")` prefers any Ethernet port **without checking link
status**, so a present but unplugged adapter would win over working Wi-Fi.

Not tested yet: wired bridge, throughput comparison, Wi-Fi roam or sleep, reboot,
LaunchAgent-supervised machine, t3code itself.

## t3code on bridged en0, 2026-11-07 (left in place)

The user's existing `t3code` machine (CHR 7.25, `/app` app-t3code 0.1.6, 4G data
disk) now has a second NIC on a persistent bridged network. This is a working
setup for current use, **not a shipped quickchr feature**. Every step below was
manual and is a candidate for productizing.

**Installed network service (stays installed).**
`/Library/LaunchDaemons/dev.tikoci.quickchr.net.bridged-en0.plist` (copy in
`grounding/`). It runs `/opt/quickchr/bin/socket_vmnet`, a root:wheel 755 copy
whose sha256 matches the Homebrew Cellar 1.2.2 binary
(`babe3440…e87e763`). Flags: `--vmnet-mode=bridged --vmnet-interface=en0
--vmnet-interface-id=<fixed uuid> --socket-group=staff`. Socket
`/var/run/socket_vmnet.bridged.en0`; log `/var/log/quickchr/net-bridged-en0.log`;
`RunAtLoad` and `KeepAlive`. After `kickstart -k`, the pinned interface ID returned
the same vmnet MAC (`7a:76:b3:bd:56:49`). The Homebrew jobs are untouched.
Remove with `sudo launchctl bootout system/dev.tikoci.quickchr.net.bridged-en0`,
then delete the plist, `/opt/quickchr` and `/var/log/quickchr`.

**Machine change.** There is no `set --add-network` today, so the machine was shut
down and `machine.json` edited directly (backup kept). It appended
`{specifier:{type:"bridged",iface:"en0"}, id:"net1", mac: deriveMac("t3code",1)}`
(`02:69:6c:32:6f:e0`), leaving `net0` and its MAC unchanged. `en0` is pinned rather
than `auto` (see the link-state finding above). `quickchr start` as owner resolved it
through the existing `socket_vmnet_client` wrapper.

**Guest change (RouterOS).** Real-router LAN shape: `bridge-lan` with ether2 as a
port, a DHCP client on the bridge (`default-route-distance=1`), ether1's client
moved to distance 10. Lease `192.168.74.133/24` from the LAN router. The LAN is the
active default route; user mode stays the management path.

**Result.** From orca (another LAN host): ping, `http://192.168.74.133:3773/`
(T3 UI), `/.well-known/t3/environment` (`serverVersion 0.1.6`) and WebFig on :80
all return 200, with no port maps. The original `127.0.0.1:9156` forward also
still works (see the NAT note below). Everything survived a full quickchr
`shutdown`/`start`: the disk name held, `/app` auto-started about 12 s after boot,
the lease and redirects were unchanged.

### Findings from the migration

1. **Adding a NIC renamed the RouterOS data disk.** quickchr emits disks as
   `-drive …,if=virtio`, and QEMU places those after every explicit `-device`.
   `info pci` showed NICs at slots 3 and 4, QGA at 5, and both disks pushed to 6 and 7.
   RouterOS then named the data disk `pcie2` instead of `pcie1`, and left an empty
   `pcie1` entry. The app container failed (`could not create root directory
   /pcie1/apps/...`), and the swap file on `pcie1` failed too. Fixed in the guest:
   remove the empty entry, `/disk/set … slot=pcie1`, `/app/settings/set disk=pcie1`
   (the setting held the removed entry's ID: `failure: unknown disk`). RouterOS kept
   the rename across reboots. **Product fix:** pin disk PCI addresses
   (`-device virtio-blk-pci,drive=…,addr=…`) or emit disks before NICs. As it
   stands, any NIC change on a machine with extra disks can break `/app`/container
   paths.
2. **`/app` NAT follows `/app/settings router-ip`, and the auto value goes stale.**
   Redirects are dynamic dst-nat rules with `dst-address=<router-ip>`.
   `assumed-router-ip` stayed `10.0.2.15` (detected when user mode was the only
   NIC) after adding the LAN, a reboot, and `bridge comment=defconf`. A static
   `/ip/address comment=defconf` marker was not picked either. Clearing it
   (`/app/settings/set !router-ip`) re-ran detection; it returned the LAN IP twice
   and `10.0.2.15` twice, with the LAN default route active in both. The trigger
   and the rule were not identified. A setting of `!router-ip` (not `unset`)
   restores auto. **Working choice:** explicit `router-ip=192.168.74.133` and
   `lan-bridge=bridge-lan`. This depends on the DHCP lease staying put. A
   reservation for guest MAC `02:69:6c:32:6f:e0` on the LAN router would make it
   durable. The lease was keyed on the guest MAC even though the LAN sees the
   host's Wi-Fi MAC; not yet done.
3. **Explicit router-ip breaks the user-mode forward.** Once redirects target the
   LAN IP, quickchr's `hostfwd 9156→3773` lands on `10.0.2.15:3773` and matches
   nothing. One static rule keeps both:
   `chain=dstnat dst-address=10.0.2.15 dst-port=3773 protocol=tcp
   action=dst-nat to-addresses=172.18.0.2 to-ports=3773` (commented
   `quickchr: keep host 127.0.0.1:9156 …`). It hard-codes the app's internal IP,
   so a product version should derive it.
4. **Start an app through `/app`, not `/container`.** `/app` has no `start`
   verb, and `/app/restart` does nothing on a stopped app. `/container/start` runs
   the container, but `/app` still reports `running=false` and installs none of its
   NAT. `/app/disable` + `/app/enable` (with the container stopped) is what brings
   the app up with its rules.

## Plan: two tracks (2026-11-07)

The user separated these, and this document now follows that split.

**Track A — managed networks (active).** The end state is one sudo per network,
run by the network service; machines stay unprivileged.

<!-- specifier-lint: skip — proposed named-network verbs; shared:<name> is not implemented -->

| Verb (sketch) | Privilege | Grounded mechanism |
|---|---|---|
| create `bridged:<iface>` / `shared:<name>` | sudo once | install root-owned helper, write plist with pinned `--vmnet-interface-id`, `launchctl bootstrap system` |
| status | owner | `launchctl print` (readable by the owner) plus connect probe on the socket; today's `pgrep` check is global and weak |
| restart | sudo | `launchctl kickstart -k system/<label>`; running VMs recover with `-netdev stream,reconnect-ms` (wrapper path: no) |
| stop / start | sudo | `launchctl kill TERM` / `kickstart` (the previous lab found `launchctl stop` ineffective) |
| remove | sudo | `bootout`, delete the plist and socket; check for attached machines first |

Machine-side pieces for Track A, smallest first:

- Attach with `-netdev stream` instead of `socket_vmnet_client`, which allows any
  number of networks and reconnection.
- Add `set --add-network` / remove-network that preserve existing NIC MACs.
- Pin disk PCI addresses (finding 1).
- Make `bridged:auto` check link state.
- Fix the `EPERM`-as-dead status bug from the earlier lab before any
  root-adjacent mode.
- Name sockets for quickchr rather than borrowing lima's
  `socket_vmnet.bridged.<iface>` convention. Borrowing it worked here only because
  detection already scans for it.

**Open in Track A: how the helper binary gets installed without Homebrew's
service.** Options, all ending in a root-owned copy outside owner-writable paths:

- Copy from the Homebrew Cellar real path (done here; requires the formula).
- Download the upstream release tarball (`socket_vmnet-1.2.2-x86_64.tar.gz`,
  about 20 KB, published with `SHA256SUMS` and a GPG `.asc`), verify, extract.
- Build from source (small C).

Upgrades re-run the sudo install step. Which source quickchr trusts by default is
undecided.

**Track B — daemonizing machines (separate, later).** Today, start/stop and orphan
handling stay with the user; the machine runs as owner from `quickchr start`.
Persistence (owner LaunchAgent, runner vs direct QEMU, restart policy, reboot)
is researched separately. Track A must not depend on it.

## Working model to investigate

Earlier draft, before the two-track split; Track A above supersedes its network role.

Keep network identity, guest configuration, and service deployment distinct.
A named managed network describes intent (for example bridged LAN through en0),
its owner/access policy, backend, and observed endpoint. The machine persists a
reference to that network plus its existing stable NIC identity. Launchd labels,
socket paths, deployed executable versions, and configuration revisions are
deployment state that can be inspected, not a second authoritative machine registry.

Two service roles may share quickchr-owned code and installation machinery while
remaining separate jobs and privilege domains:

1. A privileged network service manages the approved vmnet attachment and helper.
   It may invoke the existing socket_vmnet binary. Its lifetime need not depend
   on one VM, and stopping one VM must not tear down other consumers' network.
2. An owner-level machine runner stays attached to its QEMU child, reaps it,
   records observed state, and coordinates readiness, stop, and recovery.
   It may attach through socket_vmnet_client. It must not use today's detached
   `start --bg` path as a short-lived launchd KeepAlive command.

This allows managed networks with ordinary disposable VMs, persistent machines
without privileged LAN networking, and persistent machines using managed networks.
The roles need explicit startup/readiness ordering: a registered network job does
not imply a working endpoint, and launchd loading a VM job does not prove that
RouterOS or the app is ready. Network failure should remain distinguishable from
QEMU exit and app failure.

For comparison, retain the direct-QEMU native vmnet approach from the first lab.
It can eliminate the helper job, but moves privileged initialization and control
socket ownership into the machine path. Compare results before choosing. A
quickchr-owned launcher does not itself implement vmnet or remove its privilege
requirements. A custom networking binary is not currently justified.

Stable installed code is required for both roles, with explicit owner/data paths,
versioned deployment and upgrades, and no credentials in plist files. Do not point a
root job at a mutable checkout or transient bunx cache. Preserve the existing
machine locks and a single runtime owner so a CLI start cannot open disks that
launchd already owns. Status, stop/remove, hard reboot for device-mode, and
failure rollback all need to honor that ownership.

## Command sketch for discussion only

<!-- specifier-lint: skip — proposed named-network attachment syntax is not implemented -->

The following text is deliberately not an executable example or supported API:

```text
quickchr networks create lan --mode bridged --interface en0
quickchr networks inspect lan
quickchr set t3code --add-network lan
quickchr service enable t3code
quickchr service status t3code

launchd entry points, illustrative:
quickchr service run --network <identity>
quickchr service run --machine <identity>
```

The create/install/authorize boundary, network reference syntax, command names,
library contract, and persisted schemas are undecided. Adding a NIC to an existing
machine must preserve the original NIC order/MACs and existing disks. The sketch
must not imply that today's `set` accepts these operations.

## Evidence needed before final surfacing

Work through these questions over bounded sessions; this document records the
research sequence, not shipped capabilities or a replacement issue tracker.

1. **Deployment baseline:** attribute the two existing jobs and their failures;
   preserve evidence before any migration. Prove an isolated quickchr-owned
   system service using socket_vmnet, with distinct labels, logs, socket paths,
   ownership, and rollback. Do not disrupt existing consumers merely to tidy up.
2. **Real en0 path:** retain user management as the first NIC initially; attach
   the experimental bridged NIC second and explicitly configure guest addressing.
   Verify DHCP/static addressing, DNS, routing with two NICs, host access, and
   access from another LAN device to the actual T3 service. Distinguish RouterOS
   input access from the app's container/proxy/redirect path. Successful backend
   initialization, TCP accept, or ping alone is insufficient. Pin the interface;
   do not silently substitute NAT when bridging fails.
3. **Network lifetime:** test helper crash/restart, stale sockets, client
   reconnection, Wi-Fi disconnect/reconnect, and sleep/wake. Determine which
   failures recover without restarting QEMU. Try multiple guests, restart order,
   and independent VM cleanup. Record unsupported traffic shapes rather than
   assuming a transparent Ethernet trunk from working IP connectivity.
4. **Machine lifetime:** compare direct-QEMU supervision with an attached
   quickchr runner; test intentional stop versus restart-on-failure, graceful
   shutdown, app persistence, permissions, provisioning recovery, and device-mode
   power cycling. The existing lab did not prove owner console access or
   automatic restart. Confirm no orphan processes or duplicate disk owners.
5. **Host lifetime and deployment:** later schedule logout, real host reboot,
   delayed network/storage availability, and executable/configuration upgrades.
   Host reboot remains a separately scheduled action, not authorized by this
   research note. Record FileVault and unavailable home-directory constraints.
6. **Product contract last:** choose a model from evidence, then define the
   ordinary CLI/library lifecycle, diagnostics, descriptors, safe network
   detach/removal, setup/uninstall, and migration from external services.
   Feed grounded usage into docs and skills after the product owns the setup.

Linux TAP/TUN and host bridges remain on the radar. The reusable concept is a
privileged setup with ordinary owner attachment and explicit resource ownership;
macOS vmnet and Linux networking need their own implementations and validation.
Do not build a cross-platform abstraction before a working Mac model establishes
which boundaries are actually reusable.

## Sources and interpretation

- [socket_vmnet upstream](https://github.com/lima-vm/socket_vmnet): existing
  privileged helper, client integration, and bridged launchd examples. Reuse is
  compatible with replacing Homebrew service lifecycle management.
- [Apple launchd guide](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html):
  supervised jobs must remain attached rather than detaching themselves.
- Local implementation and the linked lab report are the basis for the specific
  quickchr and host findings above. The service roles and command sketch are
  proposals for further experiments, not conclusions established by those sources.
