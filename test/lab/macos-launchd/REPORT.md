# macOS launchd supervision experiment — report

Ran live on Morpheus (Intel Mac) 2026-11-06 against commit `32a288b`.
All commands below ran from the `quickchr` checkout at `/Users/amm0/GitHub/quickchr`
unless noted. Guest credentials are redacted throughout; the managed login password
and the sudo secret never appear in this report or its evidence files.

Evidence alongside this report: `installed.plist` (exact bytes installed under
`/Library/LaunchDaemons`), `deployment.json` (exact generator manifest),
`qemu.stderr.log` (exact daemon stderr across four supervised boots).

## Environment

| Fact | Value |
|---|---|
| Host | Morpheus, macOS 26.6.2 (25G83), x86_64, uid 506 (amm0, admin group) |
| Repo commit | `32a288b` on `main` (fast-forwarded from `origin/main`, clean tree) |
| Bun | 1.4.4 |
| QEMU | 11.1.1 (`qemu-system-x86_64` and `qemu-system-aarch64`, Homebrew) |
| CHR | 7.25.1 x86 (pinned to a pre-cached image, no download during the run) |
| centrs | 0.1.9 |
| Acceleration | hvf with `-cpu host` (same-arch Intel host and x86 guest) |
| Data dir | Isolated `QUICKCHR_DATA_DIR=/private/tmp/qchr-lld` (real registry untouched) |
| socket_vmnet | Installed, daemon not running (deliberately unused; native vmnet only) |

Lab guest `launchd-lab-1107a`: x86, 1 vCPU, 512 MB, qcow2 boot disk, port block
9280-9285, NICs `user` (net0, MAC `02:78:69:74:d6:80`) + `vmnet-shared` (net1,
MAC `02:15:87:b7:e2:62`), managed `quickchr` login provisioned on first boot,
default `admin` left enabled with an empty password for fallback access.

## Privilege path used

`sudo` on this host requires a password and offers no persistent timestamp to
non-TTY automation: a timestamp established in one shell was already invalid in
the next. Every privileged call therefore used the T3-managed secret file:

```sh
SUDO_PASS_FILE="<path from T3 request_secret, delivery: file>"
{ cat "$SUDO_PASS_FILE"; echo; } | sudo -S <command>
```

The secret was never printed, never stored in chat, and never written to repo
artifacts. All `sudo` invocations passed explicit environment
(`QUICKCHR_DATA_DIR`, `HOME=/Users/amm0`) so root never fell back to
`/var/root/.local/share/quickchr`.

## What passed

- Unprivileged `vmnet-shared` fails fast at QEMU startup (exact error below);
  root (this QEMU build carries no vmnet entitlement) initializes it fine.
- Privileged first boot + `secureLogin` provisioning completed in 44 s over hvf.
- `generate.ts` produced a reviewed direct-QEMU LaunchDaemon: `plutil -lint` OK,
  `RunAtLoad`/`KeepAlive` off, socket channels, no display, no Bun in the plist.
- launchd supervised QEMU directly (parent PID 1, euid 0, one job, one process).
- Management endpoint stayed stable across four supervised boots plus one
  privilege-drop boot: REST/SSH on 9280/9282, ether1 `10.0.2.15/24`,
  ether2 `192.168.2.12/24` (same DHCP lease every boot).
- Bidirectional vmnet path verified: host to guest, guest to gateway, guest to
  `1.1.1.1` through NAT.
- Guest reboot kept the same QEMU PID; guest shutdown exited QEMU 0 with no
  relaunch; `SIGKILL` exited without relaunch and the next kickstart recovered
  despite stale sockets.
- Privilege drop (`-run-with user=amm0`) kept vmnet working with QEMU at euid 506.
- Owner access to root-created monitor/serial sockets is denied (`EACCES`);
  privileged access works.
- Cleanup verified: job bootout, plist removed, no QEMU, no jobs, no sockets,
  ownership restored, guest removed through quickchr, host `known_hosts` tidy.

## Preconditions established

QEMU has only the hypervisor entitlement, so native vmnet needs root:

```console
$ codesign -d --entitlements - /usr/local/bin/qemu-system-x86_64
Executable=/usr/local/Cellar/qemu/11.1.1/bin/qemu-system-x86_64
[Dict]
        [Key] com.apple.security.hypervisor
```

Unprivileged init fails immediately, before any guest is involved:

