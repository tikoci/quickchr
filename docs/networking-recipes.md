# quickchr Networking Recipes — which mechanism for which traffic shape

> **Start here** when you know the *traffic* you need but not the *mechanism*.
> This is the by-goal index. For platform/privilege internals (vmnet, TAP, socket
> netdevs) see [`networking.md`](./networking.md); for the worked L2-capture recipe
> see [`mndp.md`](./mndp.md).

quickchr supports more networking than the default user-mode NIC exposes — the
hard part is picking the right primitive. Most consumers (REST/CLI automation,
integration tests, schema tools) never need more than the default. Reach past it
only for the specific traffic shapes below.

## Decision table

| You want… | Direction | Mechanism | Forward? | Extra NIC? |
|---|---|---|---|---|
| Reach a guest **TCP/UDP service** (REST, SSH, WinBox, SNMP, a container port) | host → guest | `user` NIC + `hostfwd` (`--forward` / `extraPorts`) | yes | no |
| Reach a guest service on **many/dynamic ports** (e.g. btest data ports) | host → guest | `hostfwd` **range** (`--forward name:9200-9210:2000-2010/udp`) | yes (one per port) | no |
| Receive UDP the **guest sends** (syslog, NetFlow, TZSP, a server replying) | guest → host | guest sends to gateway `10.0.2.2:<port>`; host binds an **unconnected** socket. Name the port per machine with `--receive` / `receivePorts` | **no** | no |
| Receive guest **L2 frames / broadcasts** (MNDP, MAC-Telnet, raw Ethernet) | guest ↔ host | `socket-connect` L2 NIC (host TCP server) | no | yes |
| **L2 link between two VMs** | VM ↔ VM | `socket::<name>` (named pair) or `socket-listen`/`connect`/`mcast` | no | yes |
| Real **LAN presence / DHCP from the host** | full L3 | `shared` or `bridged:<iface>` | no | yes |

Everything routable over the default NIC uses `user`. Keep `user` **first**
(ether1) in any multi-NIC config — RouterOS only auto-creates its DHCP client on
ether1, and SLIRP's `hostfwd` needs the guest's `10.0.2.15` address (see
[`networking.md`](./networking.md) → "SLiRP hostfwd Requires a Guest IP").

## CLI ↔ library parity

The CLI flags and the `StartOptions` fields are the same two knobs:

| CLI flag | `StartOptions` field | Type |
|---|---|---|
| `--add-network <spec>` (repeatable) | `networks` | `NetworkSpecifier[]` |
| `--forward <spec>` (repeatable) | `extraPorts` | `PortMapping[]` |
| `--receive <spec>` (repeatable; also `set --receive` / `--no-receive`) | `receivePorts` (also `addReceivePort()` / `removeReceivePort()`) | `ReceivePort[]` |

Turn `--forward` spec strings into `extraPorts` with `parseForwardSpec` (single
port) or `expandForwardSpec` (ranges), both exported from `@tikoci/quickchr`.
`WELL_KNOWN_GUEST_PORTS` / `lookupGuestPort` resolve guest port + proto for common
service names.

---

## 1. host → guest service (`hostfwd`)

The default. A `user` NIC plus one `hostfwd` directive per port. UDP is fully
supported (`proto: "udp"` / `…/udp`).

```ts
const chr = await QuickCHR.start({
  // single-port forwards, by hand or via expandForwardSpec("snmp")
  extraPorts: [{ name: "snmp", host: 9161, guest: 161, proto: "udp" }],
});
```

```sh
quickchr start --name lab --forward snmp            # host auto, guest 161/udp (registry)
quickchr start --name lab --forward myapp:9200:7777/udp
```

### Dynamic / many ports — the range form

QEMU `hostfwd` has no native port range (one directive per port). quickchr's
range syntax expands for you:

```sh
quickchr start --name btest --forward btest:9200-9210:2000-2010/udp
```

```ts
extraPorts: expandForwardSpec("btest:9200-9210:2000-2010/udp")
```

