# `quickstart` — boot one CHR and read it back

**Status:** ✓ CI-verified · ✓ cross-platform · maintainer-supported

**Validated against:** RouterOS 7.x (any) — read-only, no provisioning.

The simplest possible quickchr loop, and the first place to start: boot a single
CHR on the stable channel, wait for the REST API, read a few built-in resources
(`/system/resource`, `/system/identity`, `/interface`), and tear the machine
down. Use it to confirm your QEMU + KVM/HVF setup works. *(Formerly `vienk`.)*

## Run it

```sh
# Library API (the source of truth) — runnable Bun script:
bun run quickstart.ts

# CLI (the commands you'd type):
sh quickstart.sh
# Windows:
pwsh quickstart.ps1
```

Expected time: ~20–40 s with KVM/HVF; ~2–4 min under TCG.
`arch` is omitted, so quickchr matches the host (arm64 on Apple Silicon, x86 on
Intel/AMD).

## If you copied only this directory

- Replace `../../src/index.ts` → `@tikoci/quickchr` (`bun add @tikoci/quickchr`).
- Copy `../lib.ts` alongside, or inline `runExample` / `exampleMachineName`.
- CLI scripts resolve quickchr via `$QUICKCHR` (default: the repo source CLI);
  set `QUICKCHR=quickchr` to use an installed binary.

## Friction found

None — this is the happy path.

## See also

- [`../grounding/`](../grounding/) — the next step: *write* config and read it back.
- [`../COVERAGE.md`](../COVERAGE.md) — which capability each example grounds.