```console
$ qemu-system-x86_64 -M pc -m 128 -display none \
    -netdev vmnet-shared,id=net0 -device virtio-net-pci,netdev=net0 \
    -serial none -monitor none
qemu-system-x86_64: -netdev vmnet-shared,id=net0: cannot create vmnet interface:
  general failure (possibly not enough privileges)
exit=1
```

Interface survey for a later bridged variant: only `en0` (Wi-Fi, active) is up;
`en1`-`en4` (Thunderbolt) are all `status: inactive`. No wired interface exists,
so no guest was ever attached to a bridged network (see Bridged below).

## Provisioning (privileged, audited)

Created unprivileged with the final topology (no NIC changes afterwards):

```sh
export QUICKCHR_DATA_DIR=/private/tmp/qchr-lld
bun src/cli/index.ts add --name launchd-lab-1107a --arch x86 --version 7.25.1 \
  --add-network user --add-network vmnet-shared --secure-login --port-base 9280
```

Note: `add --help` lists only `user, shared, bridged:<if>, socket::<name>,
tap:<if>`, but the CLI parses through `parseNetworkSpecifier`, so `vmnet-shared`
and `vmnet-bridged:<iface>` are accepted. The help text is the only gap.

First boot ran privileged with explicit owner paths (wall time 44.3 s):

```sh
{ cat "$SUDO_PASS_FILE"; echo; } \
  | sudo -S QUICKCHR_DATA_DIR=/private/tmp/qchr-lld HOME=/Users/amm0 \
    /usr/local/bin/bun src/cli/index.ts start launchd-lab-1107a
```

Resulting ownership in the machine dir:

| Path | Owner | Note |
|---|---|---|
| `boot.qcow2`, `machine.json`, `.lock` | amm0 | Pre-created or truncated in place |
| `monitor.sock`, `serial.sock`, `qga.sock` | root | Created by root QEMU |
| `qemu.log`, `qemu.pid` | root | Created by privileged spawn |
| `ssh/` | root | Managed keypair written as root |

`machine.json` stayed owner-owned because quickchr truncates it in place, but
every new file the privileged run created is root-owned. A second artifact of
running as root: the managed password went to the root credential store via
`Bun.secrets`, unreadable to the owner. All RouterOS operations in this report
therefore used the leftover `admin` account with an empty password over explicit
`--host 127.0.0.1 --port 9280` centrs targeting (REST accepts it; the expired
flag does not block REST).

## Status falsification finding (no fix applied)

While the first QEMU (PID 43569, root) was running and REST answered 200, an
unprivileged `quickchr list` displayed the machine as stopped — and rewrote
`machine.json` to `status: "stopped"` with the PID cleared. After that,
unprivileged `stop` printed success and `shutdown` printed `already stopped`
while QEMU kept running:

```console
$ bun src/cli/index.ts stop launchd-lab-1107a
○ launchd-lab-1107a stopped
$ bun src/cli/index.ts shutdown launchd-lab-1107a
launchd-lab-1107a: already stopped
$ pgrep -f 'qemu-system.*launchd-lab' | wc -l
       1
```

Root cause in repo code: `isMachineRunning()` (`src/lib/state.ts`) treats every
`kill(pid, 0)` error as "not running", including `EPERM` (alive but foreign),
and `refreshAllStatuses()` persists that verdict over the stored record. The
codebase already knows better in two other places: `isPidAlive()`
(`src/lib/storage-lease.ts`) and the trash prune (`src/lib/state.ts`) both
treat `EPERM` as alive. Service mode must do the same, and must never persist
`stopped` over an `EPERM` PID: a no-op that reports success invites a second
QEMU onto the same disk. Left as a finding; no production change made here.

## Guest networking (centrs: explain, execute --yes, read back)

`centrs explain '/ip/dhcp-client/add interface=ether2 disabled=no'` passed
offline. `execute` without `--via` defaulted to `native-api` against the REST
port and failed (`transport/connection-closed`), so all calls below pin
`--via rest-api`. The write needed `--yes`; reads needed no flag:

```sh
centrs execute --host 127.0.0.1 --port 9280 --username admin --password '' \
  --via rest-api --yes '/ip/dhcp-client/add interface=ether2 disabled=no'
centrs retrieve --host 127.0.0.1 --port 9280 --username admin --password '' \
  --via rest-api /ip/dhcp-client --json
```