Rules: the **host range is required** (ranges are not auto-allocated), the guest
range defaults to the host numbers when omitted and must be the same length, and a
range may span at most `FORWARD_RANGE_MAX` (64) ports. Use this for L3 peer
protocols that allocate data ports at runtime — but if those ports are
**guest-chosen and unpredictable**, prefer the gateway path below for the
guest→host direction.

---

## 2. host receives UDP **from** a guest (the gateway path — no forward)

The non-obvious one. The gateway `10.0.2.2` **is the host** as seen from inside the
VM, so any datagram the guest sends to `10.0.2.2:<port>` is relayed to a host
socket bound on loopback `<port>` — **no forward, no extra NIC**. `ChrInstance`
exposes the constants:

```ts
instance.hostGatewayIp;    // "10.0.2.2" — host address from inside the guest
instance.captureInterface; // "lo0" on macOS, "any" on Linux
```

**Leave the host socket unconnected.** The relayed datagrams arrive from a
SLIRP-rewritten loopback source (`127.0.0.1:<ephemeral>`), not the guest's
`10.0.2.15`. A bound, unconnected socket (`recvfrom`) accepts them; a `connect()`-ed
socket filters them out. This is exactly why a btest peer catching a guest server's
replies must keep its socket unconnected.

```ts
const sock = dgram.createSocket("udp4");
sock.bind(0, "0.0.0.0");   // unconnected
// guest: send UDP to instance.hostGatewayIp:<sock port> (syslog, NetFlow, TZSP, …)
```

Covers: guest-originated UDP (remote syslog, NetFlow/`traffic-flow`, TZSP sniffer
streaming) **and** a guest server replying to a client whose SLIRP-apparent address
is the gateway. Runnable: [`../examples/udp-gateway/`](../examples/udp-gateway/);
evidence: [`../test/lab/gateway-udp/REPORT.md`](../test/lab/gateway-udp/REPORT.md).

> RouterOS gotcha: logging-action names must be **alphanumeric** (`qchrgw`, not
> `qchr-gw`).

### Named receive slots (`--receive`) — one port per machine

SLIRP rewrites every relayed datagram's source to `127.0.0.1:<ephemeral>`, so the
host cannot tell two machines apart by address. The **destination port is the only
label** (TZSP from RouterOS carries no sensor ID either). A receive slot gives a
machine a named port that is unique across quickchr machines, recorded in
`machine.json` and reported by `inspect`:

```sh
quickchr add lab1 --receive tzsp            # 37008/udp — the registry default
quickchr add lab2 --receive tzsp:37009      # a second machine: pick the next port
quickchr set lab1 --receive syslog          # running or stopped; no restart
quickchr set lab1 --no-receive syslog
quickchr list lab1 --json | jq '.receivePorts'           # any status
quickchr start lab1 && quickchr inspect lab1 | jq -r .receive.tzsp.hostPort   # → 37008 (running only)
```

```ts
const chr = await QuickCHR.start({ name: "lab1", receivePorts: [parseReceiveSpec("tzsp")] });
const tzsp = chr.receive.tzsp;   // ReceiveEndpoint | undefined under noUncheckedIndexedAccess
if (!tzsp) throw new Error("lab1 has no tzsp receive slot");
// listener: dgram bind(tzsp.hostPort, "127.0.0.1") — unconnected
// filter-stream=yes keeps the sniffer from capturing its own TZSP stream
await chr.exec(`/tool/sniffer/set streaming-enabled=yes filter-stream=yes streaming-server=${tzsp.guestHost}:${tzsp.guestPort}`);
await chr.exec("/tool/sniffer/start");
```

