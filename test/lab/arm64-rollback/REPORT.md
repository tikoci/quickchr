# arm64 snapshot rollback failure — root cause and fix (issue #31)

**Date**: 2026-07-05 · **Status**: root-caused, fixed, verified on arm64 (TCG) and x86 (HVF)

## Symptom

`examples/rollback` failed deterministically on linux/aarch64 (CI, KVM — twice) while
passing on every x86 platform. Locally reproduced on macOS/Intel with an arm64 guest
under TCG (`repro.ts`): after `snapshot.load("baseline")` the CHR never became
REST-reachable again.

## Evidence chain (`repro2.ts`, instrumented monitor I/O)

1. `savevm baseline` → **`Error: Device 'pflash1' is writable but does not support
   snapshots`** — QEMU refuses `savevm` while any writable block device is non-qcow2.
   On arm64 the per-machine EFI vars pflash (`efi-vars.fd`) was a **raw** file.
   x86 (SeaBIOS) has no pflash, hence no failure there.
2. `info snapshots` → `There is no snapshot available.` — **no snapshot was ever
   created on arm64.**
3. quickchr reported success anyway, twice over:
   - the monitor echoes the typed command as ANSI-laden fragments *before* the
     response, so `/^error[:\s]/i` (anchored at string start) never saw the `Error:` line;
   - `snapshot.save()` fell back to a **fabricated** `SnapshotInfo` when the new
     snapshot was absent from `list()`.
4. `loadvm baseline` (same swallowed error) left the VM in **`paused (restore-vm)`**
   permanently → REST dead → the observed wedge.

## Fix (four layers, each independently justified)

| Layer | Change |
|-------|--------|
| Root cause | Per-machine EFI vars are now a **qcow2 pflash** (`efi-vars.qcow2`, built via `qemu-img convert`; legacy raw vars migrated in place, NVRAM preserved) — `savevm`/`loadvm` genuinely work on arm64 |
| Error visibility | `monitorCommand` strips echo + ANSI (`cleanMonitorResponse`, unit-tested against the verbatim captured transcript) so `Error:` responses reach callers |
| No fabrication | `snapshot.save()` throws if the snapshot is absent from `info snapshots` after `savevm` |
| Wedge recovery | `snapshot.load()` issues `cont` before throwing, so a failed `loadvm` never strands a paused guest |

## Verification

- `repro.ts` on arm64/TCG: **PASS** — savevm real, loadvm restores, identity reverts,
  address-list change gone.
- `examples/rollback` on x86/HVF: **PASS** (no regression; x86 path untouched).
- `test/unit/monitor-response.test.ts`: cleaning fixtures are the raw bytes captured
  from the failing run.

## Notes

- The pflash error text matches QEMU's generic migration blocker for writable block devices that do not support snapshots; qcow2-backed NVRAM is the standard cure (same approach
  libvirt uses for aarch64 domains with snapshot support).
- `repro2.ts` intentionally keeps its machine for post-mortem (`--force` remove it).
