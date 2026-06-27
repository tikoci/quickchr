# `udp-gateway` — receive guest-originated UDP on the host, with no forward

**Status:** ✓ CI-verified · macOS/Linux · maintainer-supported

**Validated against:** RouterOS 7.x (any). QEMU user-mode (SLIRP) networking.

Receive UDP that a CHR *sends* on the host, with no `hostfwd` and no extra NIC.
Any datagram the guest sends to the SLIRP gateway `10.0.2.2:<port>` is relayed to
a host process bound on loopback `<port>` — the general form of the TZSP path
`ChrInstance.tzspGatewayIp` exposes. Emitter here: RouterOS remote syslog.

The catch: relayed datagrams arrive from a SLIRP-rewritten loopback source, so the
host socket must be left **unconnected** (recvfrom) — a connected socket filters
them out.

## Run it

```sh
# Library API — boots a CHR and runs the unconnected dgram listener:
bun run udp-gateway.ts

# CLI — RouterOS-side setup only (the listener can't be portable shell):
sh udp-gateway.sh [host-port]
```

No `.ps1`: the receive side is an unconnected UDP listener, not a CLI flow — the
runnable `.ts` is the cross-platform path. Expected time: ~30–50 s.

## If you copied only this directory

- Replace `../../src/index.ts` → `@tikoci/quickchr`; copy `../lib.ts` or inline
  the helpers.
- For host→guest forwards (incl. UDP port ranges), see
  [`../service-forward/`](../service-forward/) and
  [`../../docs/networking-recipes.md`](../../docs/networking-recipes.md).

## Friction found

None — the unconnected-socket requirement is inherent to SLIRP, documented in the
`tzspGatewayIp` JSDoc and `docs/networking-recipes.md`.

## See also

- [`../../test/lab/gateway-udp/REPORT.md`](../../test/lab/gateway-udp/REPORT.md) — evidence.
- [`../mndp/`](../mndp/) — the L2 (socket-connect) capture path.
- [`../COVERAGE.md`](../COVERAGE.md) — capability coverage.