- **A reservation only.** quickchr never binds the port and emits no `hostfwd`, which is
  why a slot can be added to a running machine (a forward cannot, #141) — except during
  a foreground session (`start --fg`), which holds the machine lock until QEMU exits;
  pass `--receive` to that `start` instead. Your listener
  binds `127.0.0.1:<port>`, **unconnected**.
- **One number.** SLIRP does not translate the port: the guest sends to
  `10.0.2.2:<port>` and the host receives on `<port>`.
- **Spec** `name[:port][/proto]`. Known names fill the port: `tzsp` 37008, `netflow`
  (alias `traffic-flow`) 2055, `ipfix` 4739, `syslog` **5514** — not 514, so the
  listener needs no root; RouterOS sets the remote port. Anything else needs a port;
  proto defaults to `udp`.
- **Unique across machines.** A port any machine forwards or receives on, or one
  inside any machine's port block (on Windows QEMU's own monitor/serial/QGA sockets
  live at +6..+8), is a `PORT_CONFLICT` that names the next free port. Moving a slot
  (`--no-receive syslog --receive syslog:5515`) is one change: if the new port is
  refused, the old slot stays. Ports are explicit or registry
  defaults for now; auto-allocation from the port block waits for
  [#57](https://github.com/tikoci/quickchr/issues/57).
- **Needs the `user` NIC, first.** `inspect`'s `hostGateway` is `null` without one,
  and `--receive` is refused. It is also refused when `user` is not ether1: RouterOS
  adds a DHCP client only on ether1, so the guest would have no `10.0.2.x` address.
- **Not `--forward`.** `--forward tzsp` is refused with a pointer here: a forward is
  host→guest.

---

## 3. host sees guest **L2 frames / broadcasts** (`socket-connect`)

When the host needs raw Ethernet — MNDP neighbor discovery, MAC-Telnet, LLDP,
broadcasts — `user` won't do (it terminates Layer 2). Add a second NIC that streams
frames to a host TCP server:

```ts
networks: ["user", { type: "socket-connect", port }]
//          └ ether1: REST/mgmt          └ ether2: L2 frames → host (length-prefixed)
```

Rootless, loopback-only, cross-platform. Writing a frame back over the same
connection injects L2 into the guest (the MAC-Telnet primitive). Full recipe,
framing, and verified findings: [`mndp.md`](./mndp.md); example:
[`../examples/mndp/`](../examples/mndp/).

---

## 4. L2 link between two VMs (`socket::<name>`)

Two CHRs sharing a name form an L2 tunnel. How the two ends meet depends on the
link's transport, which is fixed when the name is created: the default pair of unix
datagram sockets lets either machine start first, every time.

```sh
quickchr networks sockets create lab-switch
quickchr start --name r1 --add-network socket::lab-switch
quickchr start --name r2 --add-network socket::lab-switch
```

A named link carries a transport, chosen at create time and reported by every command
that touches it. The default is a pair of unix datagram sockets (`--mode dgram`): no
host port, no UDP, and either machine may start first. `--mode listen-connect` is a
TCP pair on loopback and the Windows default — the first machine to join takes the
listening end and keeps it, so from then on that one starts first; `--mode mcast` is the only way to put
more than two machines on one segment.

**Prefer the default unless you need three or more machines.** `mcast` does not work
on macOS (QEMU sets only `SO_REUSEADDR`) and does not work where UDP is blocked, and
in both cases it fails *silently* — interfaces up, addresses assigned, 100% loss,
nothing logged.

Low-level equivalents, if you want the raw netdev rather than a registered name:
`socket:listen:<port>` / `socket:connect:<port>` / `socket:mcast:<group>:<port>` on
the CLI, or `{ type: "socket-listen", port }` and friends from TypeScript. Details:
[`mndp.md`](./mndp.md), [`networking.md`](./networking.md).

---

## 5. Real LAN presence / DHCP from the host (`shared`, `bridged`)

For a guest that needs a real-ish IP and LAN reachability (VRRP, a router with LAN
clients):

```sh
quickchr start --name gw --add-network user --add-network shared
quickchr start --name gw --add-network user --add-network bridged:en0
```

`shared`/`bridged` resolve to socket_vmnet (rootless) or vmnet (root) on macOS, and
to a pre-created user-owned TAP / bridge on Linux. The privilege model, "sudo once"
setup, and per-platform resolution are in [`networking.md`](./networking.md).
