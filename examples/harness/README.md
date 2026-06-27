# `harness` — drive an external tool against a CHR via the connection surface

**Status:** ✓ CI-verified · ✓ cross-platform · maintainer-supported

**Validated against:** RouterOS 7.x (any).

The pattern `restraml` / `centrs` use: quickchr owns the VM lifecycle; a separate
process only needs the **connection surface**. Don't read `machine.json` — use
`subprocessEnv()` (env vars for a child) or `descriptor()` (a structured
`{ urls, auth, ports, status, … }` record). The "external tool" stand-in is
[`tool/child.ts`](./tool/child.ts), which receives nothing but the env and talks
to the CHR's REST API on its own.

Both surfaces are **secret-bearing** — treat their output like a password.
`BASICAUTH` is the raw `user:password` string, not a header (base64-encode it).

## Run it

```sh
# Library API — spawns tool/child.ts with subprocessEnv():
bun run harness.ts

# CLI — `quickchr env` feeds the child (set -a exports the KEY=value lines):
sh harness.sh
# Windows — uses `quickchr env --json` + $env:* (the natural PowerShell path):
pwsh harness.ps1
```

Expected time: ~40–60 s.

## If you copied only this directory

- Replace `../../src/index.ts` → `@tikoci/quickchr`; copy `../lib.ts` or inline
  the helpers. Keep `tool/child.ts` alongside.
- CLI scripts resolve quickchr via `$QUICKCHR` (default: repo source CLI).

## Friction found

None — `subprocessEnv()` / `descriptor()` exist precisely so harnesses stop
reading `machine.json`.

## See also

- [`../../MANUAL.md`](../../MANUAL.md) §4 — the `ChrInstance` connection surface.
- [`../COVERAGE.md`](../COVERAGE.md) — capability coverage.
