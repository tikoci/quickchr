# Lab: guest→host UDP via the SLIRP gateway (no forward)

**Question:** can a quickchr caller (e.g. `tikoci/centrs`, closing a btest UDP
gap) receive UDP that a CHR guest *sends*, on a plain `user`/SLIRP NIC, with **no**
`hostfwd`? Issue [#18](https://github.com/tikoci/quickchr/issues/18) reports yes —
a guest datagram to the gateway `10.0.2.2:<port>` reaches a host UDP socket bound
on loopback, *provided the host socket is left unconnected*. This lab confirms it
and pins down the why.

**Environment:** Intel Mac (x86_64, HVF), macOS, QEMU 11.0.0, Bun 1.3.13,
RouterOS CHR 7.23.1 (stable). Date: 2026-06-25.

## Probe

| Script | Tests | Result |
|---|---|---|
| `gateway-udp-probe.ts` | single `user` NIC; RouterOS remote-syslog → `10.0.2.2:<P>`; host unconnected UDP socket on `0.0.0.0:<P>` | ✅ 5 datagrams received, no forward |

Run with `QUICKCHR_INTEGRATION=1 bun test/lab/gateway-udp/gateway-udp-probe.ts`
(boots a real CHR).

## Findings

### 1. Guest→gateway UDP is delivered to a host socket, with no `hostfwd`

A CHR booted with **only** the default `user` NIC (no extra NIC, no `--forward`).
On the guest:

```routeros
/system/logging/action/add name=qchrgw target=remote remote=10.0.2.2 remote-port=<P>
/system/logging/add action=qchrgw topics=info
:log info "<nonce>"
```

The host, listening on an **unconnected** `udp4` socket bound to `0.0.0.0:<P>`,
received the RFC3164 syslog datagrams carrying the nonce (plus the two "logging
action/rule added" system-info messages) — **5 datagrams total**. SLIRP relays
traffic addressed to the gateway `10.0.2.2` onto the host's loopback; `10.0.2.2`
*is* the host from inside the VM. No port forward is involved in either direction.

### 2. The datagrams arrive from a SLIRP-rewritten loopback source — hence "unconnected"

Received source address was **`127.0.0.1:<ephemeral>`** (e.g. `127.0.0.1:59114`),
**not** the guest's `10.0.2.15`. SLIRP terminates the guest's UDP flow and re-emits
it from its own host-side socket. So:

- A **bound, unconnected** socket (`recvfrom`) accepts it — works.
- A **connected** socket (`connect()` to the guest's apparent address) would
  filter it out, because the datagram's source is the SLIRP relay, not the peer
  the socket is connected to. This is exactly the "leave the host socket
  unconnected" requirement from issue #18.

### 3. Gotcha: RouterOS logging-action names must be alphanumeric

`/system/logging/action/add name=qchr-gw …` fails with *"action name can contain
only letters and numbers"*. Use `qchrgw` (no hyphen). The probe and example use the
alphanumeric form. (First debug pass silently sent nothing for this reason — the
`:log info` messages were generated and stored in `/log` but never routed to a
remote action that didn't exist.)

### 4. Relationship to the existing TZSP path

This is the same primitive `ChrInstance.tzspGatewayIp` (`10.0.2.2`) +
`captureInterface` (`lo0`) already expose for `/tool/sniffer` TZSP streaming — but
generalized: it is **not** TZSP-specific, and it reaches an ordinary bound UDP
socket, not only a `tshark`/pcap capture on `lo0`.

## Recommendation

Document guest-originated UDP-to-gateway as a first-class recipe in
`docs/networking-recipes.md`: *host receives UDP from a guest → plain `user` NIC,
no forward, bind an **unconnected** socket on loopback.* Promote the probe to an
asserting example: `examples/udp-gateway/`. For the **host→guest** direction
(static or dynamic data ports), use `hostfwd` (`--forward`, incl. the new range
form); the guest's replies return to the host via the same gateway path.