Read-back: ether2 bound `192.168.2.12/24`, gateway and DNS `192.168.2.1`
(vmnet-shared subnet on this host is `192.168.2.0/24`, not the `192.168.64/24`
seen in older notes). Both DHCP clients keep `add-default-route=yes` at
distance 1, i.e. ECMP across ether1 and ether2; the localhost management path
is unaffected, so this was left as configured.

Reachability, all passing:

- Host to guest: `ping 192.168.2.12` 4/4 via `bridge100`, ARP MAC equals the
  persisted ether2 MAC.
- Guest to gateway: `/ping address=192.168.2.1 count=3` 3/3 at about 1.1 ms.
- Guest to internet: `/ping address=1.1.1.1 count=2` 2/2 through vmnet NAT.

## Generated daemon (reviewed before install)

```sh
bun test/lab/macos-launchd/generate.ts launchd-lab-1107a /private/tmp/qchr-lld-out1
```

Output label `dev.tikoci.quickchr.lab.db7b9287-bd8a-46ee-8d8b-30f903e44ed6`
(`deployment.json` and the installed plist are preserved beside this report).
Review notes:

- `ProgramArguments` is the exact argv quickchr built for the privileged boot:
  absolute QEMU path, `-M pc`, hvf, persisted MACs, `-display none`, socket
  monitor/serial/QGA with `server=on,wait=off`. No `-daemonize`, no Bun.
- `RunAtLoad` false, `KeepAlive` false, `WorkingDirectory` the machine dir,
  `ExitTimeOut` 30, `Umask` 63.
- Stdout/stderr go to the 0700 owner-only output dir; root writes there fine
  and the logs land root-owned 600.
- The manifest records paths and argv and excludes guest credentials.

Install boundary recorded, not fixed (lab-accepted): the QEMU executable chain
is owner-writable (`amm0:admin` on both the `/usr/local/bin` symlink and the
Cellar target), so a root daemon executing it trusts owner-writable bytes.
Production service mode needs a root-owned, upgrade-pinned executable chain.

Installed and bootstrapped (job stays down until kickstart):

```sh
Plist=/Library/LaunchDaemons/$LABEL.plist
{ cat "$SUDO_PASS_FILE"; echo; } | sudo -S sh -c \
  "cp '/private/tmp/qchr-lld-out1/$LABEL.plist' '$Plist' \
   && chown root:wheel '$Plist' && chmod 644 '$Plist'"
{ cat "$SUDO_PASS_FILE"; echo; } | sudo -S launchctl bootstrap system "$Plist"
# print: state = not running, active count = 0, zero QEMU processes
```

## Lifecycle matrix under launchd

Every kickstart below is `{ cat "$SUDO_PASS_FILE"; echo; } | sudo -S launchctl
kickstart system/$LABEL`. Timings are wall clock on Morpheus (hvf, warm cache).

| # | Action | Observed |
|---|---|---|
| 1 | kickstart | Job `running`, PID 44230, parent PID 1, euid 0; exactly 1 job, 1 QEMU |
| 1 | REST wait | 200 after about 40 s; sockets mode 700, root-owned |
| 1 | Guest state | Same `10.0.2.15`/`192.168.2.12`, identity `CHR`, users `admin`+`quickchr` |
| 2 | `launchctl stop` | Exit 3, no output, QEMU kept running (interface quirk, see below) |
| 2 | `launchctl kill TERM` | QEMU exited 0 within 4 s; stderr logs `terminating on signal 15 from pid 1` |
| 3 | kickstart after SIGTERM | REST 200 after about 10-15 s; same addresses; guest log has no errors |
| 4 | Guest `/system/reboot` | Same QEMU PID throughout; REST gap about 5-10 s; uptime 24 s proves reboot |
| 5 | Guest `/system/shutdown` | QEMU exit 0 within 10 s; still zero QEMU after 20 s (no relaunch) |
| 6 | kickstart, then `kill -9` QEMU | No relaunch after 20 s; stale root sockets remain on disk |
| 7 | kickstart after SIGKILL | QEMU runs immediately: QEMU 11.1.1 rebinds stale socket paths itself |
| 7 | Recovery check | REST 200 after about 10 s; same addresses; SSH `admin` works (uptime 22 s) |
| 8 | Guest `/system/shutdown` | QEMU exit 0 within 10 s; sockets removed by clean QEMU exit |

Notes:

- `launchctl stop system/$LABEL` exiting 3 with no effect is an observed
  launchctl behavior on macOS 26.6.2 for this job shape, not a typo: the same
  call shape worked for `kickstart`, `kill`, `bootout`, and `print`.
  `launchctl kill TERM` is the reliable SIGTERM path; QEMU exits 0 on it.
