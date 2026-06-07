# Lab: host-side MNDP capture from a CHR

**Question:** how can a quickchr caller (e.g. `tikoci/centrs`) receive RouterOS
MNDP (UDP/5678 L2 broadcast) from a CHR, given that `user`/SLIRP networking drops
broadcasts?

**Environment:** Intel Mac (x86_64, HVF), macOS, QEMU 11.0.0, Bun 1.3.13,
RouterOS CHR 7.23.1 (stable). Dates: 2026-06-06.

## Probes

| Script | Tests | Result |
|---|---|---|
| `mndp-probe.ts` | host joins QEMU `socket-mcast` group, listens + injects refresh | ❌ 0 frames from QEMU |
| `neighbor-test.ts` | two CHRs on one `socket-mcast` group, check `/ip/neighbor` | ❌ both empty (no mutual discovery) |
| `socket-connect-probe.ts` | host TCP server, CHR `socket-connect`, listen + inject | ✅ 6 MNDP parsed |
| `stream-unix-probe.ts` | host AF_UNIX server, CHR `-netdev stream` (unix), detect framing | ✅ 4 MNDP parsed — **length-prefixed** |

Run any with `bun run test/lab/mndp/<script>.ts` (boots a real CHR; `KEEP=1`
leaves it running for inspection).

## Findings

### 1. `socket-mcast` is broken on macOS (host capture **and** VM-to-VM)

With `-netdev socket,id=net1,mcast=230.0.0.1:4001` (confirmed via `lsof`/`ps` on
the live process), a host UDP socket joined to the same group received **only its
own injected refresh** (loopback to itself), never QEMU's egress — across a 75 s
window that should have spanned ≥2 periodic announces. `netstat -gn` showed QEMU's
membership on `en0`; the host joined the group on every interface (incl. `en0`)
with `SO_REUSEPORT`. Still nothing.

The decisive test: **two CHRs on the same mcast group did not discover each other**
(`/ip/neighbor` empty on both after 40 s). So the failure is at the QEMU mcast
layer, not the host parser.

**Root cause:** QEMU's mcast netdev (`net/socket.c`) sets only `SO_REUSEADDR`.
macOS/BSD require `SO_REUSEPORT` on *every* socket sharing a multicast port for
datagrams to be delivered to more than one of them. On Linux, `SO_REUSEADDR`
suffices, so the same path works there (and in CI). This is a QEMU-on-macOS
limitation, not a quickchr bug — but quickchr's docs previously presented mcast as
the clean rootless multi-VM path without the caveat.

### 2. `socket-connect` (TCP) works on macOS — the portable path

Host runs a TCP server; CHR uses `-netdev socket,id=net1,connect=127.0.0.1:<port>`.
QEMU streams every ether2 frame to the host, **length-prefixed** (4-byte
big-endian length + raw Ethernet frame). Stripping that and parsing
Ethernet→IPv4→UDP/5678→MNDP TLVs yielded **6 MNDP announcements in ~50 s** with
correct `identity` (live-renamed `CHR`→`mndp-sc`), `version` `7.23.1 (stable)`,
`platform` `MikroTik`, `board` `CHR`, `uptime`, `softwareId`, `ifname` `ether2`,
and `ipv4` once an address was assigned. The injected refresh produced an immediate
reply. No multicast, loopback-only, no LAN leak, no `SO_REUSEPORT` dependency.

Promoted to the asserting example: `examples/mndp/mndp.test.ts` (cross-checks
L2-discovered values against the REST API).

### 3. `-netdev stream` over AF_UNIX works on macOS — but is **length-prefixed**

`-netdev stream` (QEMU 7.2+) with `addr.type=unix` was floated as a cleaner host-capture
transport than the legacy TCP `socket` netdev: a filesystem socket instead of a loopback TCP
port, and (per a reading of QEMU's docs) possibly *unframed*. The probe boots a user-only CHR
through the normal quickchr path, then stops it and relaunches the same disk with the `user`
NIC (ether1) plus a launch-time `-netdev stream,id=net1,server=off,addr.type=unix,addr.path=…`
NIC (ether2); the host listens on the unix socket first and QEMU connects to it.

**Result:** it works — QEMU connected and streamed ether2 frames (**21 frames, 4 MNDP parsed**:
`identity`, `version` `7.23.1`, `board` `CHR`, `ifname` `ether2`, cross-checked against REST).
But the byte stream is **length-prefixed with the same 4-byte big-endian header as the legacy
`socket` netdev** — the first bytes were `00 00 00 6e` (length 110) followed by a `33:33:…`
IPv6-multicast Ethernet frame. The probe auto-detects framing (it does not assume one), and it
classified the stream as `length-prefixed`.

So the **"no length-prefix parsing" hope is wrong for `-netdev stream`**: parsing is identical to
`socket-connect`. The only genuine advantage over `socket-connect` is dropping the loopback TCP
port in favor of a filesystem path. The genuinely *unframed* transport would be `-netdev dgram`
(SOCK_DGRAM — one datagram per frame), which is a different, costlier-to-wire netdev and was
**not** validated here. Tracked in `BACKLOG.md` ("`-netdev stream` + AF_UNIX as a port-free
host-capture transport").

### 4. Incidental observations

- ether1 (`user`) and ether2 (`socket-*`) both come up `RUNNING`; MNDP is emitted
  on ether2 with `discover-interface-list=all` (default `discover-interval=30s`),
  even before an IP is assigned.
- The same link carried LLDP (`0x88cc`) and IPv6 (`0x86dd`) frames.

## Recommendation

Host-side L2 capture (MNDP today, MAC-Telnet next) should use **`socket-connect`**.
Document `socket-mcast` as Linux/CI-only for multi-VM L2 until QEMU's macOS
multicast limitation is worked around (would need a `udp=`/`localaddr` netdev
option or `SO_REUSEPORT`, neither exposed by quickchr's current specifier).
