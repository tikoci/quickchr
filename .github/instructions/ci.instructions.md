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

The repo has several workflows, each with a distinct purpose:

| Workflow | File | Trigger | Purpose |
|----------|------|---------|---------|
| **CI** | `ci.yml` | push/PR to `main`, `workflow_dispatch` | Fast quality gate (~3-5 min, no QEMU): lint, unit, Windows unit, PR freshness gate |
| **Main Integration** | `main.yml` | push to `main`, `workflow_dispatch` | The continuous integration-test signal: full suite on linux/x86_64 + linux/aarch64 |
| **Weekly Sweep** | `sweep.yml` | schedule (Mon 05:37 UTC), `workflow_dispatch` | All-platform sweep + examples smoke (separate file so a red TCG leg never blocks PRs) |
| **Integration** | `integration.yml` | `workflow_dispatch`, `workflow_call` | THE reusable integration unit — any platform × RouterOS target × test filter |
| **PowerShell Lint** | `lint-powershell.yml` | push/PR touching `examples/**/*.ps1` or `PSScriptAnalyzerSettings.psd1`, `workflow_call` | PSScriptAnalyzer over the `.ps1` example mirrors |
| **Release** | `release.yml` | `workflow_dispatch` only | One-click gate → tag/GitHub Release → npm publish from committed `package.json` |
| **RouterOS Versions** | `ros-versions.yml` | schedule (daily 04:17 UTC), `workflow_dispatch` | New-version check → dispatches integration on never-tested versions |
| **Lab** | `lab.yml` | `workflow_dispatch` (pick a lab or `all`), push touching `test/lab/**` | One job per `test/lab/*` grounding experiment that needs a real CI toolchain (e.g. host-OS OpenSSH/OpenSSL defaults). **Non-gating, must NOT be a required check** — findings go to the job summary + artifact and are written up in the lab's REPORT.md. Add a lab job per the framework header in the file |

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

One-click `workflow_dispatch` after the version/changelog commit has already landed on
`main` — no tag pushing by hand, no suite re-run, and no CI push back to `main`:

```text
prepare (gate: main-only + Integration freshness green
         + package.json version has a non-empty CHANGELOG section
         + tag/GitHub Release/npm version unused
         → unit re-check → tag+GitHub Release)
  → publish (npm publish --provenance, dist-tag from odd/even minor)
```

