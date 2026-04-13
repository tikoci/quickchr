# quickchr Networking — Platform Reference

> **Status:** Reference document for QEMU networking internals across platforms.
> Design decisions and implementation checklist live in [BACKLOG.md](../BACKLOG.md) § P5 — Networking.
> This document covers *how things work under the hood* — what QEMU does, how each
> platform's networking stack operates, and what quickchr's resolution engine maps to.

---

## The Core Problem

Bridged and shared virtual networking (vmnet on macOS, TAP/bridge on Linux) requires elevated privileges because it touches the kernel's network stack. The naive approach — `sudo quickchr start` — is a non-starter for most workflows: it's annoying, it runs the entire QEMU process as root (security risk), and it breaks scripts, CI pipelines, and tooling that doesn't expect a privileged program.

The better model: **privilege once, run many times.** Create the network resource with `sudo` once, persist it, and let unprivileged QEMU processes attach to it on every subsequent start. This is exactly how Lima, Rancher Desktop, and similar tools handle it on each platform.

---

## Rootless Networking (Always Available)

These modes work without any elevation and need no special setup. They are the **default** for quickchr and cover most development, testing, and API workflows.

### User-mode / SLIRP (`user`)

QEMU implements a full TCP/IP stack in userspace (originally called SLIRP). The guest gets a private `10.0.2.x` IP. Port forwarding (`hostfwd`) makes individual guest ports reachable on the host loopback.

```sh
-netdev user,id=net0,hostfwd=tcp::9180-:80,hostfwd=tcp::9122-:22
-device virtio-net-pci,netdev=net0
```

