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
| Receive UDP the **guest sends** (syslog, NetFlow, TZSP, a server replying) | guest → host | guest sends to gateway `10.0.2.2:<port>`; host binds an **unconnected** socket | **no** | no |
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
instance.tzspGatewayIp;    // "10.0.2.2" — host address from inside the guest
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
// guest: send UDP to instance.tzspGatewayIp:<sock port> (syslog, NetFlow, TZSP, …)
```

Covers: guest-originated UDP (remote syslog, NetFlow/`traffic-flow`, TZSP sniffer
streaming) **and** a guest server replying to a client whose SLIRP-apparent address
is the gateway. Runnable: [`../examples/udp-gateway/`](../examples/udp-gateway/);
evidence: [`../test/lab/gateway-udp/REPORT.md`](../test/lab/gateway-udp/REPORT.md).

> RouterOS gotcha: logging-action names must be **alphanumeric** (`qchrgw`, not
> `qchr-gw`).

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

Two CHRs sharing a name form an L2 tunnel (first to start listens, second
connects):

```sh
quickchr networks sockets create lab-switch
quickchr start --name r1 --add-network socket::lab-switch
quickchr start --name r2 --add-network socket::lab-switch
```

Low-level equivalents: `socket-listen:<port>` / `socket-connect:<port>` /
`socket-mcast:<group>:<port>`. **`socket-mcast` is broken on macOS** (QEMU sets only
`SO_REUSEADDR`); it works on Linux/CI. Details: [`mndp.md`](./mndp.md),
[`networking.md`](./networking.md).

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
