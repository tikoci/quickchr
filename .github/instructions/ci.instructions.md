---
applyTo: ".github/workflows/**"
---

# CI System — quickchr

## One CI run is a signal, not a fact

A red job tells you *something changed*, not *what is true*. Before acting on it:

- **Reproduce locally.** We run QEMU here (x86 under HVF, arm64 under TCG — slow but
  real). A failure seen only in CI is a lead to investigate, not a proven limitation.
- **Don't let one run cascade.** A single unverified failure is not license to sweep
  doc/code/skill edits. Above all, never `skip`/`os`-gate/`arch`-gate a failing test or
  example to green the pipeline before the behavior is reproduced and root-caused — that
  masks the bug (see `testing.instructions.md` and `examples.instructions.md`).

## Workflow Overview

Four workflows, each with a distinct purpose:

| Workflow | File | Trigger | Purpose |
|----------|------|---------|---------|
| **CI** | `ci.yml` | push/PR to `main`, `workflow_dispatch` | Core quality gate — every push |
| **Integration** | `integration.yml` | `workflow_dispatch`, `workflow_call` | THE reusable integration unit — any platform × RouterOS target × test filter |
| **PowerShell Lint** | `lint-powershell.yml` | push/PR touching `examples/**/*.ps1` or `PSScriptAnalyzerSettings.psd1`, `workflow_call` | PSScriptAnalyzer over the `.ps1` example mirrors |
| **Publish** | `publish.yml` | `push: tags: v*`, `workflow_dispatch` | NPM publish pipeline |

### CI pipeline (ci.yml)

```text
lint (ubuntu-latest) ──┐
unit-tests (ubuntu-latest) ─┴→ integration-x86 (ubuntu-latest) → windows-unit-tests (windows-latest)
```

Lint and unit-tests run **in parallel**. `integration-x86` waits for both via `needs:`. `windows-unit-tests` gates on `integration-x86` — if the core is broken, Windows runner minutes add no signal.

### Publish pipeline (publish.yml)

```text
lint ──┐      ┌ integration-x86 ──┐
unit-tests ─┴─┴ integration-arm64 ┴→ windows-unit-tests → publish
```

