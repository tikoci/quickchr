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
| **CI** | `ci.yml` | push/PR to `main`, `workflow_dispatch` | Fast quality gate (~3-5 min, no QEMU): lint, unit, Windows unit, PR freshness gate |
| **Main Integration** | `main.yml` | push to `main`, `workflow_dispatch` | The continuous integration-test signal: full suite on linux/x86_64 + linux/aarch64 |
| **Weekly Sweep** | `sweep.yml` | schedule (Mon 05:37 UTC), `workflow_dispatch` | All-platform sweep + examples smoke (separate file so a red TCG leg never blocks PRs) |
| **Integration** | `integration.yml` | `workflow_dispatch`, `workflow_call` | THE reusable integration unit — any platform × RouterOS target × test filter |
| **PowerShell Lint** | `lint-powershell.yml` | push/PR touching `examples/**/*.ps1` or `PSScriptAnalyzerSettings.psd1`, `workflow_call` | PSScriptAnalyzer over the `.ps1` example mirrors |
| **Release** | `release.yml` | `workflow_dispatch` only | One-click gate → version bump → tag → GitHub Release → npm publish |
| **RouterOS Versions** | `ros-versions.yml` | schedule (daily 04:17 UTC), `workflow_dispatch` | New-version check → dispatches integration on never-tested versions |

### CI pipeline (ci.yml)

```text
lint ∥ unit-tests (coverage) ∥ windows-unit-tests ∥ integration-freshness (PR only)
```

All four jobs run **in parallel** — nothing boots QEMU, so PR feedback lands in ~3-5 min.
Integration tests do NOT run on PRs; they run on every push to `main` (see below).

### Main Integration (main.yml) + the PR freshness gate

`main.yml` runs the **full integration suite + examples smoke (+ PowerShell lint) on
linux/x86_64 + linux/aarch64** (the release bar) on every push to `main`, delegating to
`integration.yml`. Examples are part of the per-push flow, not a weekly extra. Superseded pushes are
cancelled (their signal is stale by definition — a cancelled run never counts as red).

The **`integration-freshness`** job in `ci.yml` (PR-only, a required branch-protection
check) is the honesty contract for that arrangement: it queries the latest completed
`main.yml` run on `main` (skipping cancelled/skipped runs) and

- **PASSES** when that run is green — with a note if `main`'s tip has a newer run still
  in flight;
- **FAILS** when that run is red, with the run URL. A red `main` therefore visibly blocks
  ALL PRs until someone fixes it — the failure cannot rot quietly in the Actions list.

Verdict logic lives in `scripts/ci-freshness.ts` (unit-tested in
`test/unit/ci-freshness.test.ts`). **Override path** when the gate blocks you: fix `main`
first (usual case), or — if your PR *is* the fix — validate it by dispatching
`integration.yml` on your branch, then merge with an admin override; the next `main` push
turns the gate green again. Never "fix" the gate by weakening the verdict logic.

### Weekly Sweep (sweep.yml)

