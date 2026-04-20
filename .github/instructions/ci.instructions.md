---
applyTo: ".github/workflows/**"
---

# CI System — quickchr

## Workflow Overview

**File**: `.github/workflows/ci.yml`
**Triggers**: push/PR to `main`, `workflow_dispatch` (manual with optional inputs)

```
lint (ubuntu-latest)           unit-tests (ubuntu-latest)
    Biome + tsc --noEmit           bun test test/unit/ --coverage
         ↘                        ↙
         integration (matrix)                        windows-unit-tests (windows-latest)
           linux/x86_64  ← ubuntu-latest       (always)   ← dispatch: windows=true
           linux/aarch64 ← ubuntu-24.04-arm    (always)
           macos/arm64   ← macos-15            (dispatch: macos=true)
           macos/x86_64  ← macos-13            (dispatch: macos=true)
```

Lint and unit-tests run **in parallel**.  Integration waits for both via `needs:`.
`windows-unit-tests` runs independently (no `needs:`); it is gated by `windows: true`.

## Windows Unit Tests

The `windows-unit-tests` job runs `bun test test/unit/` on `windows-latest`.
Windows-only tests (`describe.skipIf(process.platform !== "win32")`) in:

- `test/unit/windows-paths.test.ts` — `getDataDir()` (`LOCALAPPDATA`/`USERPROFILE`), `getMachinesDir()`, `getCacheDir()`, `findCommandOnPath()` uses `where.exe`, `detectPackageManager()` returns `"winget"`
- `test/unit/windows-channels.test.ts` — `buildQemuArgs` produces `\\.\pipe\...` named pipe paths; `monitorCommand`/`serialStreams` throw `MACHINE_STOPPED` for missing pipe; `stopMachineByName` handles no `.sock` files
- `test/unit/windows-spawn.test.ts` — `spawnQemu` uses `node:child_process.spawn` with `detached: true` + `windowsHide: true`; calls `child.unref()`

**Windows integration tests** (QEMU for Windows) are future work — not in CI yet.  
To run locally on Windows: `bun test test/unit/`

## Integration Test Architecture Mapping

Each runner boots a CHR matching its **native architecture** — `detectAccel()` and
the tests' `process.arch` check handle this automatically:

| Runner | process.arch | CHR arch | QEMU binary | Accelerator |
|--------|-------------|----------|-------------|-------------|
| ubuntu-latest (x64) | x64 | x86 | qemu-system-x86_64 | KVM (or TCG) |
| ubuntu-24.04-arm | arm64 | arm64 | qemu-system-aarch64 | KVM (or TCG) |
| macos-15 (M-series) | arm64 | arm64 | qemu-system-aarch64 | HVF (if available) |
| macos-13 (Intel) | x64 | x86 | qemu-system-x86_64 | HVF (if available) |

**x86 cross-arch on aarch64 is NOT tested** — TCG I/O port emulation makes it impractical.
aarch64 on x86_64 TCG is significantly slower than native but works.

## Artifacts — Where to Look After a Failure

### Coverage failures
- **Artifact**: `coverage-report` (14-day retention)
  - File: `coverage-report.txt` — full per-file coverage table from `bun test --coverage`
- **Step summary**: Coverage table + threshold comparison in the job summary tab
- **Annotations**: `::warning title=Coverage::` annotations appear inline on the commit/PR
- The `Enforce coverage thresholds` step has `continue-on-error: true` — it warns but
  never blocks merges.  To silence temporarily: dispatch with `min-funcs=0 min-lines=0`.

### Integration test failures
- **Artifact**: `integration-logs-{linux-x64|linux-arm64|macos-arm64|macos-x64}` (7-day retention)
  - `integration-output.txt` — full `bun test` output including error messages
  - `machines/**/*.json` — `machine.json` with last-known state, ports, config
  - `machines/**/*.log` — `qemu.log` with QEMU stdout/stderr (boot messages, panics)
