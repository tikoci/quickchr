# macOS launchd service research

Research date: 2026-11-06. Options and feasibility research; no production service
mode is implemented and no permanent service remains installed. Initially reviewed
on Linux against repository code and primary upstream sources. Validation: the
bounded experiment
in `test/lab/macos-launchd/README.md` ran live on Morpheus 2026-11-06; results
and limits are in `test/lab/macos-launchd/REPORT.md`. Host reboot, start-at-boot,
and bridged-with-guest validation remain pending.

For the next research direction and the 2026-11-07 discussion, see
[managed macOS networks and persistent machines](macos-managed-services-research.md).
That direction favors quickchr-owned service setup, potentially reusing the
socket_vmnet binary. The direct-QEMU experiment below remains comparison evidence.

## Assessment

The initial assessment favored a launchd-managed quickchr machine for persistent,
headless RouterOS use than synchronizing quickchr and UTM configurations. Quickchr keeps
one authoritative machine configuration, disk inventory, MAC addresses, and
management interface. Launchd becomes the process supervisor, not another VM
configuration editor. The plist is generated deployment state.

Direct macOS networking already exists in quickchr: `vmnet-shared` and
`vmnet-bridged:<iface>` resolve to native QEMU netdevs in `src/lib/network.ts`.
They do not require socket_vmnet. Ordinary QEMU without the networking entitlement needs root
to initialize this networking. Launchd provides an appropriate system service
context; it does not itself grant vmnet permission to an unprivileged process.

This is separate from UTM integration. The native network backends can also run
without launchd if QEMU is started with sufficient privileges. Supervision,
start-at-boot policy, and privileges are independent choices that happen to work
well together here.

## Evidence

