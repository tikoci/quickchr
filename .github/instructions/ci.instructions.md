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
         integration (matrix)
           linux/x86_64  ← ubuntu-latest       (always)
           linux/aarch64 ← ubuntu-24.04-arm    (always)
           macos/arm64   ← macos-15            (dispatch: macos=true)
           macos/x86_64  ← macos-13            (dispatch: macos=true)
```

Lint and unit-tests run **in parallel**.  Integration waits for both via `needs:`.

## Integration Test Architecture Mapping

Each runner boots a CHR matching its **native architecture** — `detectAccel()` and
the tests' `process.arch` check handle this automatically:

| Runner | process.arch | CHR arch | QEMU binary | Accelerator |
|--------|-------------|----------|-------------|-------------|
| ubuntu-latest (x64) | x64 | x86 | qemu-system-x86_64 | KVM (or TCG) |
| ubuntu-24.04-arm | arm64 | arm64 | qemu-system-aarch64 | KVM (or TCG) |
| macos-15 (M-series) | arm64 | arm64 | qemu-system-aarch64 | HVF (if available) |
| macos-13 (Intel) | x64 | x86 | qemu-system-x86_64 | HVF (if available) |

**x86 cross-arch on aarch64 is NOT tested** — TCG I/O port emulation bottleneck
makes boot times impractical (>5 min).  aarch64 on x86_64 TCG works fine (~20s).

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
4. Look for `::notice::KVM not available` in logs — TCG boots are 2-4× slower

### Common failure signatures
| Symptom | Likely cause | Where to look |
|---------|-------------|---------------|
| `waitForBoot` timeout | TCG too slow, boot stall | `qemu.log` first 100 lines |
| `MISSING_FIRMWARE` on arm64 | UEFI pkg not installed | `apt-get` step logs |
| Port conflict | stale machine from prior run | `machine.json` port fields |
| `sshpass` not found | missing dep | `apt-get`/`brew install` step |

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
| `min-funcs` | string | 75 | Function coverage threshold % |
| `min-lines` | string | 60 | Line coverage threshold % |

## Local Equivalents

```bash
# What lint job runs:
bun run lint && bun run typecheck

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
