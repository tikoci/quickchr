# `rollback` — snapshot, change, restore

**Status:** ✓ CI-verified · ✓ cross-platform · maintainer-supported

**Validated against:** RouterOS 7.x (any). Requires a **qcow2 boot disk** (the
quickchr default; raw disks can't snapshot).

The classic "try it, undo it" flow: take a qcow2 snapshot of the running VM, make
a risky config change, then restore the snapshot and prove the change is gone.
Grounds the otherwise-uncovered `snapshot.save/load/list` surface.

## Run it

```sh
# Library API — snapshot.save() → change → snapshot.load() → assert reverted:
bun run rollback.ts

# CLI — quickchr snapshot <name> save/load/list:
sh rollback.sh
# Windows:
pwsh rollback.ps1
```

Expected time: ~30–50 s. Restore is instant (a RAM snapshot via QEMU `loadvm`).

## If you copied only this directory

- Replace `../../src/index.ts` → `@tikoci/quickchr`; copy `../lib.ts` or inline.
- CLI scripts resolve quickchr via `$QUICKCHR` (default: repo source CLI).

## Friction found

None — `ChrInstance.snapshot.*` and `quickchr snapshot` cover save/load/list/delete.

## See also

- [`../COVERAGE.md`](../COVERAGE.md) — capability coverage.
- [`../../MANUAL.md`](../../MANUAL.md) — snapshot details (qcow2, 16-item cap).