`integration-x86` (ubuntu-latest) and `integration-arm64` (ubuntu-24.04-arm) run **in
parallel**, both gating `windows-unit-tests → publish` — a release cannot publish unless
the full integration suite passes on **both** linux/x86_64 and linux/aarch64 (arm64 gate
added 2026-06-24, #15/#16). Both publish against the default (stable) image.

Triggered by `bun run release` (creates and pushes a `vX.Y.Z` tag) or via GitHub Actions UI (`workflow_dispatch`). The publish step runs `npm publish --tag next` for pre-releases (odd minor) and `--tag latest` for stable releases (even minor).

### Integration (integration.yml)

The single owner of integration-test execution ([#29](https://github.com/tikoci/quickchr/issues/29)) — no other workflow defines its own CHR runner logic. Two faces: `workflow_call` for wrapper workflows, and `workflow_dispatch` as the manual/lab face. One dispatch chooses **which platforms** (`platforms` — comma list or `gating`/`all` alias), **what runs** (`run-integration` and/or `run-examples`), against **which RouterOS** (`routeros-target`), on **which branch** (the ref in the "Run workflow" dropdown). Use `test-filter` to narrow integration to specific files and `example-filter` to narrow the smoke harness.

**Agents: dispatch this to ground a hypothesis on a platform you don't have locally**, instead of guessing from training data or waiting for a full verification cycle:

```bash
gh workflow run integration.yml --ref <branch> \
  -f platforms=macos-arm64 -f test-filter=exec.test.ts -f routeros-target=7.24beta2
gh run list --workflow integration.yml --limit 1   # grab the run id
gh run watch <run-id> --exit-status                # wait for the verdict
```

A `plan` job resolves `platforms` into one cross-OS matrix job (unknown platform ids **fail the plan** — a typo never produces an empty green run). **There is no `continue-on-error` anywhere**: TCG platforms (macos-x86, windows-x86) default to a curated smoke subset (`anchor.test.ts`) that reliably completes instead of being green-washed; an explicit `test-filter` overrides the subset. **Examples are held to the same bar as the code** — a broken example REDS the workflow on every platform it ran on. `lint-powershell` (PSScriptAnalyzer, gating) runs whenever `run-examples` is on — it `uses:` the reusable `lint-powershell.yml`, which **also runs on its own** for any push/PR touching `examples/**/*.ps1` or `examples/PSScriptAnalyzerSettings.psd1` ([#28](https://github.com/tikoci/quickchr/issues/28)).

Every integration job records per-file wall-clock timing to `integration-timing.txt` (in the artifact) — the raw feed for the metrics scheme tracked in [#30](https://github.com/tikoci/quickchr/issues/30).

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
- `test/unit/windows-channels.test.ts` — on Windows, `buildQemuArgs` produces TCP-localhost chardev paths (`host=127.0.0.1,port=portBase+N`: monitor +6, serial +7, qga +8), because QEMU's Winsock `bind()` cannot handle `\\.\pipe\` paths; `monitorCommand`/`serialStreams` throw `MACHINE_STOPPED` when the TCP port is not listening; `stopMachineByName` handles no `.sock` files
- `test/unit/windows-spawn.test.ts` — `spawnQemu` uses `node:child_process.spawn` with `detached: true` + `windowsHide: true`; calls `child.unref()`

**Windows integration tests** run via `platforms=windows-x86` on `integration.yml` —
TCG-only, defaulting to the smoke subset (`anchor.test.ts`); a red job is a real failure
(no `continue-on-error`). Set `test-filter` explicitly for a broader run.
QEMU is installed with `choco install qemu` and runs under TCG (no HVF/WHPX on GitHub
Windows runners). **Result (2026-06-07, run 27097457831): the full suite passed on
windows-latest/TCG — 56 pass / 0 fail / 3 skip.** Validated end-to-end: CHR boot, monitor
(+6) and serial (+7) channels, SLiRP networking + port-forward, REST
exec/license/device-mode/anchor, and **scp upload/download — which works on Windows
*without* `sshpass`**. So "standard Windows paths work" is settled — `sshpass` is a non-issue.
Remaining Windows gaps (still unvalidated, not blockers): QGA (+8, KVM-gated, skipped under
TCG), named-socket/`socat` networking (no `socat` on Windows), TAP-Windows setup, and
snapshot smoke — listed in `BACKLOG.md`. TCG boots are slow (90-min job timeout); start
narrow with `test-filter` (e.g. `start-stop.test.ts`) before the full suite.
To run locally on Windows: `bun test test/unit/`

## Integration — Dispatch Inputs

Inputs split into **platforms** (where), **modes** (what to run), and **scope/target**. Each selected platform runs integration (if `run-integration`) and/or the examples smoke harness (if `run-examples`). (Windows **unit** tests aren't here; they run on every push in the main CI pipeline.)

| Input | Type | Default | Effect |
|-------|------|---------|--------|
| `platforms` | string | `linux-x86` | Comma-separated platform ids, or alias `gating` (= linux-x86,linux-arm64,macos-arm64) / `all`. Unknown ids fail the plan job. |
| `run-integration` | boolean | **true** | Run `test/integration/` on each selected platform. |
| `run-examples` | boolean | false | Run the examples smoke harness on each selected platform + `lint-powershell`. |
| `test-filter` | string | "" | Integration: comma-separated test file names — e.g. `"exec.test.ts,anchor.test.ts"`; empty = all (TCG platforms: smoke subset `anchor.test.ts`) |
| `example-filter` | string | "" | Examples: comma-separated example names — e.g. `"quickstart,rollback"`; empty = curated subset. A typo fails fast (the harness validates against known names). |
| `routeros-target` | string | "" | RouterOS channel (`stable`/`long-term`/`testing`/`development`) **or** a pinned version (`7.22.1`, `7.24beta2`); empty = stable. Feeds both integration and examples. |

(`workflow_call` adds `artifact-prefix` so parallel callers don't collide on artifact names.)

**Platform table** (one row per matrix leg; the `plan` job owns this mapping):

| Platform id | Runner | CHR arch | Accel | Default scope |
|-------------|--------|----------|-------|---------------|
| `linux-x86` | ubuntu-latest | x86 | KVM | full suite |
| `linux-arm64` | ubuntu-24.04-arm | arm64 | KVM | full suite |
| `macos-arm64` | macos-15 | arm64 | HVF | full suite |
| `macos-x86` | macos-15-intel | x86 | TCG | smoke subset (`anchor.test.ts`) |
| `windows-x86` | windows-latest | x86 | TCG | smoke subset (`anchor.test.ts`) |

**`test-filter` for agent iteration**: when debugging a specific arm64 failure, dispatch `platforms=linux-arm64` with `test-filter=exec.test.ts` to skip the 40-minute full suite and get results in ~5 minutes.

**The examples smoke harness** (`test/integration/examples-smoke.test.ts`) runs a curated subset of runnable examples end-to-end — one representative per language *for the current OS* (`.ts` everywhere; `.sh`/`.py`-via-`uv` on POSIX; `.ps1` on Windows) — plus an intentional failure-path case that asserts teardown fires on error. `trial-license` is excluded (MikroTik rate-limits). Double-gated by `QUICKCHR_INTEGRATION` + `EXAMPLES_SMOKE` so the integration jobs don't pay for example boots; the `examples-smoke` job sets both via `bun run smoke:examples`.

**`routeros-target`** is exported to each job as `QUICKCHR_TEST_TARGET` and consumed by
integration tests via `test/integration/image-target.ts`: a channel name resolves to
`{ channel }`, anything else to `{ version }`, empty/unset → `stable` (so push CI, publish,
and local runs are unchanged). Tests that deliberately pin a version (provisioning's
`7.20.7`/`7.20.8`, library-api's `7.22.1`) ignore the override. Pinning an *old* target makes
the version-gated provisioning/device-mode tests fail — expected, since channels all clear
the 7.20.8 provisioning baseline.

## Integration Test Architecture Mapping

Each runner boots a CHR matching its **native architecture** — `detectAccel()` and the tests' `process.arch` check handle this automatically:

| Runner | process.arch | CHR arch | QEMU binary | Accelerator |
|--------|-------------|----------|-------------|-------------|
| ubuntu-latest (x64) | x64 | x86 | qemu-system-x86_64 | KVM (or TCG) |
| ubuntu-24.04-arm | arm64 | arm64 | qemu-system-aarch64 | KVM (or TCG) |
| macos-15 (M-series) | arm64 | arm64 | qemu-system-aarch64 | HVF (if available) |
| macos-15-intel (Intel) | x64 | x86 | qemu-system-x86_64 | HVF (if available) |
| windows-latest (x64) | x64 | x86 | qemu-system-x86_64 | TCG (no WHPX on runner) |

**x86 cross-arch on aarch64 is NOT tested** — TCG I/O port emulation makes it impractical.
aarch64 on x86_64 TCG is significantly slower than native but works.

Each runner boots the `routeros-target` (default `stable`) for its native arch — the
target selects the RouterOS *release*, never the *architecture*.

## arm64 Status Notes

Historical arm64 issues around `clean()` second-boot timeout and suspected
`node:http` stale responses were fixed or closed after lab/CI verification.
Do not reintroduce arm64 skips for those cases without a fresh local repro and
a new tracked issue.

## Artifacts — Where to Look After a Failure

### Coverage failures
- **Artifact**: `coverage-report` (14-day retention)
  - File: `coverage-report.txt` — full per-file coverage table from `bun test --coverage`
- **Step summary**: Coverage table + threshold comparison in the job summary tab
- **Annotations**: `::warning title=Coverage::` annotations appear inline on the commit/PR
- The `Enforce coverage thresholds` step has `continue-on-error: true` — it warns but
  never blocks merges.  To silence temporarily: dispatch with `min-funcs=0 min-lines=0`.

### Integration test failures
- **Artifact** (7-day retention) — one per job:
  - `ci.yml`: `integration-logs-linux-x64`
  - `integration.yml`: `integration-logs-{linux-x86|linux-arm64|macos-arm64|macos-x86|windows-x86}` (callers may override the `integration-` prefix via `artifact-prefix`)
  - `publish.yml`: `publish-integration-logs-{x86|arm64}`
  - `integration-output.txt` — full `bun test` output including error messages
  - `integration-timing.txt` — per-file wall-clock seconds + pass/fail (integration.yml only)
  - `machines/**/*.json` — `machine.json` with last-known state, ports, config
  - `machines/**/*.log` — `qemu.log` with QEMU stdout/stderr (boot messages, panics)
- **Step summary**: `integration.yml` shows failing lines + per-file timing (full log in the artifact); `ci.yml`/`publish.yml` show the last 80 lines per runner

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
| `BOOT_TIMEOUT` after `respawning QEMU once` warn | Genuine boot failure — `start()` already retried a wedged nested-KVM/HVF boot once and it still didn't reach REST | `qemu.log` (both attempts appended); a *single* wedged boot is now auto-recovered, so a `BOOT_TIMEOUT` that survives the respawn is real |

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

# Same, but boot a specific RouterOS target (channel or pinned version) —
# mirrors the integration.yml `routeros-target` dispatch input:
QUICKCHR_TEST_TARGET=long-term QUICKCHR_INTEGRATION=1 bun test test/integration/

# Release (creates tag + triggers publish):
bun run release
```

## CHR Image Caching

Downloaded RouterOS images are cached in `~/.local/share/quickchr/cache/`
using `actions/cache` with key `chr-images-{OS}-{arch}-v1`.

Cache misses cause a fresh download (~50-100 MB).  Bump the `-v1` suffix if the
cache needs to be invalidated (e.g. corrupted image from a partial download).

## Adding a New Runner

1. Add a row to the `plan` job's platform table in `integration.yml` (id, label, runner,
   tcg, smoke-default) and a conditional `Install QEMU + tools` step if the OS needs a new
   package set. Do NOT add standalone integration jobs to other workflows — `integration.yml`
   is the single owner of runner logic.
2. Install the right apt/brew packages directly in the job's `Install QEMU + tools` step.
   Required Linux apt packages by platform:
   - **x86_64**: `qemu-system-x86 qemu-utils ipxe-qemu sshpass`
   - **aarch64**: `qemu-system-arm qemu-utils qemu-efi-aarch64 ipxe-qemu sshpass`
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
