---
applyTo: ".github/workflows/**"
---

# CI System — quickchr

## Workflow Overview

Three workflows, each with a distinct purpose:

| Workflow | File | Trigger | Purpose |
|----------|------|---------|---------|
| **CI** | `ci.yml` | push/PR to `main`, `workflow_dispatch` | Core quality gate — every push |
| **Extended Verification** | `verify-extended.yml` | `workflow_dispatch` only | arm64, macOS, Windows integration |
| **Publish** | `publish.yml` | `push: tags: v*`, `workflow_dispatch` | NPM publish pipeline |

### CI pipeline (ci.yml)

```text
lint (ubuntu-latest) ──┐
unit-tests (ubuntu-latest) ─┴→ integration-x86 (ubuntu-latest) → windows-unit-tests (windows-latest)
```

Lint and unit-tests run **in parallel**. `integration-x86` waits for both via `needs:`. `windows-unit-tests` gates on `integration-x86` — if the core is broken, Windows runner minutes add no signal.

### Publish pipeline (publish.yml)

```text
lint ──┐
unit-tests ─┴→ integration-x86 → windows-unit-tests → publish
```

Triggered by `bun run release` (creates and pushes a `vX.Y.Z` tag) or via GitHub Actions UI (`workflow_dispatch`). The publish step runs `npm publish --tag next` for pre-releases (odd minor) and `--tag latest` for stable releases (even minor).

### Extended Verification (verify-extended.yml)

`workflow_dispatch` only — never runs on push/PR. All jobs are independent (no `needs:` between platforms). Use `test-filter` to run only specific test files for faster iteration.

## Release Process

```bash
# 1. Bump version in package.json manually (odd minor = pre-release, even = stable)
# 2. Run: bun run release
```

`bun run release` (`scripts/release.ts`):
- Validates git is clean and version format is valid
- Creates annotated tag `vX.Y.Z`
- Pushes the tag → triggers `publish.yml` automatically
- Prints the workflow URL for monitoring

**Pre-release vs stable** (from version minor):
- `0.1.x`, `0.3.x` — odd minor → `npm tag: next` (pre-release)
- `0.2.x`, `0.4.x` — even minor → `npm tag: latest` (stable release)

**Dry run**: dispatch `publish.yml` manually with `dry-run: true` to run all checks without publishing.

**Required secret**: `NPM_TOKEN` — npm automation token with publish access to `@tikoci/quickchr`.

## Windows Unit Tests

The `windows-unit-tests` job runs `bun test test/unit/` on `windows-latest`. Windows-only tests (`describe.skipIf(process.platform !== "win32")`) in:

- `test/unit/windows-paths.test.ts` — `getDataDir()` (`LOCALAPPDATA`/`USERPROFILE`), `getMachinesDir()`, `getCacheDir()`, `findCommandOnPath()` uses `where.exe`, `detectPackageManager()` returns `"winget"`
- `test/unit/windows-channels.test.ts` — `buildQemuArgs` produces `\\.\pipe\...` named pipe paths; `monitorCommand`/`serialStreams` throw `MACHINE_STOPPED` for missing pipe; `stopMachineByName` handles no `.sock` files
- `test/unit/windows-spawn.test.ts` — `spawnQemu` uses `node:child_process.spawn` with `detached: true` + `windowsHide: true`; calls `child.unref()`

**Windows integration tests** (QEMU for Windows) are future work — not in CI yet.  
To run locally on Windows: `bun test test/unit/`

## Extended Verification — Dispatch Inputs

| Input | Type | Default | Purpose |
|-------|------|---------|---------|
| `arm64` | boolean | false | Run integration tests on linux/aarch64 (ubuntu-24.04-arm) |
| `macos` | boolean | false | Run integration tests on macOS (macos-15 arm64 + macos-13 x86) |
| `windows` | boolean | false | Run Windows unit tests |
| `test-filter` | string | "" | Comma-separated test file names — e.g. `"exec.test.ts,anchor.test.ts"` runs only those files; empty = all |

**`test-filter` for agent iteration**: when debugging a specific arm64 failure, set `arm64: true` and `test-filter: "exec.test.ts"` to skip the 40-minute full suite and get results in ~5 minutes.

## Integration Test Architecture Mapping

Each runner boots a CHR matching its **native architecture** — `detectAccel()` and the tests' `process.arch` check handle this automatically:

| Runner | process.arch | CHR arch | QEMU binary | Accelerator |
|--------|-------------|----------|-------------|-------------|
| ubuntu-latest (x64) | x64 | x86 | qemu-system-x86_64 | KVM (or TCG) |
| ubuntu-24.04-arm | arm64 | arm64 | qemu-system-aarch64 | KVM (or TCG) |
| macos-15 (M-series) | arm64 | arm64 | qemu-system-aarch64 | HVF (if available) |
| macos-13 (Intel) | x64 | x86 | qemu-system-x86_64 | HVF (if available) |

**x86 cross-arch on aarch64 is NOT tested** — TCG I/O port emulation makes it impractical.
aarch64 on x86_64 TCG is significantly slower than native but works.

## arm64 Known Issues (tracked in BACKLOG.md)