- [Apple's launchd guide](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html):
  system jobs in `/Library/LaunchDaemons`, job lifetime, shutdown signals, and
  the requirement that supervised processes not daemonize themselves.
- [Apple's daemon/agent distinction](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/DesigningDaemons.html):
  system daemons survive logout and do not have a GUI session.
- [Apple's published launchd.plist manual source](https://github.com/apple-oss-distributions/launchd/blob/main/man/launchd.plist.5):
  `ProgramArguments`, `RunAtLoad`, `KeepAlive`, `ExitTimeOut`, paths and environment.
  This is historical source; verify exact keys and launchctl behavior against
  the target Mac's installed manuals before implementation.
- [socket_vmnet's own explanation](https://github.com/lima-vm/socket_vmnet#how-is-socket_vmnet-related-to-qemu-builtin-vmnet-support):
  native QEMU vmnet versus a privileged networking helper.
- [QEMU process options](https://www.qemu.org/docs/master/system/invocation.html):
  `-run-with user=...` supports dropping privileges before guest execution.
- [QEMU POSIX privilege setup](https://github.com/qemu/qemu/blob/master/os-posix.c)
  and [initialization](https://github.com/qemu/qemu/blob/master/system/vl.c):
  source suggests network initialization precedes the final privilege drop.
  These moving upstream sources establish an experiment, not tested compatibility
  with a particular macOS QEMU build.
- Local implementation: `src/lib/qemu.ts` (`spawnQemu`, channels, stop),
  `src/lib/network.ts` (native vmnet resolution), `src/lib/state.ts` (PID status),
  and `src/lib/quickchr.ts` (readiness, provisioning, rollback, hard reboot).

## A practical first shape

Represent supervision separately from guest configuration. The existing direct
process mode remains the default for test machines; a macOS service mode records
a stable launchd label, service domain, installation metadata, and the config
revision actually deployed. Exact schema and command names remain undecided.

Generate an absolute executable path and argument array from the same launch
builder used today. Store no RouterOS credentials in the plist. Preserve the
existing no-display serial/monitor setup and stable NIC identities.

For the first experiment let launchd supervise QEMU **directly**, running in the
foreground from launchd's perspective but using quickchr's background socket
channels. These are currently coupled through the `background` flag and need
separating. Do not run today's `quickchr start --bg`/detached spawning path as a
KeepAlive job: the parent exits while QEMU remains, defeating supervision.
Do not add QEMU `-daemonize` either.

A long-lived quickchr supervisor is an alternative if runtime reconciliation is
needed at boot. It must stay alive, own and reap the QEMU child, forward shutdown,
and avoid detached children. That adds a privileged Bun/TypeScript runtime and
deployment concerns; it should earn its place through a demonstrated need.

The normal unprivileged CLI can bootstrap/kickstart the installed service through
an authorized system operation, wait for guest readiness, and apply provisioning.
Booting at host startup should restart an already-prepared disk without needing
the user's CLI, shell environment, secret-store access, or an npm cache.

## Preserve the management path initially

Use the existing user-mode NIC as ether1 for management and add direct vmnet
NICs for the desired network traffic:

```text
ether1: user-mode management, existing localhost forwards
ether2: vmnet-shared or vmnet-bridged:<interface>
```

This retains REST/SSH readiness, package upload, and current connection
descriptors. Today quickchr explicitly requires a user-mode interface for
provisioning; RouterOS's factory DHCP client is on ether1. A shared or bridged
ether2 needs explicit guest configuration. Merely attaching the NIC does not
enable DHCP there, create a router policy, or make every service available on it.

Direct vmnet-only operation is possible as a later capability, but requires
guest address discovery/static addressing, direct connection descriptors, and
readiness/provisioning changes. It should not be hidden inside the daemon work.
Likewise, shared networking is host NAT; bridged networking provides LAN
attachment. Neither is a promise of arbitrary VLAN trunking, DHCP-server
behavior, or identical support across Wi-Fi and Ethernet. Test the requested
RouterOS traffic shapes on real hardware.

Service mode should explicitly select native vmnet, rather than the generic
`shared`/`bridged` resolution that currently prefers an installed socket_vmnet.
This avoids making daemon behavior depend on an optional helper's presence.

## Start, stop, reboot, and recovery

- Distinguish installed, loaded, desired-running, QEMU-running, and guest-ready.
  Launchd can have a job registered with no live process. Keep the PID as
  observed data, not the sole status authority; an unprivileged `kill(pid, 0)`
  can fail with a permission error for a live root-owned QEMU.
- Normal `start` dispatches to launchd for service machines. Never also spawn a
  detached QEMU against the same disks. Normal `list`, logs, and inspect should
  keep working and identify supervision without inventing a second VM registry.
- Normal `stop` first prevents relaunch, then requests a graceful guest shutdown
  and waits. Unload with `bootout` after exit, with a bounded forced termination
  fallback. Bootout alone must not be described as a graceful RouterOS shutdown.
  A temporary stop and disabling start-at-boot need distinct persisted meanings.
- Begin the experiment without automatic restart. Add a deliberate crash-restart
  policy only after proving intentional stop and guest-initiated shutdown behavior.
  Unconditional `KeepAlive` can turn a requested shutdown into an immediate boot.
- `clean`, `remove`, disk resize, and cold configuration edits must quiesce/unload
  the job before touching disks. Removing a machine must remove its service too;
  disabling service mode must leave the disks intact. Both directions need a
  known rollback if installing/updating a plist fails partway through.
- Guest reboot can keep QEMU alive. Device-mode's host power cycle is different:
  `hardRebootMachine()` currently quits/kills QEMU and calls `spawnQemu()` directly.
  It needs service-aware dispatch, as do failure recovery and provisioning rollback.
- The plist is a deployed configuration snapshot. CPU/memory/network edits become
  active on an explicit restart after regenerating/reloading it. If installed
  revision differs from `machine.json`, show pending changes; never silently boot
  an old plist while claiming to use the newly edited config.
- At host shutdown launchd sends termination signals. To promise clean RouterOS
  shutdown, test the actual signal path; a supervisor may be required to translate
  termination into a guest shutdown request and wait within the exit budget.

## Privilege and storage are actual implementation boundaries

The simplest direct-vmnet prototype runs QEMU as root. A system LaunchDaemon
with `UserName` set to the ordinary owner would not gain vmnet access merely
because launchd started it. Root initialization followed by QEMU's documented
privilege drop is worth a focused experiment: verify vmnet remains functional,
reboot works, and post-drop socket/file permissions support quickchr. Do not
promise this optimization before a live Mac test.

Privileged deployment cannot point at a transient `bunx` installation, mutable
TypeScript checkout, or unchecked user-editable argv. Arbitrary root QEMU argv
can access host files or launch helpers. An implementation must choose between
an explicitly admin-managed service or a narrowly authorized helper with a
validated configuration format. Sudo at install time does not automatically
authorize arbitrary later root config changes or unprivileged launchctl control.

The installed plist and privileged executable chain need controlled ownership
and stable paths. Homebrew upgrades can change binaries and firmware; record
and validate deployed paths rather than relying on the login shell's PATH.
Config edits that change privileged arguments need a reviewed update path.

Do not run the whole quickchr CLI as root and accidentally switch to root's
machine registry. Keep an explicit owner and data location. Determine permissions
for disks, logs, Unix monitor/serial/QGA sockets, and state updates; root-created
files must remain usable by that owner. Privileged control sockets also need
an access boundary because they can control QEMU.

A true start-at-boot service should use service-accessible storage, with a clear
plan for existing user-directory machines. FileVault unlock, unavailable home
directories/external volumes, and startup interface availability can delay launch.
No service can make the guest run while its host is sleeping or powered off.
Readiness is not guaranteed just because launchd accepted the job.

## Operations to retain or gate

Retain ordinary quickchr REST/SSH operations, serial console, and descriptors
when the management path is ready. Snapshot and QGA operations can remain if
their existing channel and disk requirements still hold. Do not disable them
solely because supervision changed.

Gate foreground launch/stdio console assumptions, direct PID termination,
destructive disk operations, and host power cycles until they dispatch correctly.
Boot-time provisioning and external test socket links need explicit contracts:
an always-on guest cannot assume a test harness listener is present at reboot.

## Bounded Mac experiment

1. Prepare a disposable guest using existing quickchr provisioning, then stop it.
2. Generate a service plist for direct, attached QEMU with the existing management
   NIC and one native vmnet NIC. Validate with `plutil`; install only in the test.
3. Verify shared NAT, host reachability, bridged LAN reachability, serial access,
   REST/SSH, stable MACs, and owner access to files and control sockets.
4. Verify two VMs share the intended network, with no duplicate MACs or stale
   interfaces. Repeat bridging over the actual supported host interfaces.
5. Test root initialization plus privilege drop as a separate variant.
6. Exercise ordinary start/stop repeatedly, crash, guest shutdown, guest reboot,
   host power cycle, service disable/uninstall, and disk cleanup. Count processes
   and remaining jobs so a passing API response cannot hide an orphan.
7. Test config revision changes, provisioning failure rollback, and device-mode
   hard reboot through launchd. Restart policy comes after these pass.
8. Verify logout and a real host reboot/start-at-boot cycle, including permissions,
   absolute binary/firmware paths, unavailable networks, and clean shutdown.

Successful results would justify a macOS-only service supervision feature with
quickchr-owned configuration. UTM-native creation and centrs provisioning can
remain separate, lower-priority proposals.
