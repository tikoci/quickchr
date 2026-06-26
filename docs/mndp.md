# Receiving MNDP (and other L2 broadcasts) from a CHR on the host

> How a quickchr **caller** wires up host-side receipt of RouterOS
> [MNDP](https://help.mikrotik.com/docs/spaces/ROS/pages/8978519/Neighbor+discovery)
> neighbor-discovery broadcasts. This is the worked L2-capture recipe; for the
> by-goal "which mechanism for which traffic shape" index see
> [`networking-recipes.md`](./networking-recipes.md). Runnable example:
> [`examples/mndp/`](../examples/mndp/). Experimental evidence:
> [`test/lab/mndp/REPORT.md`](../test/lab/mndp/REPORT.md). For the MNDP wire format
> itself, see the `routeros-mndp` skill.

MNDP is a UDP/5678 **Layer-2 broadcast** (IPv4 `255.255.255.255:5678`). It is the
protocol WinBox uses to find routers, and every RouterOS device participates by
default. To receive it on the host you must put the CHR on an **L2-capable** netdev
— the default `user` (SLIRP) network cannot carry it.

## Why `user` networking can't deliver MNDP

QEMU user-mode (SLIRP) implements a userspace TCP/IP NAT. It forwards specific TCP
ports (`hostfwd`) but **terminates Layer 2** — broadcasts and non-forwarded UDP
never reach the host. A host process listening on UDP/5678 sees nothing from a
CHR whose only NIC is `user`. (`user` is still the right NIC for REST/SSH/WinBox
management; you add a *second* NIC for L2.)

## Which L2 netdev to use

| Netdev (quickchr specifier) | Carries MNDP to host? | Root? | Notes |
|---|---|---|---|
| `user` | ❌ | no | management only (hostfwd) |
| `socket-connect` / `socket-listen` (TCP) | ✅ **all platforms** | no | host is a TCP peer; QEMU streams length-prefixed frames; `socket-connect` is loopback-only (`socket-listen` binds `0.0.0.0`) |
| `socket-mcast` (`socket::name`, `socket:mcast:…`) | ✅ Linux · ❌ **macOS** | no | multi-VM L2 segment; macOS host capture & VM-to-VM both fail (see caveat) |
| `vmnet-shared` / `bridged` (macOS) | ✅ | yes¹ | host is on the bridge; sniff the `bridgeN` iface |
| `tap` (Linux) | ✅ | yes¹ | host owns the tap; sniff it |

¹ rootless via `socket_vmnet` (macOS) or a pre-created user-owned TAP (Linux) — see
[`networking.md`](./networking.md).

**Recommended for host-side capture: `socket-connect`.** It is the only fully
rootless, cross-platform, loopback-only option, and it needs no daemon or
pre-created interface.

## The recipe (`socket-connect`, verified)

1. Host runs a TCP **server** on a loopback port (use an ephemeral port and read
   it back, so nothing collides with quickchr's port blocks).
2. Boot the CHR with `user` (ether1, management) **plus** `socket-connect` (ether2):

   ```ts
   const port = /* host TCP server's bound port */;
   const chr = await QuickCHR.start({
     networks: ["user", { type: "socket-connect", port }],
     // …version, arch, etc.
   });
   ```

   This produces `-netdev socket,id=net1,connect=127.0.0.1:<port>`. The host
   listener **must be up before** `start()` — QEMU is the connecting side.
3. Ensure MNDP is emitted on ether2 (on by default; explicit is safer):

   ```ts
   await chr.exec("/ip/neighbor/discovery-settings/set discover-interface-list=all");
   ```

   MNDP is sent even without an IP on ether2; assign one only if you want the IPv4
   TLV populated.
4. On the host, de-frame and parse each datagram:

   ```text
   TCP stream → [uint32be length][raw Ethernet frame] → strip 14-byte Ethernet
              → IPv4 (proto 17) → UDP (dst 5678) → MNDP TLVs
   ```

   The MNDP TLV parser (types 1/5/7/8/10/11/12/16/17 → mac/identity/version/
   platform/uptime/softwareId/board/ifname/ipv4) is in the `routeros-mndp` skill
   and copied into the example.

### Active discovery (optional)

RouterOS announces on its own roughly every `discover-interval` (default **30 s**),
plus a burst when the link comes up — so passive listening works. To get an
**immediate** reply, write an MNDP refresh frame **back** over the same TCP
connection (length-prefixed, broadcast dst, payload `00 00 00 00`). QEMU injects it
into the guest and RouterOS replies at once. This same write-back is the L2
**injection** primitive that protocols like MAC-Telnet need.

## Verified findings (Intel Mac, macOS, QEMU 11, RouterOS 7.23.1)

From [`test/lab/mndp/REPORT.md`](../test/lab/mndp/REPORT.md):

- **`socket-connect` works.** 6 MNDP announcements parsed in ~50 s; `identity`,
  `version`, `platform`, `board`, `uptime`, `softwareId`, `ifname`, and (after
  assigning an address) `ipv4` all decoded and matched the REST API.
- **`socket-mcast` is broken on macOS.** With `socket:mcast:230.0.0.1:4001`, a host
  socket got **zero** frames from QEMU, and **two CHRs on the same mcast group did
  not discover each other** (`/ip/neighbor` empty on both). QEMU's mcast socket
  sets only `SO_REUSEADDR`; macOS/BSD require `SO_REUSEPORT` on all sockets sharing
  a multicast port. The mcast path is still valid on **Linux** (and CI).
- **Stream framing** is a 4-byte **big-endian length** prefix per frame (QEMU's
  legacy `-netdev socket` stream — not the newer `-netdev stream`, which is
  unframed) — confirmed by decoding real frames.
- **Loopback-only:** `socket-connect` uses `127.0.0.1`, so MNDP never leaks onto
  the physical LAN (unlike multicast/bridged).
- The same link also carries **LLDP** (`0x88cc`) and **IPv6** (`0x86dd`) frames if
  you want to parse those too.

## Topology notes

- `socket-connect` is **point-to-point**: one TCP connection = one CHR's ether2.
  For *N* CHRs, run *N* host listeners (one ephemeral port each), or — on Linux —
  use a single `socket-mcast` group and join it from the host.
- Keep `user` as ether1. SLIRP needs the guest's `10.0.2.15` for hostfwd/REST, and
  RouterOS auto-creates its DHCP client only on ether1 (see
  [`networking.md`](./networking.md) → "SLiRP hostfwd Requires a Guest IP").