Monday 05:37 UTC (or `gh workflow run sweep.yml`): all five platforms + the examples smoke
harness, via `integration.yml` with `platforms=all` and `tcg-smoke: true` (the weekly
cadence bounds TCG legs to the anchor subset to cap cost — the full-suite-on-TCG "find
out" path is a manual `integration.yml` dispatch, where `tcg-smoke` defaults OFF).
Deliberately a separate workflow from `main.yml` so a red TCG leg **never** trips the PR
freshness gate — but a red sweep is still a real failure to investigate, never green-washed.

### Release pipeline (release.yml)

One-click `workflow_dispatch` — no tag pushing, no local script, no suite re-run:

```text
prepare (gate: main-only + Integration freshness green + [Unreleased] non-empty
         → unit re-check → release-prep.ts bump/rollover → commit+tag+GitHub Release)
  → publish (npm publish --provenance, dist-tag from odd/even minor)
```

The integration bar is the freshness gate: the latest completed `main.yml` run on `main`
must be green — the same full x86+arm64 suite the old publish pipeline re-ran, but paid
continuously on every push instead of at release time (arm64 gate lineage: #15/#16).

### Integration (integration.yml)

The single owner of integration-test execution ([#29](https://github.com/tikoci/quickchr/issues/29)) — no other workflow defines its own CHR runner logic. Two faces: `workflow_call` for wrapper workflows, and `workflow_dispatch` as the manual/lab face. **One dispatch runs a full platforms × targets matrix**: `platforms` (comma list or `gating`/`all` alias) crossed with `routeros-targets` (comma list of channels and/or pinned versions) — e.g. `platforms=gating` + `routeros-targets=stable,long-term,7.24rc1` is nine legs in one run, no wrapper jobs or repeat dispatches. `run-integration`/`run-examples` choose what runs (examples default **ON** — they are part of the flow); the ref in the "Run workflow" dropdown chooses the branch. Use `test-filter`/`example-filter` to narrow.

**Agents: dispatch this to ground a hypothesis on a platform you don't have locally**, instead of guessing from training data or waiting for a full verification cycle:

```bash
gh workflow run integration.yml --ref <branch> \
  -f platforms=macos-arm64 -f test-filter=exec.test.ts \
  -f routeros-targets=7.24beta2 -f run-examples=false
gh run list --workflow integration.yml --limit 1   # grab the run id
gh run watch <run-id> --exit-status                # wait for the verdict
```

A `plan` job resolves `platforms` × `routeros-targets` into one cross-OS matrix job (unknown platform ids or malformed targets **fail the plan** — a typo never produces an empty green run). **There is no `continue-on-error` anywhere**, and **no implicit narrowing either**: every platform — including the TCG ones (macos-x86, windows-x86) — runs the full suite by default; a `platforms=all` dispatch means all platforms, full set. TCG legs are slow (they get a 300-minute timeout when running the full suite) — pass `tcg-smoke=true` to bound them to the curated `anchor.test.ts` subset when you only need a boot+REST pulse (the weekly sweep does). **Examples are held to the same bar as the code** — a broken example REDS the workflow on every platform it ran on. `lint-powershell` (PSScriptAnalyzer, gating) runs whenever `run-examples` is on — it `uses:` the reusable `lint-powershell.yml`, which **also runs on its own** for any push/PR touching `examples/**/*.ps1` or `examples/PSScriptAnalyzerSettings.psd1` ([#28](https://github.com/tikoci/quickchr/issues/28)).

Every integration job records per-file wall-clock timing to `integration-timing.txt` and assembles `metrics.ndjson` (both in the artifact) — see "CI metrics (ci-data)" below ([#30](https://github.com/tikoci/quickchr/issues/30)).

## CI metrics (ci-data)

CHR boot timing and test outcomes are collected as a **byproduct** of integration runs —
never a second run, never affecting pass/fail:

1. The **library** appends every successful boot to `<dataDir>/boot-log.ndjson`
   (`{ts, name, version, arch, accel, bootMs, host}`, rotated at 1000→500 lines) and stamps
   `lastAccel`/`lastBootMs` into `machine.json`. This survives test cleanup — machine dirs
   are removed by tests, so machine.json alone cannot carry timing to CI.
2. Each integration job runs `bun scripts/ci-metrics.ts assemble` (always, even on failure):
   boot-log + `integration-timing.txt` → `metrics.ndjson` (boot / test-file / suite records)
   + a boot-timing table in the job summary.
3. When `collect-metrics` is on (default for dispatches; main.yml, sweep.yml and
   ros-versions dispatches pass it explicitly), the `aggregate` job pushes each platform's
   `metrics.ndjson` to the **`ci-data` orphan branch** as `runs/<run_id>-<platform>-<target>.ndjson`
   and folds suite records into `tested-versions.json`
   (`{version: {platform: {run_id, date, conclusion}}}`). Only `scope=full` runs mark a
   version tested, and a run marks **exactly its target's resolved version** — never
   versions booted incidentally by upgrade/pinned-channel tests (crediting those would
   suppress the scheduler for versions no full suite ever targeted). Fails are recorded so
   the scheduler re-flags them. After a fold-logic change, rebuild the rollup from the
   per-run files (they are the source of truth):
   `git worktree add /tmp/ci-data ci-data && bun scripts/ci-metrics.ts refold --data /tmp/ci-data`
   — then commit/push the regenerated `tested-versions.json` on `ci-data`. Callers must grant `contents: write` (reusable-workflow permissions are
   capped by the calling job). **The aggregate job is best-effort by contract**: a
   fold/push failure emits a `::warning::` and the job stays green — the one deliberate
   exception to "red is red", because a metrics hiccup redding main.yml would make the
   PR freshness gate block every PR over side-band data. The raw metrics remain in the
   run's artifacts either way.

The ci-data branch README documents the schema + `gh`/jq/SQLite query recipes. Agents
debugging "why is this platform slow" should read `tested-versions.json` and the recent
`runs/*.ndjson` before theorizing.

## Release Process

```bash
gh workflow run release.yml -f version-bump=patch                 # release now
gh workflow run release.yml -f version-bump=patch -f dry-run=true # preview first
gh workflow run release.yml -f version-bump=exact -f exact-version=0.6.0
```

`release.yml` (`workflow_dispatch` only, main-only) does everything:
1. **Gates**: latest `main.yml` integration run green (freshness — no suite re-run) and
   `CHANGELOG.md` `[Unreleased]` non-empty (it becomes the release notes; the
   end-of-session checklist keeps it current). Plus a quick `bun test test/unit/`.
2. **Mutation** (`scripts/release-prep.ts`, unit-tested): bump `package.json`, roll
   `[Unreleased]` over to `## [X.Y.Z] — date`.
3. **Publish**: commit `release: vX.Y.Z` + annotated tag + GitHub Release (notes = the
   changelog section), then `npm publish --provenance` from the tag.

**Pre-release vs stable** (from version minor — pick the version accordingly):
- `0.1.x`, `0.3.x` — odd minor → `npm tag: next` (pre-release, GitHub Release marked pre-release)
- `0.2.x`, `0.4.x` — even minor → `npm tag: latest` (stable release)

**Dry run** (`dry-run: true`): every gate and the version/notes computation run; nothing
is committed, tagged, or published.

**Required secret**: `NPM_TOKEN` — npm automation token with publish access to `@tikoci/quickchr`.

**Main is always release-able**: that is the point of the freshness gate + squash-only
PRs. If the gate blocks a release, fix `main` — do not bypass the gate.

## RouterOS Version Scheduler (ros-versions.yml)

Daily (04:17 UTC) or `gh workflow run ros-versions.yml`: fetches the newest version per
release channel from `upgrade.mikrotik.com/routeros/NEWESTa7.<channel>`, checks each
against `ci-data/tested-versions.json`, and fires **one** integration dispatch covering
**all** versions with no linux-x86 record (they ride the `routeros-targets` matrix of a
single run, `collect-metrics: true`).

- A version that ran and **failed is not re-dispatched** — the fail is recorded in
  tested-versions.json and the red run stays visible. After investigating/fixing, re-run
  manually: `gh workflow run integration.yml -f platforms=linux-x86 -f routeros-targets=<version> -f collect-metrics=true`
- Known-broken betas: `-f skip-versions=7.24beta3,...` on a manual dispatch.
- Successful dispatched runs fold into tested-versions.json via the normal aggregate
  path, so the next day's check is a no-op for that version.

## Windows Unit Tests

The `windows-unit-tests` job runs `bun test test/unit/` on `windows-latest`. Windows-only tests (`describe.skipIf(process.platform !== "win32")`) in:

- `test/unit/windows-paths.test.ts` — `getDataDir()` (`LOCALAPPDATA`/`USERPROFILE`), `getMachinesDir()`, `getCacheDir()`, `findCommandOnPath()` uses `where.exe`, `detectPackageManager()` returns `"winget"`
- `test/unit/windows-channels.test.ts` — on Windows, `buildQemuArgs` produces TCP-localhost chardev paths (`host=127.0.0.1,port=portBase+N`: monitor +6, serial +7, qga +8), because QEMU's Winsock `bind()` cannot handle `\\.\pipe\` paths; `monitorCommand`/`serialStreams` throw `MACHINE_STOPPED` when the TCP port is not listening; `stopMachineByName` handles no `.sock` files
- `test/unit/windows-spawn.test.ts` — `spawnQemu` uses `node:child_process.spawn` with `detached: true` + `windowsHide: true`; calls `child.unref()`

**Windows integration tests** run via `platforms=windows-x86` on `integration.yml` —
TCG-only, full suite by default (300-min timeout); a red job is a real failure
(no `continue-on-error`). Narrow with `test-filter`, or pass `tcg-smoke=true` for
just the anchor boot+REST pulse.
QEMU is installed with `choco install qemu` and runs under TCG (no HVF/WHPX on GitHub
Windows runners). **Result (2026-06-07, run 27097457831): the full suite passed on
windows-latest/TCG — 56 pass / 0 fail / 3 skip.** Validated end-to-end: CHR boot, monitor
(+6) and serial (+7) channels, SLiRP networking + port-forward, REST
exec/license/device-mode/anchor, and **scp upload/download — which works on Windows
*without* `sshpass`**. So "standard Windows paths work" is settled — `sshpass` is a non-issue.
Remaining Windows gaps (still unvalidated, not blockers): QGA (+8, KVM-gated, skipped under
TCG), named-socket/`socat` networking (no `socat` on Windows), TAP-Windows setup, and
snapshot smoke — listed in `BACKLOG.md`. TCG boots are slow; start narrow with
`test-filter` (e.g. `start-stop.test.ts`) when iterating on a single failure.
To run locally on Windows: `bun test test/unit/`

## Integration — Dispatch Inputs

Inputs split into **platforms** (where), **targets** (which RouterOS), **modes** (what to run), and **scope**. The matrix is platforms × targets; each leg runs integration (if `run-integration`) and/or the examples smoke harness (if `run-examples`). (Windows **unit** tests aren't here; they run on every push in the main CI pipeline.)

| Input | Type | Default | Effect |
|-------|------|---------|--------|
| `platforms` | string | `linux-x86` | Comma-separated platform ids, or alias `gating` (= linux-x86,linux-arm64,macos-arm64) / `all`. Unknown ids fail the plan job. |
| `run-integration` | boolean | **true** | Run `test/integration/` on each selected platform. |
| `run-examples` | boolean | **true** | Run the examples smoke harness on each matrix leg + `lint-powershell`. Default ON — pass `false` for narrow/lab dispatches. |
| `test-filter` | string | "" | Integration: comma-separated test file names — e.g. `"exec.test.ts,anchor.test.ts"`; empty = all files |
| `tcg-smoke` | boolean | false | Bound TCG platforms (macos-x86, windows-x86) to the `anchor.test.ts` smoke subset when `test-filter` is empty. Off = full suite everywhere. |
| `example-filter` | string | "" | Examples: comma-separated example names — e.g. `"quickstart,rollback"`; empty = curated subset. A typo fails fast (the harness validates against known names). |
| `routeros-targets` | string | "" | Comma-separated RouterOS targets — channels (`stable`/`long-term`/`testing`/`development`) and/or pinned versions (`7.22.1`, `7.24beta2`). **Each target crosses with each platform** (matrix legs). Empty = stable. Feeds both integration and examples. |
| `collect-metrics` | boolean | **true** (dispatch) | Push this run's boot/test timing to the `ci-data` branch. Default ON for dispatches — a run without recorded results is a wasted run. (`workflow_call` default is false; wrappers opt in explicitly.) |

(`workflow_call` adds `artifact-prefix` so parallel callers don't collide on artifact names.)

**Platform table** (one row per matrix leg; the `plan` job owns this mapping):

| Platform id | Runner | CHR arch | Accel | Full-suite timeout |
|-------------|--------|----------|-------|--------------------|
| `linux-x86` | ubuntu-latest | x86 | KVM | 60 min |
| `linux-arm64` | ubuntu-24.04-arm | arm64 | KVM | 60 min |
| `macos-arm64` | macos-15 | arm64 | HVF | 60 min |
| `macos-x86` | macos-15-intel | x86 | TCG | 300 min (90 with `tcg-smoke`/`test-filter`) |
| `windows-x86` | windows-latest | x86 | TCG | 300 min (90 with `tcg-smoke`/`test-filter`) |

Every platform runs the **full suite by default** — TCG legs included (that is the
"find out where windows/mac break" path). `tcg-smoke=true` is the only thing that
narrows a leg implicitly, and it is opt-in.

**`test-filter` for agent iteration**: when debugging a specific arm64 failure, dispatch `platforms=linux-arm64` with `test-filter=exec.test.ts` to skip the 40-minute full suite and get results in ~5 minutes.

**Full-platform "find out" run** (the pre-release checkpoint — where do windows/mac
stand on the whole suite?):

```bash
gh workflow run integration.yml -f platforms=all
```

That is full suite + examples + metrics on all five platforms; expect the TCG legs to
take hours. Red legs are the answer, not a problem with the run.

**The examples smoke harness** (`test/integration/examples-smoke.test.ts`) runs a curated subset of runnable examples end-to-end — one representative per language *for the current OS* (`.ts` everywhere; `.sh`/`.py`-via-`uv` on POSIX; `.ps1` on Windows) — plus an intentional failure-path case that asserts teardown fires on error. `trial-license` is excluded (MikroTik rate-limits). Double-gated by `QUICKCHR_INTEGRATION` + `EXAMPLES_SMOKE` so the integration jobs don't pay for example boots; the `examples-smoke` job sets both via `bun run smoke:examples`.

**Each matrix leg's target** is exported as `QUICKCHR_TEST_TARGET` and consumed by
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

Each matrix leg boots its target (default `stable`) for its native arch — the
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
  - `integration.yml` dispatches: `integration-logs-{linux-x86|linux-arm64|macos-arm64|macos-x86|windows-x86}`
  - `main.yml` runs: `main-logs-{linux-x86|linux-arm64}`; `sweep.yml` runs: `sweep-logs-<platform>` (the `artifact-prefix` call input)
  - `integration-output.txt` — full `bun test` output including error messages
  - `integration-timing.txt` — per-file wall-clock seconds + pass/fail (integration.yml only)
  - `machines/**/*.json` — `machine.json` with last-known state, ports, config
  - `machines/**/*.log` — `qemu.log` with QEMU stdout/stderr (boot messages, panics)
- **Step summary**: `integration.yml` shows failing lines + per-file timing + boot-timing table (full log in the artifact)

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
# mirrors the integration.yml `routeros-targets` dispatch input:
QUICKCHR_TEST_TARGET=long-term QUICKCHR_INTEGRATION=1 bun test test/integration/

# Release (one-click, runs in CI — see "Release Process"):
gh workflow run release.yml -f version-bump=patch
```

## CHR Image Caching

Downloaded RouterOS images are cached in `~/.local/share/quickchr/cache/`
using `actions/cache` with key `chr-images-{OS}-{arch}-v1`.

Cache misses cause a fresh download (~50-100 MB).  Bump the `-v1` suffix if the
cache needs to be invalidated (e.g. corrupted image from a partial download).

## Adding a New Runner

1. Add a row to the `plan` job's platform table in `integration.yml` (id, label, runner,
   tcg) and a conditional `Install QEMU + tools` step if the OS needs a new
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
4. Decide where the new platform runs regularly: add it to `sweep.yml`'s weekly `all`
   alias coverage (automatic once it's in the plan table) and, only if it is fast and
   KVM/HVF-reliable, to `main.yml`'s per-push platform list.

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
