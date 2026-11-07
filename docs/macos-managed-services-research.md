# Managed macOS networks and persistent machines — research direction

<!-- cspell:ignore mxcl -->

Discussion captured: 2026-11-07. **Research direction, not an accepted service
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

## Working model to investigate

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
