# `trial-license` — apply a CHR trial license

**Status:** ⚠ Manual only · requires a mikrotik.com account · **not run in CI**

**Validated against:** RouterOS 7.20.8+ (provisioning).

Apply a CHR trial license (p1) via `ChrInstance.license()` / `quickchr set --license`
and read the level back. Renewal calls MikroTik's licensing server with your
`MIKROTIK_WEB_ACCOUNT` / `MIKROTIK_WEB_PASSWORD`.

## Why it's manual-only

MikroTik **rate-limits** repeated trial-license requests per account/IP — running
this in CI would eventually return HTTP 429/403 and could flag your account. So it
is **excluded from the CI smoke harness**. Without the env vars it degrades to
read-only (prints the current level, skips the apply) rather than failing.

## Run it

```sh
export MIKROTIK_WEB_ACCOUNT=you@example.com
export MIKROTIK_WEB_PASSWORD=…

# Library API:
bun run trial-license.ts

# CLI — quickchr set <name> --license --level p1:
sh trial-license.sh
# Windows:
pwsh trial-license.ps1
```

Expected time: ~30–60 s (license-server round-trip).

## If you copied only this directory

- Replace `../../src/index.ts` → `@tikoci/quickchr`; copy `../lib.ts` or inline.
- `license()` also accepts `level: "p10" | "unlimited"`. Credentials resolve from
  env (`MIKROTIK_WEB_*`) or quickchr's secret store.

## Friction found

None for the apply — but mind the rate limit. Keep this out of any automated loop.

## See also

- [`../device-mode/`](../device-mode/) — the other first-boot provisioning step.
- [`../COVERAGE.md`](../COVERAGE.md) — capability coverage.