- `clean()` second-boot timeout on arm64 — one test skipped with `.skipIf(arch === "arm64")`
- Bun arm64 `node:http` stale-response bug — exec tests skipped on arm64

These are tracked for future investigation. They do not block x86 publishing.

## Artifacts — Where to Look After a Failure

### Coverage failures
- **Artifact**: `coverage-report` (14-day retention)
  - File: `coverage-report.txt` — full per-file coverage table from `bun test --coverage`
- **Step summary**: Coverage table + threshold comparison in the job summary tab
- **Annotations**: `::warning title=Coverage::` annotations appear inline on the commit/PR
- The `Enforce coverage thresholds` step has `continue-on-error: true` — it warns but
  never blocks merges.  To silence temporarily: dispatch with `min-funcs=0 min-lines=0`.

### Integration test failures
- **Artifact**: `integration-logs-{linux-x64|linux-arm64|macos-arm64|macos-x64|publish-integration}` (7-day retention)
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
| `BOOT_TIMEOUT` on KVM runner | `detectAccel()` race during udevadm (fixed in cb4d505) | Check qemu.log for `-accel tcg` vs `-accel kvm` |

## Integration Test Parallelism

`bun test test/integration/` runs all 8 test files concurrently — each in a separate worker process, up to CPU count (4 on GitHub runners). This means up to 4 CHR instances may boot simultaneously.

**Port allocation is safe** — `findAvailablePortBlock` probes TCP ports rather than just reading state files, preventing most bind conflicts. Low-probability race: two processes both probe a port before QEMU binds it, both succeed, one fails to start. If this shows up in CI, run sequentially:

```bash
# Sequential file execution (slower, no port races):
for f in test/integration/*.test.ts; do QUICKCHR_INTEGRATION=1 bun test "$f" || break; done
```

**Version-specific images**: `provisioning.test.ts` downloads CHR 7.20.7 and 7.20.8 in addition to stable. These are cached after the first run. First CI run after a cache miss will be slower.

**Integration test timeout**: 50 minutes in CI. This covers:
- Up to 4 parallel CHR boots with KVM (~60s each)
- First-run old-version image downloads (7.20.7, 7.20.8)
- TCG fallback if KVM unavailable (significantly slower)

## Coverage Thresholds

Defaults (enforced as warnings, not hard failures):
- **Functions**: 75%
- **Lines**: 60%

Current baseline (as of main):
- Functions: 79.59% | Lines: 67.86%

Override via dispatch inputs `min-funcs` / `min-lines`.  Set to `0` to skip
enforcement entirely for a specific run.

## CI Dispatch Inputs (ci.yml)

| Input | Type | Default | Purpose |
|-------|------|---------|---------|
| `min-funcs` | string | 75 | Function coverage threshold % |
| `min-lines` | string | 60 | Line coverage threshold % |

## Local Equivalents

```bash
# What lint job runs:
bun run check

# What unit-tests job runs (with coverage):
bun test test/unit/ --coverage

# What integration job runs:
QUICKCHR_INTEGRATION=1 bun test test/integration/

# Release (creates tag + triggers publish):
bun run release
```

## CHR Image Caching

Downloaded RouterOS images are cached in `~/.local/share/quickchr/cache/`
using `actions/cache` with key `chr-images-{OS}-{arch}-v1`.

Cache misses cause a fresh download (~50-100 MB).  Bump the `-v1` suffix if the
cache needs to be invalidated (e.g. corrupted image from a partial download).

## Adding a New Runner

1. Add the job to the appropriate workflow file:
   - Core platforms → `ci.yml` (must be fast and reliable)
   - Experimental/fragile platforms → `verify-extended.yml`
2. Install the right apt/brew packages directly in the job's `Install QEMU + tools` step.
   Required Linux apt packages by platform:
   - **x86_64**: `qemu-system-x86 ipxe-qemu sshpass`
   - **aarch64**: `qemu-system-arm qemu-efi-aarch64 ipxe-qemu sshpass`
   - **`ipxe-qemu` is mandatory** on every Linux runner — it provides `efi-virtio.rom`
     which `virtio-net-pci` needs. Missing it produces:
     `qemu-system-aarch64: -device virtio-net-pci,netdev=net0: failed to find romfile "efi-virtio.rom"`
     and QEMU exits before boot.
3. Verify `platform.ts` `EFI_CODE_PATHS` contains the firmware path for that distro/OS.
4. For `ci.yml` jobs: make the new job `needs: [integration-x86]` unless it is the x86 job itself.

## Pipefail rule (MANDATORY)

Every step that pipes `bun test` (or any failable command) into `tee` MUST start with
`set -eo pipefail`. Without it, `tee`'s success masks the upstream failure and the step
reports green even when tests fail.

CI run #1's arm64 integration job reported green despite **every** CHR test failing
with `SPAWN_FAILED` — `tee /tmp/integration-output.txt` was the actual exit code that
the runner saw. The fix is one line at the top of each piped step:

```yaml
- name: Run integration tests
  run: |
    set -eo pipefail
    QUICKCHR_INTEGRATION=1 bun test test/integration/ 2>&1 | tee /tmp/integration-output.txt
```

Coverage parsing was also moved from the test step into the `if: always()` summary step
so the coverage table still appears on the dashboard when tests fail.