**Traits:** No root, no install, works everywhere including CI. Limitations: no ICMP (ping doesn't work), guest is not directly reachable from the LAN, inter-VM L2 connectivity requires additional tricks.

**When to use:** Default for everything. REST API, SSH, WinBox, API — all work via hostfwd. Sufficient for 95% of use cases.

### QEMU Socket Networking (`socket`)

QEMU can connect two (or more) VM instances at L2 via TCP or UDP sockets on the loopback interface. No root, no install. This is the **rootless multi-VM** path.

```sh
# VM A (listen side — must start first)
-netdev socket,id=net1,listen=:4001
-device virtio-net-pci,netdev=net1

# VM B (connect side)
-netdev socket,id=net1,connect=127.0.0.1:4001
-device virtio-net-pci,netdev=net1
```

Multicast variant (any number of VMs, no listen/connect asymmetry):

```sh
-netdev socket,id=net1,mcast=230.0.0.1:4001
-device virtio-net-pci,netdev=net1
```

**Traits:** Pure L2 between VMs, no host-side interface, completely rootless, CI-friendly. No DHCP (RouterOS must use static IPs or you run a DHCP server on one VM). Each pair of VMs needs a unique port or mcast group.

**quickchr today:** `socket::<name>` specifier uses a port registry in `~/.local/share/quickchr/networks/<name>.json` to auto-assign and track ports. Named sockets avoid the listen/connect ordering problem.

---

## Privileged Networking — The "Sudo Once" Pattern

The key insight across all platforms is that the privileged resource (vmnet file descriptor, kernel TAP device) can be created and held by a **persistent daemon or pre-created device**, and QEMU just attaches to it without needing root.

| Platform | Privileged resource | Held by | QEMU attachment | Root for QEMU? |
|---|---|---|---|---|
| macOS | vmnet.framework fd | `socket_vmnet` daemon | Unix socket fd passthrough | **No** |
| Linux | TAP device (user-owned) | kernel (persistent) | `-netdev tap,ifname=tap0,script=no` | **No** |
| Linux | Bridge (qemu-bridge-helper) | kernel + setuid helper | `-netdev bridge,br=br0` | **No** |
| Windows | TAP-Windows adapter | kernel driver (installed) | `-netdev tap,ifname=...` | **No** |
| macOS (fallback) | vmnet.framework (built-in QEMU) | QEMU process itself | `-netdev vmnet-shared` | **Yes** — entire QEMU as root |

The fallback (bottom row) is what quickchr does today with `vmnet-shared`. It works but requires `sudo quickchr start`, which is the problem being solved.

---

## macOS — `socket_vmnet`

### What It Is

[`socket_vmnet`](https://github.com/lima-vm/socket_vmnet) is a small C daemon (from the Lima project) that holds a `vmnet.framework` file descriptor and exposes it to unprivileged programs via a Unix domain socket. QEMU gets the fd passed to it at startup without ever needing to open vmnet itself.

Used by: Lima, Rancher Desktop, Podman Desktop — all the serious macOS VM tools.

### Why vmnet Requires Root

Apple's `vmnet.framework` requires the `com.apple.vm.networking` entitlement, which Apple only grants to virtualization vendors by contract. The workaround — signing `socket_vmnet` with that entitlement — is also vendor-gated. So `socket_vmnet` runs as root, but QEMU doesn't have to.

QEMU 7.1 added built-in `vmnet` support (`-netdev vmnet-shared`, `-netdev vmnet-bridged`), but this requires the **entire QEMU process** to run as root. `socket_vmnet` splits the privilege: daemon is root, QEMU isn't.

### Modes

| Mode | `socket_vmnet` flag | Guest connectivity |
|---|---|---|
| Shared (NAT) | `--vmnet-mode=shared` (default) | Internet via host NAT; guest has real-ish IP from macOS DHCP |
| Host-only | `--vmnet-mode=host` | Host ↔ guest only; no internet |
| Bridged | `--vmnet-mode=bridged --vmnet-interface=en0` | Real LAN presence; LAN DHCP assigns IP |

### Install (Homebrew)

```sh
# Install (keg-only — intentionally not in PATH)
brew install socket_vmnet

# Start as launchd system service (auto-restarts on reboot)
sudo brew services start socket_vmnet
# For bridged on en0:
BRIDGED=en0
sed -e "s@/opt@$(brew --prefix)/opt@g; s@/var@$(brew --prefix)/var@g; s@en0@${BRIDGED}@g" \
  "$(brew --prefix)/opt/socket_vmnet/share/socket_vmnet/launchd/io.github.lima-vm.socket_vmnet.bridged.en0.plist" \
  | sudo tee /Library/LaunchDaemons/io.github.lima-vm.socket_vmnet.bridged.${BRIDGED}.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/io.github.lima-vm.socket_vmnet.bridged.${BRIDGED}.plist
```

Sockets created:
- Shared: `$(brew --prefix)/var/run/socket_vmnet`
- Bridged: `$(brew --prefix)/var/run/socket_vmnet.bridged.en0`

### How QEMU Attaches (No Root)

`socket_vmnet` provides `socket_vmnet_client`, a small wrapper that connects to the daemon socket and passes the resulting file descriptor (as fd 3) to the QEMU subprocess. QEMU is then launched as a child process of `socket_vmnet_client`, not as root.

```sh
# Note: no sudo here!
$(brew --prefix)/opt/socket_vmnet/bin/socket_vmnet_client \
  $(brew --prefix)/var/run/socket_vmnet \
  qemu-system-aarch64 \
    -netdev socket,id=net0,fd=3 \
    -device virtio-net-pci,netdev=net0 \
    [... other QEMU args ...]
```

**The critical difference from QEMU built-in vmnet:**

```sh
# Built-in vmnet — root required for ENTIRE QEMU process
sudo qemu-system-aarch64 -netdev vmnet-shared,id=net0 ...

# socket_vmnet — root is in the daemon, QEMU runs as your user
socket_vmnet_client /var/run/socket_vmnet qemu-system-aarch64 -netdev socket,id=net0,fd=3 ...
```

### Multi-VM with socket_vmnet

Multiple VMs can share **one** `socket_vmnet` instance because vmnet itself acts as a virtual switch with a DHCP server. Each VM just needs a unique MAC address:

```sh
# VM 1
socket_vmnet_client /var/run/socket_vmnet qemu-system-aarch64 \
  -netdev socket,id=net0,fd=3 \
  -device virtio-net-pci,netdev=net0,mac=52:54:00:ab:cd:01

# VM 2 (simultaneously, different terminal)
socket_vmnet_client /var/run/socket_vmnet qemu-system-aarch64 \
  -netdev socket,id=net0,fd=3 \
  -device virtio-net-pci,netdev=net0,mac=52:54:00:ab:cd:02
```

Both VMs get separate IPs from the macOS DHCP server and can reach each other (and the internet) through the shared NAT.

### Static DHCP / IP Assignment

`socket_vmnet` supports static DHCP via `/etc/bootptab`:

```
%%
# hostname   hwtype  hwaddr              ipaddr
chr-router   1       52:54:00:ab:cd:01   192.168.105.10
chr-branch   1       52:54:00:ab:cd:02   192.168.105.11
```

Combined with a known MAC in the QEMU `-device` flag, this gives CHRs predictable IPs without any RouterOS-side config. Useful for test automation.

### sudoers Integration

Instead of a launchd service, you can allow specific users to run `socket_vmnet` via sudo with restricted args:

```
# /etc/sudoers.d/socket_vmnet
%admin ALL=(root) NOPASSWD: /opt/socket_vmnet/bin/socket_vmnet
```

Lima ships a sudoers file generator: `limactl sudoers | sudo tee /etc/sudoers.d/lima`

quickchr could do the same: `quickchr network install` generates and installs the sudoers entry or launchd plist.

---

## Linux — TAP with User Ownership

### Pre-creating a TAP Device

The Linux kernel allows creating persistent TAP interfaces owned by a specific user. After creation, that user can attach QEMU to the TAP without any elevated privilege:

```sh
# Create once — as root/sudo
sudo ip tuntap add dev tap-chr0 mode tap user $USER group $USER
sudo ip link set tap-chr0 up

# QEMU start — no sudo
qemu-system-x86_64 \
  -netdev tap,id=net0,ifname=tap-chr0,script=no,downscript=no \
  -device virtio-net-pci,netdev=net0
```

The `script=no,downscript=no` suppresses QEMU's default `qemu-ifup`/`qemu-ifdown` script calls (which would need root). The TAP is already up, so QEMU just opens it.

### Persistence Across Reboots

User-owned TAPs are NOT persistent across reboots by default. Options:

**systemd-networkd** (`.netdev` file):
```ini
# /etc/systemd/network/50-chr-tap0.netdev
[NetDev]
Name=tap-chr0
Kind=tap

[Tap]
User=amm0
Group=amm0
```

**udev rule** (recreates on module load):
```
# /etc/udev/rules.d/90-quickchr-tap.rules
ACTION=="add", SUBSYSTEM=="net", KERNEL=="tun", RUN+="/sbin/ip tuntap add dev tap-chr0 mode tap user amm0"
```

**systemd service** (explicit, easy to manage):
```ini
[Unit]
Description=quickchr network: tap-chr0

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/ip tuntap add dev tap-chr0 mode tap user amm0
ExecStart=/usr/sbin/ip link set tap-chr0 up
ExecStop=/usr/sbin/ip tuntap del dev tap-chr0 mode tap

[Install]
WantedBy=multi-user.target
```

### TAP + Bridge for Real LAN Access

A TAP device alone gives guest ↔ host connectivity, but not LAN access. Add the TAP to a bridge that includes a physical interface:

```sh
# Setup (root, once)
sudo ip link add br0 type bridge
sudo ip link set eth0 master br0          # bridge physical interface
sudo ip link set br0 up
sudo ip tuntap add dev tap-chr0 mode tap user $USER
sudo ip link set tap-chr0 up
sudo ip link set tap-chr0 master br0      # add TAP to bridge

# QEMU start (no sudo)
qemu-system-x86_64 \
  -netdev tap,id=net0,ifname=tap-chr0,script=no,downscript=no \
  -device virtio-net-pci,netdev=net0
```

> **Warning:** Bridging moves the host's physical interface into the bridge. The host loses its IP from eth0 and gets it from br0. This breaks the host's network connection if misconfigured. Test carefully.

### Multiple VMs — One Bridge, Multiple TAPs

Each VM needs its own TAP device, but they all attach to the same bridge:

```sh
sudo ip tuntap add dev tap-chr0 mode tap user $USER
sudo ip tuntap add dev tap-chr1 mode tap user $USER
sudo ip link set tap-chr0 master br0
sudo ip link set tap-chr1 master br0

# VM 0
qemu-system-x86_64 -netdev tap,id=net0,ifname=tap-chr0,script=no ...
# VM 1
qemu-system-x86_64 -netdev tap,id=net0,ifname=tap-chr1,script=no ...
```

### The qemu-bridge-helper Alternative

QEMU ships a setuid-root binary `qemu-bridge-helper` (typically at `/usr/lib/qemu/qemu-bridge-helper` or `/usr/libexec/qemu-bridge-helper`) that automatically creates a TAP, adds it to a bridge, and passes the fd to QEMU. No sudo for QEMU, no per-user TAP management:

```sh
# Enable bridge (root, once)
sudo mkdir -p /etc/qemu
echo "allow br0" | sudo tee /etc/qemu/bridge.conf
sudo chmod 640 /etc/qemu/bridge.conf

# QEMU start — bridge helper handles TAP creation (setuid, transparent)
qemu-system-x86_64 \
  -netdev bridge,id=net0,br=br0 \
  -device virtio-net-pci,netdev=net0
```

**Pros:** Automatic TAP lifecycle (created on start, removed on stop). Works on Debian/Ubuntu without extra config.
**Cons:** Locked to specific bridges declared in `bridge.conf`. Each QEMU start creates a temporary TAP (name is random, e.g. `tap3`). Less control over naming/ownership.

### CAP_NET_ADMIN Alternative

Grant `CAP_NET_ADMIN` directly to the QEMU binary. This allows QEMU to create TAPs itself without root:

```sh
sudo setcap cap_net_admin=ep $(which qemu-system-x86_64)
# Then QEMU can use -netdev tap without sudo
```

**Warning:** This grants QEMU broad network admin capability and may not survive package updates that replace the binary. Use with care.

---

## Linux — Host NAT Without Bridge

If you don't need real LAN access (just internet from the guest), you can use a TAP with host-side NAT — simpler than bridging, and the host keeps its original interface:

```sh
# Setup (root, once)
sudo ip tuntap add dev tap-chr0 mode tap user $USER
sudo ip addr add 10.100.0.1/24 dev tap-chr0
sudo ip link set tap-chr0 up
sudo iptables -t nat -A POSTROUTING -s 10.100.0.0/24 -j MASQUERADE
sudo sysctl -w net.ipv4.ip_forward=1

# QEMU (no sudo) — guest must have static IP 10.100.0.2, gw 10.100.0.1
qemu-system-x86_64 \
  -netdev tap,id=net0,ifname=tap-chr0,script=no,downscript=no \
  -device virtio-net-pci,netdev=net0
```

On RouterOS inside the VM:
```
/ip address add address=10.100.0.2/24 interface=ether1
/ip route add gateway=10.100.0.1
/ip dns set servers=8.8.8.8
```

This is equivalent to `vmnet-shared` in functionality but runs completely without the underlying vmnet complexity. The host assigns the CHR an IP statically (no DHCP). Good for CI where you control the full environment.

---

## Windows

Windows is a secondary platform for quickchr, but the patterns are worth understanding.

### Default: User-mode (SLiRP)

Same as macOS/Linux user mode. Works without any special install. Port forwarding via `hostfwd`. This is what quickchr uses today on Windows (if it runs at all — Bun on Windows is a relatively new thing).

### TAP-Windows Adapter

OpenVPN's [TAP-Windows](https://github.com/OpenVPN/tap-windows6) driver creates a virtual Ethernet adapter as a kernel driver. Install is admin-once:

```powershell
# Install via OpenVPN (includes driver) or standalone:
# https://github.com/OpenVPN/tap-windows6/releases
# Or: winget install -e --id OpenVPN.OpenVPN
```

After install, the adapter appears in System → Network Adapters as "TAP-Windows Adapter V9" (or similar). QEMU can use it **without admin**:

```sh
qemu-system-x86_64 \
  -netdev tap,id=net0,ifname="TAP-Windows Adapter V9" \
  -device virtio-net-pci,netdev=net0
```

For internet sharing, configure "Internet Connection Sharing" (ICS) on the physical adapter and bridge it to the TAP.

### Hyper-V Virtual Switch (Windows 11)

Windows 11 with Hyper-V enabled has a "Default Switch" that provides NAT. You can create an External Switch for bridged access:

```powershell
# Create external switch (admin, once)
New-VMSwitch -Name "CHR-Bridge" -NetAdapterName "Ethernet" -AllowManagementOS $true
```

QEMU can bridge to a Hyper-V switch if the TAP-Windows driver is also present and connected to the switch. This is complex and not well-documented for QEMU specifically; WSL2's Hyper-V integration doesn't directly help QEMU.

### HAXM / WHPx Acceleration Note

QEMU acceleration on Windows:
- Intel HAXM: deprecated, no longer updated.
- WHPx (Windows Hypervisor Platform): Available on Windows 10+, requires Hyper-V feature enabled. Used via `-accel whpx`. Does NOT require Hyper-V VMs to be running, just the platform API.
- AEHD: AMD equivalent.

Networking mode is independent of acceleration mode.

### Windows Summary

Windows networking for QEMU is messy. The rootless path (user-mode) works well. For bridged scenarios, TAP-Windows is the closest to the Linux/macOS "create once" model. quickchr should support Windows user-mode networking fully and treat bridged/TAP as an advanced feature with explicit docs.

---

## Platform Comparison Summary

| Scenario | macOS | Linux | Windows |
|---|---|---|---|
| Rootless user-mode | `user` (built-in) | `user` (built-in) | `user` (built-in) |
| Inter-VM L2 (rootless) | `socket` | `socket` | `socket` |
| Host-level NAT (no LAN) | `socket_vmnet` shared | TAP + iptables MASQUERADE | TAP-Windows + ICS |
| Real LAN bridging | `socket_vmnet` bridged | bridge + TAP | TAP-Windows + Hyper-V switch |
| QEMU root required? | No (`socket_vmnet`) | No (user TAP or bridge-helper) | No (TAP driver) |
| Create-once tool | `socket_vmnet` launchd service | `ip tuntap add` + systemd | TAP-Windows installer |
| Multi-VM on same network | Yes (shared MAC trick) | Yes (multiple TAPs on one bridge) | Yes (multiple TAP adapters) |

---

## Reference: `quickchr network add` (future)

> **Note:** The primary networking model is **resolution-based discovery** — generic specifiers
> (`shared`, `bridged:<ifname>`) resolve to available platform infrastructure at start time.
> See [BACKLOG.md](../BACKLOG.md) § P5 "Cross-Platform Network Abstraction" for the current design.
>
> The `quickchr network add` command below is a **future extension** for one-time setup of
> privileged infrastructure (installing socket_vmnet launchd services, creating persistent TAPs).
> It does not conflict with the resolution model — it *creates* the infrastructure that resolution *discovers*.

### Registry File

Each named network is registered in `~/.local/share/quickchr/networks/<name>.json`:

```json
{
  "name": "wifibridge",
  "type": "socket_vmnet-bridged",      
  "platform": "darwin",
  "socketPath": "/opt/homebrew/var/run/socket_vmnet.bridged.en0",
  "iface": "en0",
  "createdAt": "2026-04-11T00:00:00Z"
}
```

```json
{
  "name": "tap-nat",
  "type": "tap",
  "platform": "linux",
  "ifname": "tap-chr0",
  "hostIP": "10.100.0.1/24",
  "createdAt": "2026-04-11T00:00:00Z"
}
```

### Command Syntax

```sh
# macOS — shared NAT (socket_vmnet)
sudo quickchr network add shared --type shared
# → installs socket_vmnet (if brew-installed), starts launchd service
# → registers: type=socket_vmnet-shared, socketPath=/opt/homebrew/var/run/socket_vmnet

# macOS — bridged to physical interface (socket_vmnet)
sudo quickchr network add wifibridge --type bridged --iface en0
# → installs socket_vmnet bridged launchd plist for en0
# → registers: type=socket_vmnet-bridged, iface=en0, socketPath=...socket_vmnet.bridged.en0

# Linux — TAP (user NAT)
sudo quickchr network add tap-nat --type tap --cidr 10.100.0.0/24
# → ip tuntap add dev tap-chr-nat mode tap user $SUDO_USER
# → ip addr add 10.100.0.1/24 dev tap-chr-nat; ip link set up
# → iptables MASQUERADE rule; ip_forward sysctl
# → optionally writes systemd unit for persistence
# → registers: type=tap, ifname=tap-chr-nat, hostIP=10.100.0.1/24

# Linux — bridge (LAN access) 
sudo quickchr network add lanbridge --type bridge --iface eth0
# → ip link add br-chr-lan type bridge
# → ip link set eth0 master br-chr-lan; ip link set up
# → writes /etc/qemu/bridge.conf
# → registers: type=bridge, brname=br-chr-lan

# List registered networks
quickchr network list
quickchr networks          # short alias
```

### Use a Named Network at Start

```sh
# Start using a named network (no sudo)
quickchr start my-chr --add-network shared
quickchr start my-chr --add-network wifibridge
quickchr start my-chr --add-network tap-nat

# Multiple networks
quickchr start my-chr --add-network user --add-network socket::hub-link --add-network wifibridge
```

### How QEMU Args Change Per Type

When quickchr sees a named network in the registry, it builds QEMU args based on the registered type:

| Registry `type` | QEMU args generated | Wrapper needed? |
|---|---|---|
| `user` | `-netdev user,id=netN,hostfwd=...` | No |
| `socket::name` | `-netdev socket,id=netN,listen/:port` or `connect` | No |
| `socket_vmnet-shared` | `-netdev socket,id=netN,fd=3` (or fd=5,7 for multi-NIC) | Yes: `socket_vmnet_client <socketPath>` |
| `socket_vmnet-bridged` | `-netdev socket,id=netN,fd=3` | Yes: `socket_vmnet_client <socketPath>` |
| `tap` | `-netdev tap,id=netN,ifname=<ifname>,script=no,downscript=no` | No |
| `bridge` | `-netdev bridge,id=netN,br=<brname>` | No |

The `socket_vmnet_client` wrapper is transparent: it wraps the entire QEMU spawn so quickchr's Bun.spawn call becomes:

```typescript
// Conceptually:
const cmd = network.type.startsWith("socket_vmnet")
  ? [socketVmnetClientBin, network.socketPath, qemuBin, ...qemuArgs]
  : [qemuBin, ...qemuArgs];
Bun.spawn(cmd, { ... });
```

Using multiple `socket_vmnet` networks (e.g., one shared + one bridged) requires chaining two `socket_vmnet_client` calls, each passing a different fd:

```sh
# Multi-NIC with two different socket_vmnet networks
socket_vmnet_client /var/run/socket_vmnet \
  socket_vmnet_client /var/run/socket_vmnet.bridged.en0 \
  qemu-system-aarch64 \
    -netdev socket,id=net0,fd=3 \
    -device virtio-net-pci,netdev=net0 \
    -netdev socket,id=net1,fd=4 \
    -device virtio-net-pci,netdev=net1 \
    ...
```

This is how Lima handles dual-socket-vmnet setups. The fd numbers increment: first `socket_vmnet_client` passes fd=3, second passes fd=4 (or the next available).

### MAC Address Management

For `socket_vmnet` and bridge modes, QEMU VMs sharing the same L2 segment must have unique MAC addresses. quickchr should:

1. **Auto-generate** a stable MAC per instance using a hash of the machine name + network name.
2. **Store** the MAC in `machine.json` under the network config (so it's stable across restarts).
3. **Never reuse** MACs across machines on the same named network.

```
52:54:00:<hash-byte1>:<hash-byte2>:<hash-byte3>
```

The `52:54:00` prefix is the QEMU OUI (assigned, not random). Using a deterministic hash from the machine name means the DHCP lease is stable across restarts, which matters for `/etc/bootptab` static reservations.

---

## Privilege Model

### Rule: quickchr Itself Never Calls sudo

`quickchr network add` must be invoked with `sudo` by the user. quickchr checks `process.getuid() === 0` (or equivalent) and exits with a helpful message if not root. **It does not prompt for or invoke sudo itself.**

This is the mikropkl pattern: transparent, no hidden privilege, no `sudo` spawning inside the tool.

```sh
# Correct
sudo quickchr network add wifibridge --type bridged --iface en0

# quickchr tells you what to do if you forgot
$ quickchr network add wifibridge --type bridged --iface en0
error: creating a bridged network requires root
  run: sudo quickchr network add wifibridge --type bridged --iface en0
```

### Future: sudoers / PolicyKit Integration

Lima-style: `quickchr network install-sudoers` could generate a sudoers file that allows running `quickchr network add` without the `sudo` prefix but with restricted args. Low priority; the explicit `sudo` model is cleaner and harder to misuse.

---

## Dependency Detection

`quickchr doctor` should check:

| Check | macOS | Linux | Windows |
|---|---|---|---|
| `socket_vmnet` installed | `brew list socket_vmnet` | — | — |
| `socket_vmnet` service running | `launchctl print system/...` | — | — |
| bridge-utils / iproute2 | — | `which ip` + `which bridge` | — |
| `/dev/net/tun` accessible | — | `ls -la /dev/net/tun` | — |
| qemu-bridge-helper present + setuid | — | `ls -la $(which qemu-bridge-helper)` | — |
| TAP-Windows driver | — | — | `Get-NetAdapter | Where Virtual` |
| Named networks registered | `~/.local/share/quickchr/networks/*.json` | same | same |

---

## CI Considerations

GitHub Actions Ubuntu runners have `/dev/net/tun` available but typically no pre-created TAP devices. Creating them requires `sudo` in the CI workflow:

```yaml
# In CI: create TAP before running integration tests
- name: Setup quickchr network
  run: |
    sudo ip tuntap add dev tap-chr0 mode tap user runner
    sudo ip link set tap-chr0 up
    sudo sysctl -w net.ipv4.ip_forward=1
```

macOS CI runners (GitHub-hosted) do NOT have `socket_vmnet` and do not have the vmnet entitlement. macOS runners cannot use bridged networking at all. Use `user` + `socket` mode only in CI.

**CI-safe default:** `user` mode only. All CI networking tests use user-mode SLIRP. Bridged/TAP tests are marked `skip` in CI environments (`process.env.CI` check or explicit opt-in env var `QUICKCHR_BRIDGE_TESTS=1`).

---

## Creative Rootless Topology Tricks

RouterOS's own tunneling capabilities work over rootless `user` + `socket` links. These are documented as topology recipes in MANUAL.md (future). Key patterns:

- **VXLAN overlay on socket links** — standard enterprise underlay/overlay, completely rootless
- **PPPoE server/client over socket** — simulates ISP/WISP PPPoE links
- **IPSec site-to-site over socket** — full MikroTik IPSec stack, no host-side VPN config

### VRRP over vmnet-shared / bridge

VRRP needs a shared broadcast domain visible to the host. This is the one scenario where rootless `socket` mode genuinely cannot substitute — VRRP requires L2 reachability to the VIP from outside the VMs. vmnet-shared (via socket_vmnet) makes this work on macOS without bridging to a physical interface.

---

## Open Questions

These are tracked here as platform-level questions. Implementation items are in [BACKLOG.md](../BACKLOG.md) § P5.

- **socket_vmnet fd numbering with multi-NIC:** Need to verify the exact fd passthrough mechanism when chaining two `socket_vmnet_client` calls. Test before committing to the multi-NIC socket_vmnet design.
- **ARM64 CHR `--add-network` NIC limit:** RouterOS arm64 CHR has been observed to support up to 9 VirtIO-net NICs on `virt` machine. Verify the exact limit before documenting it.
- **Persistent TAP on Linux reboot:** Decide between systemd-networkd, udev, or explicit systemd service for persistence. `systemd-networkd` .netdev files are the cleanest but require network daemon config.
- **Docker networks as underlay:** Podman/Docker's `macvlan` networks can bridge containers to a physical interface without user-land TAP management. Interesting for CI (Docker-in-Docker style). Worth exploring as an alternative to raw TAP for Linux CI.
- **socket_vmnet host-only mode:** Useful for test topologies where you want host ↔ CHR but no internet. Maps to a `host-only` specifier (analogous to VirtualBox "host-only adapter").
- **Multicast socket networks (mcast):** QEMU socket multicast lets any number of VMs join a shared L2 segment without a listen/connect asymmetry. Could simplify the named socket registry design.