- **Step summary**: last 80 lines of test output shown per runner

### Boot failure diagnosis checklist
1. Open `qemu.log` from the artifact — look for `Panic`, `Error`, `EFI` failures
2. Check `machine.json` — verify `status`, `arch`, `ports`, `version` fields
3. Check `integration-output.txt` — find the specific test that timed out or errored
4. Look for `::notice::KVM not available` in logs — TCG is significantly slower than KVM/HVF and per-probe HTTP timeouts may need to be larger

### Common failure signatures
| Symptom | Likely cause | Where to look |
|---------|-------------|---------------|
| `waitForBoot` timeout | TCG slowness or boot stall — check serial log to distinguish | `qemu.log` first 100 lines |
| `MISSING_FIRMWARE` on arm64 | UEFI pkg not installed | `apt-get` step logs |
| Port conflict | stale machine from prior run | `machine.json` port fields |
| `sshpass` not found | missing dep | `apt-get`/`brew install` step |
| First-run slower than 20 min | Initial download of versioned CHR images (7.20.7, 7.20.8) | Add those versions to the image cache key or wait for second run |

## Integration Test Parallelism

`bun test test/integration/` runs all 8 test files concurrently — each in a separate worker process, up to CPU count (4 on GitHub runners). This means up to 4 CHR instances may boot simultaneously.

**Port allocation is safe** — `findAvailablePortBlock` probes TCP ports rather than just reading state files, preventing most bind conflicts. Low-probability race: two processes both probe a port before QEMU binds it, both succeed, one fails to start. If this shows up in CI, run sequentially:

```bash
# Sequential file execution (slower, no port races):
for f in test/integration/*.test.ts; do QUICKCHR_INTEGRATION=1 bun test "$f" || break; done
```

**Version-specific images**: `provisioning.test.ts` downloads CHR 7.20.7 and 7.20.8 in addition to stable. These are cached after the first run. First CI run after a cache miss will be slower.

**Integration test timeout**: 30 minutes in CI. This covers:
- Up to 4 parallel CHR boots with KVM (~60s each)
- First-run old-version image downloads (7.20.7, 7.20.8)
- TCG fallback if KVM unavailable (significantly slower)

## Coverage Thresholds

Defaults (enforced as warnings, not hard failures):
- **Functions**: 75%
- **Lines**: 60%

Current baseline (as of main):
- Functions: 75.62% | Lines: 60.37%

Override via dispatch inputs `min-funcs` / `min-lines`.  Set to `0` to skip
enforcement entirely for a specific run.

## Dispatch Inputs

| Input | Type | Default | Purpose |
|-------|------|---------|---------|
| `macos` | boolean | false | Add macos-15 (arm64) + macos-13 (x86) runners |
| `windows` | boolean | false | Add windows-latest runner for Windows unit tests |
| `min-funcs` | string | 75 | Function coverage threshold % |
| `min-lines` | string | 60 | Line coverage threshold % |

## Local Equivalents

```bash
# What lint job runs:
bun run lint:biome && bun run lint:typecheck

# What unit-tests job runs (with coverage):
bun test test/unit/ --coverage

# What integration job runs:
QUICKCHR_INTEGRATION=1 bun test test/integration/
```

## CHR Image Caching

Downloaded RouterOS images are cached in `~/.local/share/quickchr/cache/`
using `actions/cache` with key `chr-images-{OS}-{arch}-v1`.

Cache misses cause a fresh download (~50-100 MB).  Bump the `-v1` suffix if the
cache needs to be invalidated (e.g. corrupted image from a partial download).

## Adding a New Runner

1. Add a new `include` entry to BOTH JSON strings in the `matrix: ${{ fromJSON(...) }}` expression
2. Add apt/brew packages to `matrix.qemu-pkgs` (Linux) or the macOS brew step
3. Verify `platform.ts` `EFI_CODE_PATHS` contains the firmware path for that distro/OS
