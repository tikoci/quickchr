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

## Three representations

Same recipe, three audiences (the quickchr examples convention):

| File | Audience | What it does |
|---|---|---|
| [`mndp.test.ts`](./mndp.test.ts) | library API (source of truth) | boots via `QuickCHR.start`, captures MNDP, **asserts** it matches REST |
| [`mndp.py`](./mndp.py) | CLI / network engineers | drives the `quickchr` CLI via subprocess; host TCP server + `struct` parsing |
| [`Makefile`](./Makefile) | recipe / agents | targets as documentation; delegates capture to bun/Python |

All three: start a host TCP listener, boot one CHR (`user` ether1 + `socket-connect`
ether2), set a known identity + ensure discovery on ether2, nudge an MNDP refresh,
then read and parse an announcement (the `.test.ts` additionally cross-checks
`identity` / `version` / `board` against the REST API — the source of truth).

## Run

```sh
# library API (asserts) — also: make bun-test
QUICKCHR_INTEGRATION=1 bun test examples/mndp/mndp.test.ts

# Python CLI driver — prints one captured MNDP record
python3 examples/mndp/mndp.py            # add --no-cleanup to keep the CHR

# Makefile (from this dir). Use a dev build with QUICKCHR=...
make capture
make QUICKCHR="bun run ../../src/cli/index.ts --" capture
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