- SIGTERM is a power cut from the guest's view (host block layer flushed, no
  guest shutdown requested). The guest came back healthy, but a clean-shutdown
  promise needs the REST-then-wait sequence, not a bare signal.
- Quickchr's own `stop`/`shutdown`/`start`/`clean`/`remove` were never run
  while launchd owned the disk, per the experiment bounds (and the status
  finding above shows why `start` then would be dangerous).
- `quickchr list` on the isolated registry reported the machine `stopped`
  through the whole supervised phase, which was only intermittently true.

## Channel permissions

| Caller | Monitor | Serial |
|---|---|---|
| Owner (amm0) | `Permission denied` (socat `E connect ... Permission denied`) | Same `EACCES` |
| Root | `(qemu)`, `VM status: running` | Connects; guest echoes `CR` (`\r\n` read back) |

Root cause of the owner denial is plain permission bits, isolated with a
control probe: the owner connects fine to a root-owned 777 socket in the same
directory, so path and mount are innocent. Root QEMU with umask 022 creates
mode-755 sockets, and with the plist's umask 63 mode-700 sockets; either way
group and other lack the write bit `connect()` needs, and amm0 is in neither
the owning user nor (observed here) the `wheel` group. Any service mode that
wants owner-readable consoles must set socket ownership or mode explicitly;
supervision alone does not grant it.

Also recorded from daemon stderr (see `qemu.stderr.log`): every boot logs
`-mon chardev=monitor0,mode=readline: warning: '-mon' is deprecated, use
'-object' ... instead`. That warning is quickchr-wide on QEMU 11, not
lab-specific.

## Privilege-drop variant (separate run, job unloaded-idle)

With the guest shut down and the job at `not running`, the deployed argv ran
once directly under sudo with `-run-with user=amm0` prepended:

```console
$ ps -o pid,uid,user,command -p 45354
  PID   UID USER COMMAND
45354   506 amm0 /usr/local/bin/qemu-system-x86_64 -run-with user=amm0 -M pc ...
```

- vmnet initialized as root, then the drop landed on euid 506 (amm0).
- Networking fully worked post-drop: same `192.168.2.12`, host ping 3/3,
  REST/SSH unchanged. Guest shutdown exited QEMU 0.
- Sockets were created pre-drop as root 755, so the owner hit the same
  `EACCES` as before despite the process now running as amm0 (root monitor
  still answered `VM status: running`). A production drop design must create
  or re-own the sockets after the drop, not just drop the process.
- Guest reboot under the dropped process was not separately exercised: reboot
  keeps the same process, so no vmnet re-init is involved.

## Bridged: interface identified, guest attach deferred

No guest was attached to a bridged network: only Wi-Fi `en0` is active and
`en1`-`en4` are all down, so no suitable wired interface exists on Morpheus
right now. A raw privileged probe (no disk, no guest state) showed
`vmnet-bridged,ifname=en0` initializes without error — QEMU sat in SeaBIOS
until terminated — but init success says nothing about Wi-Fi frame delivery,
so guest DHCP and LAN delivery over en0 remain untested. The decision to defer
to a wired interface was an experiment scope choice, not proof that Wi-Fi vmnet
bridging cannot support this workload. The next research direction explicitly
includes a guest-level en0 test.

The probe also demonstrated the orphan rule: terminating the supervising shell
left the root QEMU alive at 160% CPU until an explicit privileged `kill`.
Every lifecycle step above therefore re-counts processes instead of assuming a
kill cascaded.

## Same-host project handoff

A project running on Morpheus itself can use the supervised guest's
`http://127.0.0.1:9280/rest` and `ssh -p 9282` endpoints directly across
restarts: ports, addresses, users, and DHCP leases were all stable. A
read-only peek at `/Users/amm0/GitHub/app-t3code` (not modified) found no
existing RouterOS endpoint convention to align with. The T3 environment link
to Morpheus remains control-only: a project on another machine cannot use
these localhost endpoints without an explicit transport.

## Cleanup proof

