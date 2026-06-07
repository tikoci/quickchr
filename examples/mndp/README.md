# mndp — receive CHR neighbor-discovery broadcasts on the host

MNDP (MikroTik Neighbor Discovery Protocol) is the UDP/5678 Layer-2 broadcast
RouterOS uses to announce itself — the same thing WinBox listens for to populate
its **Neighbors** tab. This example shows how a host program (a discovery tool, a
test harness like `tikoci/centrs`) can **receive and parse those broadcasts from a
CHR**, with no root and no extra system setup.

## The problem

The default `user` (SLIRP) network terminates Layer 2 inside a userspace NAT.
Broadcasts never leave it, so a host listening on UDP/5678 sees **nothing** from
the CHR. You need an L2-capable NIC.

## The mechanism

QEMU's TCP `socket` netdev streams **every guest Ethernet frame** to a TCP peer,
length-prefixed (4-byte big-endian length + raw frame). So:

1. The host runs a TCP **server** on a loopback port.
2. The CHR boots with a second NIC using `socket-connect` to that port.
3. QEMU connects and streams ether2's frames to the host.
4. The host strips the 4-byte length and parses **Ethernet → IPv4 → UDP/5678 →
   MNDP TLVs**.

```ts
networks: ["user", { type: "socket-connect", port }]
//          └ ether1: REST/SSH/mgmt (hostfwd)    └ ether2: L2 frames → host
```

This is loopback-only (nothing leaks onto the LAN) and works on macOS, Linux, and
Windows alike.

### Why not mcast?

QEMU's `socket,mcast=` netdev is the documented **multi-VM** L2 path and works on
Linux, but it is **broken on macOS** for host capture and even VM-to-VM: QEMU sets
only `SO_REUSEADDR`, while macOS/BSD require `SO_REUSEPORT` on every socket sharing
a multicast port. Use `socket-connect` for host-side capture on any platform. See
[`../../docs/mndp.md`](../../docs/mndp.md) and the evidence in
[`../../test/lab/mndp/REPORT.md`](../../test/lab/mndp/REPORT.md).

## What the test does

1. Starts a host TCP listener (ephemeral port).
2. Boots one CHR (`user` + `socket-connect`).
3. Sets a known identity, ensures discovery is on for ether2.
4. Optionally injects an MNDP **refresh** frame to trigger an immediate reply
   (otherwise RouterOS announces on its own ~every 30s, plus a burst at link-up).
5. Waits for an MNDP announcement and **cross-checks** the L2-discovered
   `identity` / `version` / `board` against the REST API (the source of truth).

## Run

```sh
QUICKCHR_INTEGRATION=1 bun test examples/mndp/mndp.test.ts
```

Expected run time: ~25–40 s with HVF/KVM; a few minutes under TCG.

## Adapting it

- **Passive only:** drop the refresh-injection step and just listen — fine if you
  can wait up to one announce interval (~30 s).
- **Active discovery:** writing the refresh frame back over the same TCP
  connection is exactly the L2 injection primitive MAC-Telnet needs, so this
  example doubles as the starting point for L2 protocols beyond MNDP.
- **External consumer:** replace the `../../src/index.ts` import with
  `@tikoci/quickchr` (see [`../README.md`](../README.md) for the three dependency
  patterns). Everything else is identical.
