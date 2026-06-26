# `service-forward` — pin a guest service to a chosen host port

**Status:** ✓ CI-verified · ✓ cross-platform · maintainer-supported

**Validated against:** RouterOS 7.x (any). QEMU user-mode (SLIRP) hostfwd.

Some clients assume a fixed local port (e.g. a Wine-hosted Dude/WinBox client that
only connects to `127.0.0.1:8291`). Instead of a loopback proxy, forward the guest
service straight to the host port you want with `extraPorts` (library) / `--forward`
(CLI). Here: pin guest WinBox (8291) to a free host port and prove it's reachable.
This is the donny WinBox-pinning recipe, made a one-liner.

The host port is **allocated** (`freePort()` / `free_port`), never hard-coded — so
parallel runs don't collide.

## Run it

```sh
# Library API — extraPorts: [{ name:"winbox", host, guest:8291 }] + TCP probe:
bun run service-forward.ts

# CLI — quickchr start --forward winbox:<port>:
sh service-forward.sh
# Windows:
pwsh service-forward.ps1
```

Expected time: ~25–45 s.

## If you copied only this directory

- Replace `../../src/index.ts` → `@tikoci/quickchr`; copy `../lib.ts` or inline.
- CLI scripts resolve quickchr via `$QUICKCHR` (default: repo source CLI).

## Friction found

None — `--forward name:host` / `extraPorts` cover host→guest forwarding, including
port ranges (`--forward btest:9200-9210:2000-2010/udp`). For the reverse
(guest→host UDP), see [`../udp-gateway/`](../udp-gateway/).

## See also

- [`../../docs/networking-recipes.md`](../../docs/networking-recipes.md) — the by-goal decision guide.
- [`../COVERAGE.md`](../COVERAGE.md) — capability coverage.
