# `mndp` — receive RouterOS MNDP broadcasts on the host (rootless L2)

**Status:** ✓ CI-verified · macOS/Linux · maintainer-supported

**Validated against:** RouterOS 7.x (any). QEMU 7.2+ (TCP `socket` netdev).

MNDP is a UDP/5678 Layer-2 broadcast (what WinBox uses to discover routers). SLIRP
terminates L2, so it never reaches the host. The fix: give the CHR a second NIC on
QEMU's TCP `socket` netdev (`socket-connect`), run a host TCP server, and parse the
guest's length-prefixed L2 frames → Ethernet → IPv4 → UDP/5678 → MNDP TLVs.
Rootless, loopback-only, cross-platform (unlike `socket-mcast`, broken on macOS).

## Run it

```sh
# Library API — boots the CHR + runs the host listener and parser:
bun run mndp.ts

# Python CLI driver — runs the listener AND drives the quickchr CLI (uv preferred):
uv run mndp.py [--channel stable] [--no-cleanup]

# CLI — prints the `quickchr start --add-network socket:connect:<port>` invocation
# (capture needs a listener, so this is illustrative; use mndp.ts/mndp.py to capture):
sh mndp.sh [port]
```

No `.ps1`: capture is a listener + binary frame parse, not a CLI flow — `mndp.ts`
and `mndp.py` are the runnable paths. Expected time: ~25–40 s with KVM/HVF.

## If you copied only this directory

- Replace `../../src/index.ts` → `@tikoci/quickchr`; copy `../lib.ts` or inline.
- `mndp.py` resolves quickchr via `--quickchr` or `$QUICKCHR` (default `quickchr`).

## Friction found

None for receive/inject — `socket-connect` carries raw L2 both ways with no native
helper. MAC-Telnet (the bidirectional case) is the same technique run as
request/reply; tracked for `centrs` in [#39](https://github.com/tikoci/quickchr/issues/39).

## See also

- [`../../docs/mndp.md`](../../docs/mndp.md), [`../../test/lab/mndp/REPORT.md`](../../test/lab/mndp/REPORT.md) — design + evidence.
- [`../udp-gateway/`](../udp-gateway/) — the simpler guest→host UDP (no L2 NIC) path.
- [`../COVERAGE.md`](../COVERAGE.md) — capability coverage.
