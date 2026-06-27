# `device-mode` — enable a device-mode feature and read it back

**Status:** ✓ CI-verified · ✓ cross-platform · maintainer-supported

**Validated against:** RouterOS 7.20.8+ (provisioning). Long-term channel.

`/system/device-mode` gates powerful features (containers, routerboard hardware
access, …). Set it at first boot with `StartOptions.deviceMode` (library) /
`--device-mode-enable` (CLI), then confirm via REST / `quickchr get`. Here: enable
`container` so `/container` becomes usable.

## Run it

```sh
# Library API — deviceMode: { enable: ["container"] }:
bun run device-mode.ts

# CLI — quickchr start --device-mode-enable container; quickchr get <name> device-mode:
sh device-mode.sh
# Windows:
pwsh device-mode.ps1
```

Expected time: ~30–50 s.

## If you copied only this directory

- Replace `../../src/index.ts` → `@tikoci/quickchr`; copy `../lib.ts` or inline.
- `deviceMode` also accepts `mode` (rose/advanced/…) and `disable: [...]`.
  A live change (`setDeviceMode()`) power-cycles the VM — at start it doesn't.

## Friction found

None — `deviceMode` at start and `quickchr get <name> device-mode` cover the flow.

## See also

- [`../trial-license/`](../trial-license/) — the other first-boot provisioning step.
- [`../COVERAGE.md`](../COVERAGE.md) — capability coverage.