The integration bar is the freshness gate: the latest completed `main.yml` run on `main`
must be green — the same full x86+arm64 suite the old publish pipeline re-ran, but paid
continuously on every push instead of at release time (arm64 gate lineage: #15/#16).

`package.json` is the source of truth. CI reads it, extracts release notes from the
matching `CHANGELOG.md` section via `scripts/release-prep.ts --from-package`, and never
updates tracked files. For a bugfix release, bump `package.json` and promote
`CHANGELOG.md` in the PR before dispatching `release.yml`.

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
gh workflow run release.yml -f dry-run=true # preview package.json version
gh workflow run release.yml                 # release package.json version
```

`release.yml` (`workflow_dispatch` only, main-only) publishes the committed version:
1. **Gates**: latest `main.yml` integration run green (freshness — no suite re-run) and
   `CHANGELOG.md` has a non-empty `## [X.Y.Z]` section matching `package.json`. Plus a
   quick `bun test test/unit/` and checks that the tag, GitHub Release, and npm version
   are unused.
2. **Tag/release**: create `vX.Y.Z` and the GitHub Release from the current main commit
   (notes = the changelog section).
3. **Publish**: `npm publish --provenance` from the tag.

**Pre-release vs stable** (from version minor — pick the version accordingly):
- `0.1.x`, `0.3.x` — odd minor → `npm tag: next` (pre-release, GitHub Release marked pre-release)
- `0.2.x`, `0.4.x` — even minor → `npm tag: latest` (stable release)

**Dry run** (`dry-run: true`): every gate and the version/notes computation run; nothing
is tagged or published.

**Required secret**: `NPM_TOKEN` — npm automation token with publish access to `@tikoci/quickchr`.

**Main is always release-able**: that is the point of the freshness gate + squash-only
PRs. If the gate blocks a release, fix `main` — do not bypass the gate. Release CI must
not bump versions or push to protected `main`.

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
| `qemu-version` | string | "" | **Experiment lever, Linux only.** Build that upstream QEMU from source and put it first on `PATH` instead of the distro package. Empty = distro. See "Experiment levers" below. |
| `accel` | string | "" | **Experiment lever.** Pin `QUICKCHR_ACCEL` (`tcg`/`kvm`/`hvf`/`auto`) instead of letting `detectAccel()` choose. Empty = auto-detect. |

(`workflow_call` adds `artifact-prefix` so parallel callers don't collide on artifact names.)

**Platform table** (one row per matrix leg; the `plan` job owns this mapping):

| Platform id | Runner | CHR arch | Accel | Full-suite timeout |
|-------------|--------|----------|-------|--------------------|
| `linux-x86` | ubuntu-latest | x86 | KVM | 60 min |
| `linux-arm64` | ubuntu-24.04-arm | arm64 | KVM if available; hosted runners may fall back to TCG | 60 min |
| `macos-arm64` | macos-15 | arm64 | **TCG** | 60 min |
| `macos-x86` | macos-15-intel | x86 | **HVF** | 300 min (90 with `tcg-smoke`/`test-filter`) |
| `windows-x86` | windows-latest | x86 | TCG | 300 min (90 with `tcg-smoke`/`test-filter`) |

The two bold cells read HVF and TCG respectively until 2026-07-30; both were wrong
and the `plan` job's own table already disagreed. `macos-arm64` is a hosted VM
reporting `kern.hv_support=0`, and quickchr forces TCG for both guest arches on
Apple Silicon anyway (#97) — a green `macos-arm64` leg is **not** evidence about
the HVF path. `macos-x86` is bare metal and `detectAccel()` returns `hvf` there;
its extended timeout is about #76, not about its accelerator. A source-built
QEMU (`qemu-version`) adds **+20 min** to the affected leg's job budget; the test
step's own cap is deliberately left unchanged.

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

## Experiment levers (`qemu-version`, `accel`)

Two dispatch inputs exist so a **controlled contrast** can vary one factor and hold
everything else — same tests, same forensics, same artifacts, so two dispatches are
actually comparable. Both are inert when empty, which is every normal run; nothing in
`main.yml`, `sweep.yml` or `release.yml` sets them, and they are not part of the
release gate.

**`qemu-version`** downloads `https://download.qemu.org/qemu-<version>.tar.xz`, builds
it, and prepends `$HOME/qemu-<version>/bin` to `PATH`. What it deliberately does **not**
replace:

- **`qemu-img`** — `--disable-tools` keeps the distro one, so image tooling can never be
  blamed for a flip in the result. Only the system emulator changes.
- **UEFI firmware** — `findEfiFirmware()` reads `/usr/share`, so `qemu-efi-aarch64` stays
  the distro build.

`--enable-slirp` is mandatory, not decorative: quickchr's whole host↔guest path is SLiRP
user networking plus hostfwd, and QEMU has required external `libslirp` since 7.2. The
step verifies `-netdev help` lists `user` and **fails the leg** if it doesn't — a
slirp-less QEMU would produce a "REST never came up" failure indistinguishable from the
bug under investigation.

The build is **not** cached. The repo cache is already over its 10 GB cap (#104), and a
build tree would evict the CHR images these legs depend on. Revisit once #104/B3 lands.

Constraints, all enforced in the `plan` job so a mistake costs no runner minutes:

- version must look like `8.2.2` / `11.0.2` (it goes into a URL);
- Linux platforms only — accepting it on macOS/Windows would run the **distro** QEMU
  under a run labelled with a version it never used;
- `accel` must be one of `auto`/`tcg`/`hvf`/`kvm`.

**`accel`** pins `QUICKCHR_ACCEL` via `GITHUB_ENV`, not job-level `env:` — an empty
`QUICKCHR_ACCEL` is *defined* to the process and `parseAccelMode("")` throws
`INVALID_SETTING_VALUE`, so the unset default has to stay genuinely unset. Use it when a
contrast could otherwise differ in the accelerator: the Linux legs fall back to TCG
depending on whether the runner ships a writable `/dev/kvm`, which is acceptable noise
in a normal run and fatal to an experiment. When pinned, the platform log says so
explicitly instead of printing the "no writable /dev/kvm" fallback notice.

Worked example — the #79 QEMU-version contrast (B9 of #110), two dispatches differing
in one input:

```bash
# arm A — reproduce the known-failing configuration
gh workflow run integration.yml --ref <branch> \
  -f platforms=linux-arm64 -f routeros-targets=7.21.5 \
  -f test-filter=start-stop.test.ts -f run-examples=false -f accel=tcg

# arm B — same everything, newer emulator
gh workflow run integration.yml --ref <branch> \
  -f platforms=linux-arm64 -f routeros-targets=7.21.5 \
  -f test-filter=start-stop.test.ts -f run-examples=false -f accel=tcg \
  -f qemu-version=11.0.2
```

Pin the RouterOS **version**, not the channel, in any contrast that spans days —
`long-term` moves, and a moved channel silently varies a second factor.

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
  - `platform-info.txt` — matrix id, runner arch, process arch, CPU model/count, memory, QEMU versions, `/dev/kvm` state, quickchr accel detection, and Linux KVM open probe
  - `integration-output.txt` — full `bun test` output including error messages
  - `integration-timing.txt` — per-file wall-clock seconds + pass/fail (integration.yml only)
  - `issue69-*.ndjson` — only when `issue69-settling.probe.ts` is dispatched; per-iteration port probes, REST probe attempts/retries, QEMU load, and console diagnostics
  - `machines/**/*.json` — `machine.json` with last-known state, ports, config
  - `machines/**/*.log` — `qemu.log` with QEMU stdout/stderr (boot messages, panics), plus `serial.log` (the guest console tee — CI sets `QUICKCHR_SERIAL_LOG=1`)
  - **These POSIX paths only reach the artifact because the step sets `include-hidden-files: true`** — `~/.local/share/…` is a dot path and `upload-artifact` drops hidden files by default. If you add an artifact step touching the POSIX data root, set it, or the upload silently ships nothing (`if-no-files-found: warn` will not save you — the non-hidden `~/*.txt` files still match).
  - `failures/boot-failure-<machine>-<iso8601>.json` — **start here for any `BOOT_TIMEOUT`**. Self-contained: REST-probe tally, per-port slirp classification (`forwardProbe`), the guest-side serial snapshot (`guest`), the counting-rule verdict (`countingRule`, deep diagnostics only), hostfwd TCP probe, monitor `info status`/`info block`/`info usernet`, QEMU liveness + argv, machine-dir listing, and the full `qemu.log`/`serial.log` text. Written under `<dataDir>/failures/`, outside the machine dir, so the test's own `finally { cleanupMachine() }` can't delete it
- **Step summary**: `integration.yml` shows failing lines + per-file timing + boot-timing table (full log in the artifact)

### Boot failure diagnosis checklist
0. Open `failures/boot-failure-*.json` first — it answers steps 1-3 in one file. The
   decisive field is `restProbe`. Read it with the slirp caveat below in mind:
   - `probe-timeout` on every attempt + `hostfwd.tcpConnect: "accepting"` → QEMU is
     forwarding but nothing behind it answers. **Guest-side.** Read `serialLog` next.
     This is the ordinary shape of a CHR that never finished booting.
   - `refused` → QEMU itself is gone or never bound the port. Host-side; check
     `host.qemuProcess` and `qemuArgs`.
   - `reset`, or `firstHttpAtMs` set but never `ready` → the guest answered at TCP
     and then dropped or returned the wrong body. RouterOS is mid-startup; this is
     the #69 settling signature, not a dead boot.
   - `monitor["info status"]` reporting `paused` (especially `paused (io-error)`)
     is a disk/backing-file answer on its own — stop looking at timeouts.

   `forwardProbe.ports` is the decisive follow-up when the guest looks up but is
   unreachable. It probes every forwarded TCP port and classifies each from
   slirp's own table (`monitor["info usernet"]` holds the pre-probe raw dump,
   `forwardProbe.usernetAfterProbe` the one the table was read from):

   - `dropped` (`TCP[SYN_SENT]` persisting against `10.0.2.15:<port>`) → the SYNs
     are being **silently dropped**. **This does not say by whom** — measured
     locally, a guest that received all 20 SYNs and dropped them itself produced
     the same table as one that never saw them. Read `countingRule` next.
   - `refused` (no row at all) → the guest **RST'd**: nothing listening on that
     port, but the guest is alive.
   - `served` → the connection completed; that service is fine.
   - `not-forwarded` → QEMU never bound that forward. Host-side.

   **Every port `dropped` points at the guest RX path; one dropped port beside
   healthy ones is service-specific.** (#79 shows all-but-`http` healthy.)

   Then, in order:

   - `guest.consoleReachable: true` → RouterOS is alive and answering over serial
     while REST is dead. `guest.entries` carries `/log` (DHCP churn — a `lost IP
     address`/`got IP address` pair means a link flap; a single `got` means none),
     `/ip/address`, `/ip/service`, `/ip/firewall/filter` (expected `[]` on a fresh
     CHR), `/interface` stats, conntrack, `/system/resource`.
   - `countingRule.verdict` (deep diagnostics only) — `guest-received` = the SYNs
     arrive and RouterOS drops them; `not-delivered` = they never reach RouterOS,
     so the drop is in the slirp/virtio RX path.
   - a `UDP` row sourced from `10.0.2.15` (RouterOS's own MNDP on 5678) proves
     the guest has its address and its NIC is live — check for it before blaming
     DHCP. `HOST_FORWARD` rows only, with no traffic from `10.0.2.15` anywhere,
     is the shape of a guest that never took its DHCP address.

   All of these present to the REST probe identically, as `probe-timeout`.

   **slirp caveat (verified locally, 2026-07-27).** With the default `user` network
   mode, QEMU's hostfwd `listen()`s on the host port for the whole life of the
   process and accepts connections regardless of guest state — it only then tries to
   reach the guest. So a totally dead guest still shows `hostfwd: accepting`, and its
   probes classify as `probe-timeout`, never `refused`. Repro: `QuickCHR.start({ mem:
   32 })` (too little RAM for CHR) → 72/72 `probe-timeout`, `hostfwd: accepting`,
   `info status: running`, empty `serial.log`. Do **not** read "accepting" as
   evidence the guest is up.
1. Open `qemu.log` from the artifact — look for `Panic`, `Error`, `EFI` failures
2. Check `platform-info.txt` — verify runner/process arch, CPU/memory, QEMU version, `/dev/kvm`, and whether the KVM open probe failed
3. Check `machine.json` — verify `status`, `arch`, `ports`, `version`, `lastAccel`, and `lastBootMs` fields
4. Check `integration-output.txt` — find the specific test that timed out or errored
5. Look for `::notice::KVM not available` and `KVM open probe` in logs — TCG is significantly slower than KVM/HVF and per-probe HTTP timeouts may need to be larger

### Common failure signatures
| Symptom | Likely cause | Where to look |
|---------|-------------|---------------|
| `waitForBoot` timeout | TCG slowness or boot stall — check serial log to distinguish | `failures/boot-failure-*.json` → `restProbe`, then `serialLog` |
| `Monitor command timed out … connect=… prompt=… command-written=…` | Read the phase line: `prompt=never` = the monitor never greeted us; `command-written=<n>ms response-first-byte=never` = QEMU took the command and went quiet (#80) | the error message itself |
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
gh workflow run release.yml
```

## CHR Image Caching

Downloaded RouterOS images are cached in `~/.local/share/quickchr/cache/` using
`actions/cache` with key
`chr-images-{OS}-{arch}-v2-{target}-{int|ex}-{run_id}-{run_attempt}` and
`restore-keys` falling back to `…-v2-{target}-` then `…-v2-`.

**The primary key must keep a rotating component.** `actions/cache` skips the
post-job save whenever the primary key hit exactly, so the previous static
`chr-images-{OS}-{arch}-v1` key meant any RouterOS version resolved *after* the
cache was first populated re-downloaded on every single run, forever (#91). The
`{run_id}-{run_attempt}` tail guarantees a miss, so every run re-saves; the
`{int|ex}` segment keeps the integration and examples-smoke jobs from colliding
on one key within a run. Old entries age out under the repo's cache LRU cap.

Cache misses cause a fresh download (~50-100 MB). Bump `-v2` to invalidate
wholesale (e.g. a corrupted image from a partial download).

**A cache miss is large enough to dominate a timing measurement, so treat cold
download as a confound in any per-file comparison.** Measured locally on
2026-07-31 (`test/lab/full-suite-resource-trend/REPORT.md`, B7 of #110):
`provisioning.test.ts` ran **992 s against 502 s for the same file on
`windows-x86` CI (1.98×)** purely because its version-pinned 7.20.7/7.20.8
images were uncached — **619 s of those 992 s (62%) elapsed with zero QEMU
processes running**, and both images needed two retries before succeeding.
Excluding the download leaves 373 s of VM work, 0.74×, in line with every other
file in the suite.

Two consequences:

- **Do not read a slow file as a slow file** without checking whether it was
  downloading. The cheap discriminator is whether any `qemu-system` process was
  alive; that single check is what kept the above from being misread as
  cumulative resource leakage on the very file where such a story was expected.
- **Timing data collected while cache keys still rotate per run carries this
  variance**, which is why #104's key redesign gates #106's sample collection.

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
