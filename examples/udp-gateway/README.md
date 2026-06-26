# udp-gateway — receive UDP that a CHR *sends*, on the host, with no forward

A host program (a test harness like `tikoci/centrs`, a NetFlow/syslog collector, a
btest peer) often needs to receive UDP that a CHR **originates** — not reach a guest
service, but catch what the guest emits. This example shows how, over the plain
default `user` NIC, with **no `hostfwd` and no extra NIC**.

## The mechanism

QEMU user-mode (SLIRP) networking terminates Layer 2, but the gateway address
`10.0.2.2` **is the host** as seen from inside the VM. Any datagram the guest sends
to `10.0.2.2:<port>` is relayed to a host process bound on loopback `<port>`:

```ts
const port = /* host's bound UDP port */;
// guest: send UDP to instance.tzspGatewayIp (= "10.0.2.2") : port
await instance.exec(
  `/system/logging/action/add name=qchrgw target=remote remote=${instance.tzspGatewayIp} remote-port=${port}`,
);
await instance.exec("/system/logging/add action=qchrgw topics=info");
await instance.exec(`:log info "hello from the guest"`);
```

This is the general form of the TZSP path `ChrInstance.tzspGatewayIp` already
exposes — it is **not** TZSP-specific and reaches an ordinary bound UDP socket.

## The one catch: leave the host socket **unconnected**

The relayed datagrams arrive from a **SLIRP-rewritten loopback source**
(`127.0.0.1:<ephemeral>`), not the guest's `10.0.2.15`. So bind and `recvfrom` —
do **not** `connect()` the host socket, or it will filter the gateway-origin
datagrams out. (This is exactly why issue #18's btest peer needed an unconnected
socket to catch the guest server's replies.)

```ts
const sock = dgram.createSocket("udp4");
sock.bind(0, "0.0.0.0");        // unconnected — accepts the SLIRP relay source
```

## Gotchas

- **RouterOS logging-action names must be alphanumeric** — `qchr-gw` is rejected
  (*"action name can contain only letters and numbers"*); use `qchrgw`.
- This is the **guest→host** direction. For **host→guest** (reach a guest UDP/TCP
  service, including dynamic data ports), use `hostfwd` via `--forward` /
  `extraPorts` — see [`../../docs/networking-recipes.md`](../../docs/networking-recipes.md)
  for the full traffic-shape → mechanism guide and the UDP **range** form.

## Run

```sh
QUICKCHR_INTEGRATION=1 bun test examples/udp-gateway/udp-gateway.test.ts
```

Expected run time: ~25–40 s with HVF/KVM. Evidence and the SLIRP source-rewrite
detail: [`../../test/lab/gateway-udp/REPORT.md`](../../test/lab/gateway-udp/REPORT.md).

## Adapting it

- **Other emitters:** anything the guest sends to `10.0.2.2:<port>` works — NetFlow
  (`/ip/traffic-flow`), TZSP (`/tool/sniffer`), or a guest server replying to a
  client whose SLIRP-apparent address is the gateway.
- **External consumer:** replace the `../../src/index.ts` import with
  `@tikoci/quickchr` (see [`../README.md`](../README.md)). Everything else is identical.