```console
$ sudo launchctl bootout system/$LABEL          # exit 0
$ sudo rm /Library/LaunchDaemons/$LABEL.plist   # exit 0
$ ls /Library/LaunchDaemons | grep tikoci
NO-TIKOCI-DAEMONS
$ sudo launchctl print system/$LABEL
Could not find service "..." in domain for system
$ ps aux | grep qemu-system | grep -v grep
FINAL-QEMU: none
$ sudo launchctl list | grep -iE 'tikoci|quickchr|launchd-lab'
SWEEP-JOBS: none
$ sudo chown -R amm0:staff /private/tmp/qchr-lld /private/tmp/qchr-lld-out1
$ QUICKCHR_DATA_DIR=/private/tmp/qchr-lld bun src/cli/index.ts remove launchd-lab-1107a
launchd-lab-1107a removed.
$ ssh-keygen -R '[127.0.0.1]:9282'              # lab SSH probe entry removed
$ rm -rf /private/tmp/qchr-lld /private/tmp/qchr-lld-out1
TMP-CLEAN
```

The three pre-existing user machines (`um-repro`, `t3code`, `muse-stats`) were
listed before and after: all still present and stopped, on their original
ports. No host reboot, no permanent service, no UTM or config-sync work.

## Next research direction

The 2026-11-07 discussion prioritizes quickchr-owned service management, potentially
reusing socket_vmnet, and guest-level en0 bridging before final product surfacing.
See [the research direction](../../../docs/macos-managed-services-research.md).
This report preserves the original direct-QEMU experiment and its limits.

## Limitations and follow-ups

1. `isMachineRunning()`/`refreshAllStatuses()` falsify state across the
   privilege boundary (`EPERM` read as dead, then persisted). Service mode is
   unsound until `EPERM` means "alive but foreign" and is never persisted as
   `stopped`. The `isPidAlive()` precedent already exists in-repo.
2. The root daemon executed an owner-writable QEMU chain. Production needs
   root-owned, upgrade-pinned binaries and firmware with validated updates.
3. Root-created sockets/keys/logs need an ownership story (drop-then-create,
   explicit `chown`, or group mode); owner consoles do not work by default.
4. `launchctl stop` exiting 3 on this job shape needs a documentation note in
   any runbook that names stop/start verbs; `kill TERM` + `kickstart` worked.
5. Provisioning as root split the credential store (root keychain) and left
   root-owned `ssh/` and logs; the owner-readable path used `admin`/empty.
6. Not tested: host reboot and start-at-boot (explicitly deferred to a later
   scheduled step), bridged-with-guest (no wired interface), logout behavior,
   FileVault-locked home data dirs, automatic restart policy (deliberately
   off), and device-mode hard reboot through launchd.
7. `generate.ts` needed no code changes: its guards (macOS-only, owner-only,
   `launchd-lab-` prefix, stopped+provisioned, x86 one disk, no custom argv,
   user+explicit-vmnet) all held, and its output passed review and `plutil`.

## Repro appendix (sanitized)

```sh
export QUICKCHR_DATA_DIR=/private/tmp/qchr-lld   # isolated, short
SUDO_PASS_FILE="<T3 request_secret file>"
SUDO="sudo -S"

mkdir -p "$QUICKCHR_DATA_DIR/cache"
cp ~/.local/share/quickchr/cache/chr-7.25.1.img "$QUICKCHR_DATA_DIR/cache/"

bun src/cli/index.ts add --name launchd-lab-1107a --arch x86 --version 7.25.1 \
  --add-network user --add-network vmnet-shared --secure-login --port-base 9280

{ cat "$SUDO_PASS_FILE"; echo; } | $SUDO \
  QUICKCHR_DATA_DIR=$QUICKCHR_DATA_DIR HOME=/Users/amm0 \
  /usr/local/bin/bun src/cli/index.ts start launchd-lab-1107a

centrs explain '/ip/dhcp-client/add interface=ether2 disabled=no'
centrs execute --host 127.0.0.1 --port 9280 --username admin --password '' \
  --via rest-api --yes '/ip/dhcp-client/add interface=ether2 disabled=no'
centrs retrieve --host 127.0.0.1 --port 9280 --username admin --password '' \
  --via rest-api /ip/dhcp-client --json
centrs execute --host 127.0.0.1 --port 9280 --username admin --password '' \
  --via rest-api --yes '/system/shutdown'

bun test/lab/macos-launchd/generate.ts launchd-lab-1107a /private/tmp/qchr-lld-out1
plutil -lint /private/tmp/qchr-lld-out1/*.plist
# review plist + deployment.json, then install / bootstrap / kickstart
# ... lifecycle matrix above ...
# ... bootout, sweep, chown, quickchr remove, rm -rf lab dirs ...
```
