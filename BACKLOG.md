# quickchr Backlog

> Open work and design questions live below. Completed items are collapsed — full notes are in git history, MANUAL.md, DESIGN.md, or `.github/instructions/*.md`.
>
> Open items are tagged [P1]–[P4]. Last review pass: 2026-05-31.

## Priority tags

- **P1** — unblocks other work or removes active agent/customer friction; take next
- **P2** — active improvement with clear shape
- **P3** — research / investigation (needs grounding before implementation)
- **P4** — examples, polish, follow-ups
- **[?]** — flagged as needing clarification from the user before actionable

---

## Completed

<details>
<summary>P0 — MVP</summary>

- [x] Core library modules, QuickCHR API, ChrInstance, CLI subcommands, wizard, unit tests, integration scaffolds

</details>

<details>
<summary>P1 — Robustness</summary>

- [x] Foreground/background modes, package provisioning (sshpass), arch-specific packages, `--all` flags
- [x] Interactive selectors removed (replaced by shell completions), boot timeout scaling, port probing
- [x] Dynamic package list via `all_packages.zip`, integration test coverage (provisioning, packages)
- [x] `start()` respawns QEMU once on a wedged nested-KVM/HVF boot (BOOT_TIMEOUT recovery) — a single stuck boot among many on CI runners no longer fails the run; gated to hardware accel (TCG boots are legitimately long). `cleanupQemuSockets` helper, anchor tests, integration ceilings 240s→360s

</details>

<details>
<summary>CI & Publish</summary>

- [x] Core x86 CI + extended platform dispatch, coverage 79.59% funcs / 67.86% lines (above thresholds)
- [x] Artifacts (coverage-report 14d, integration-logs 7d), `publish.yml` gating
- [x] Resilient downloads with a public-DNS failback — `fetchResilient()` (`src/lib/net.ts`) wraps all `upgrade`/`download.mikrotik.com` fetches (versions, images, packages). Logic: a normal `fetch` (system resolver, dual-stack) is the primary path; **only** on a connection-class error does it fail back to resolving the A record via a `dns.Resolver` with public servers (1.1.1.1/8.8.8.8/1.0.0.1, 3 s timeout) and connecting to the IPv4 literal with `Host` + TLS SNI preserved. Generic resilience to a misconfigured/transient resolver — not a CI-specific patch. Motivating incident (on-runner probe 2026-06-16): GitHub-hosted runners' system resolver returned `ESERVFAIL` (slowly, 2–26 s) for `*.mikrotik.com` via both getaddrinfo and c-ares-over-resolv.conf; a direct public-DNS query answered in ~10 ms — deeper root cause still unknown. Means consuming projects (e.g. centrs) need no `/etc/hosts` workaround. The "IPv6 happy-eyeballs" theory was a red herring. (Originally shipped public-DNS-first; reversed to normal-first so local DNS is honored and no new failure modes are introduced off-CI.) See DESIGN.md decision #9; `test/unit/net.test.ts`
- [x] **Extended Verification + security hardening (2026-06-21)** — Triaged the post-0.4.2 Extended Verification reds (run 27919557586): both x86_64 failures were CI-harness, not product. **Windows** integration passed (6/6); only `upload-artifact@v6` failed on a cross-drive least-common-ancestor (state dir on `C:\…\AppData` vs workspace on `D:\`) → fixed by writing `integration-output.txt` under `$HOME`. **macOS-x86** lost runner communication near 60 min (TCG starvation, no HVF on hosted runners) → marked `continue-on-error` + job timeout, relabeled best-effort/non-gating. All workflows now declare least-privilege `permissions: contents: read` (publish job keeps `id-token: write`). Closed the 5 AI-findings autofix PRs (#5–#9 — test/example/lab-only, partly stale vs merged 0.4.2) and folded in the sound bits: the lab MNDP `js/tainted-format-string` fix + `udpLen >= 8` guard (#6), tightened `qemu-args` anchors (#8), empty-body `resolveVersion` test (#9). Dismissed 8 by-design `js/clear-text-logging` CLI-credential alerts (1 of them — line 1715 — a true false positive).
- [x] **arm64 integration as a release gate (2026-06-24)** — After the arm64 fixes landed (#15: `clean()` EFI-vars fix + un-skipped exec tests, all green on `ubuntu-24.04-arm`/KVM), `publish.yml` gained an `integration-arm64` job running in parallel with `integration-x86`; both now gate `windows-unit-tests` → `publish`. So a release can't publish unless the full integration suite passes on **both** linux/x86_64 and linux/aarch64. Validated via `workflow_dispatch` dry-run before the next patch (0.4.3).
- [x] **version/channel selection in Extended Verification (2026-06-24)** — `verify-extended.yml` gained a `routeros-target` dispatch input (a channel `stable`/`long-term`/`testing`/`development` **or** a pinned version like `7.22.1`/`7.24beta2`; empty = stable) plus a selectable `linux-x86` job, so the arm64/macOS/Windows/x86 integration paths can be exercised against a chosen RouterOS release instead of only stable. Motivation: the #15/#16 arm64 fixes were only ever verified on stable. Mechanism: the input is exported as `QUICKCHR_TEST_TARGET` and read by `test/integration/image-target.ts` (`imageTarget()` → `{channel}` for a channel name, else `{version}`, default stable); the 27 hardcoded `channel: "stable"` integration starts now spread `...imageTarget()`. Version-pinned tests (provisioning `7.20.7`/`7.20.8`, library-api `7.22.1`) are untouched. `ci.yml`/`publish.yml` unchanged (always stable). Docs aligned in `ci.instructions.md` (incl. the stale publish-pipeline diagram that omitted the arm64 gate) + `testing.instructions.md` + README env-var table.

</details>

<details>
<summary>Wizard / CLI UX</summary>

- [x] Shell completions (bash/zsh/fish) context-aware machine names (`f7ca662`)
- [x] Wizard main-menu loop, `Back` navigation, snapshot UX (qcow2 guard, 16-item cap)
- [x] Disk management (`--boot-size`, `--add-disk`), credentials in status, orphaned-dir cleanup (`a1fa7c3`)

</details>

<details>
<summary>Networking discoverability + UDP ranges (issue #18, 2026-06-25)</summary>

- [x] **UDP port-range forwarding** — `--forward name:hostStart-hostEnd[:guest…][/proto]`; new `expandForwardSpec()`/`FORWARD_RANGE_MAX` exports, `parseForwardSpec()` unchanged (additive, non-breaking). Explicit-host-only, 64-port cap (DESIGN.md). Closes the issue #18 range-forward ask.
- [x] **Guest→host UDP gateway recipe** — verified that guest-originated UDP to `10.0.2.2:<port>` reaches an *unconnected* host loopback socket with no forward (`test/lab/gateway-udp/REPORT.md`); generalizes `tzspGatewayIp` beyond TZSP. Runnable example `examples/udp-gateway/`. This closed centrs' btest UDP-coverage gap (centrs#88) with **no new feature** — it was discoverability.
- [x] **`docs/networking-recipes.md`** — by-goal "traffic shape → mechanism" decision guide; linked from README, MANUAL §7/§4/§15, `docs/mndp.md`.
- [x] **JSDoc parity** — `StartOptions.networks`/`extraPorts`, `NetworkSpecifier`, `PortMapping`, `tzspGatewayIp` now map specifiers/forwards to goals and note CLI↔library equivalence. Aligned `qemu.instructions.md` + DESIGN.md. (Agent-skill propagation deferred — see LLM & Agent Friendliness § open work.)

</details>

<details>
<summary>Examples rework — runnable scripts + durable convention (2026-06-26)</summary>

- [x] **New convention:** examples are runnable `bun run` scripts (`<name>.ts` + `.sh`/`.ps1`/`.py`), not `bun:test`. `grounding/` kept + expanded as the sole `bun:test` reference (lifecycle + matcher patterns). Shared infra: `examples/lib.ts` (`runExample` guaranteed-teardown / `exampleMachineName` / `freePort` / `check`), `examples/common.sh` + `common.ps1` (POSIX/PowerShell `$QUICKCHR` resolution + naming + cleanup), `examples/_template/`. Convention captured in `.github/instructions/examples.instructions.md`; coverage map `examples/COVERAGE.md`.
- [x] **Renames:** `vienk`→`quickstart`, `matrica`→`version-matrix`. Makefiles deleted (mndp, matrica). Python switched to `uv run`; `child.ts`→`harness/tool/`; `rb5009-arm64.rsc`→`version-matrix/config/`.
- [x] **Five new single-concept examples:** `rollback` (snapshot save/load), `service-forward` (`--forward`/extraPorts), `file-transfer` (upload/download), `device-mode`, `trial-license` (manual-only). All ship `.sh`+`.ps1`; deterministic `examples-<name>-<unique>` naming; auto-allocated/`freePort` host ports.
- [x] **dude arch correction:** the "x86-only" claim was **wrong** — `dude-<ver>-arm64.npk` ships for 7.21.1–7.23.1 and `src/lib/packages.ts findPackageFile()` resolves it. Removed the `process.arch==="arm64"` skip + `arch:"x86"` pin; `dude.ts` now arch-auto.
- [x] **CI-checkable:** `bun run check` adds `lint:examples` (validator) + `lint:shell` (shellcheck `-s sh`); biome now includes `examples/**`. Extended verification gains `include-examples`/`example-filter` inputs → `examples-smoke` job (curated subset + one representative per language + an intentional failure-path case asserting teardown) and a `lint-powershell` job (PSScriptAnalyzer). `trial-license` excluded from CI (MikroTik rate limits).
- [x] **CI hardening (PR #22 review pass, 2026-06-26):** examples smoke is now a **platform matrix** mirroring integration — `verify-extended.yml` replaces `include-examples` with mode toggles `run-integration`/`run-examples`; a `plan-smoke` job emits the smoke matrix from the platform toggles, so one dispatch runs integration and/or smoke across the chosen OSes against a chosen `routeros-target`. **A broken example gates** the workflow on KVM/HVF platforms (TCG stays informational). The harness picks per-OS representatives (`.ts` everywhere, `.sh`/`.py`-via-`uv` on POSIX, `.ps1` on Windows), runs Python via `uv run`, and **fails fast on a typo'd `EXAMPLE_FILTER`**. PowerShell `.ps1` made ASCII-clean + `examples/PSScriptAnalyzerSettings.psd1` (waives `PSAvoidUsingWriteHost` for interactive demos, with rationale); `Invoke-Qc` now fails on non-zero native exits. `ci.yml` Repo Checks installs shellcheck so `lint:shell` actually enforces POSIX-sh on every push.
- [x] **PR #22 close-out (2026-06-26):** fixed CodeQL `js/insecure-randomness` by replacing `Math.random()` with `crypto.randomUUID()` in the example helpers (`examples/lib.ts`, `examples/grounding/grounding.test.ts`); the taint flowed through example-built machine names into credential sinks. Fixed a latent unit-test bug (`qemu-args.test.ts` "x86 HVF uses host CPU model") that only surfaced on KVM runners — KVM, like HVF, adds `-cpu host`, so the `else` branch's `cpuIdx == -1` assertion was wrong; it never ran on a KVM runner in normal CI (unit job has no KVM; integration job doesn't run `test/unit/`). Fixed PowerShell `PSUseUsingScopeModifierInNewRunspaces` in `version-matrix.ps1` (switched `Start-Job` from `param()`+`-ArgumentList` to `$using:`). **Removed the standalone `coverage` job** (it re-ran the whole suite) — reworking coverage as a byproduct of the integration jobs is tracked in #30. Opened follow-ups: #26 (rename `tzspGatewayIp`), #27 (troubleshooting capture example), #28 (PowerShell workflow org), #29 (release/verification reuse), #30 (coverage byproduct).
- [x] **PR #22 close-out, round 2 (2026-06-27):** post-merge Extended Verification turned up two more reds. (1) **PowerShell lint** — the `$using:` fix introduced a non-ASCII em-dash in a comment, tripping `PSUseBOMForUnicodeEncodedFile` (the rule the settings file documents as the ASCII-clean guard); made `version-matrix.ps1` ASCII-clean again. Also **closed #28**: extracted the PSScriptAnalyzer job into a dedicated reusable `lint-powershell.yml` that runs on its own for `examples/**/*.ps1` push/PR changes (early signal) and is `uses:`-d by `verify-extended.yml` (dispatch path still covered). (2) **arm64 rollback smoke** — `rollback` failed on macos/arm64 + linux/aarch64 while passing on every x86 accelerator. Root cause: QEMU internal `savevm`/`loadvm` snapshots don't restore a working aarch64 `virt` CHR (`loadvm` returns clean, guest wedges, REST never returns). Gated the example to `arch: ["x64"]` in the smoke matrix (new `arch` field mirroring the existing `os` gate); documented in `DESIGN.md` + the snapshot API docs + the example header; tracked the real fix in #31.

</details>

---

## Open Work

### Robustness & Testing — Agent-Ready Work (curated 2026-05-30)

This is an **index into the items below**, not new work. It groups the highest-leverage
robustness/testing items by whether an autonomous agent (`/fleet` or a subagent) can take
them, and what shape that work has. `[research]` = produces a repro/report/grounding doc;
`[implement]` = clear enough to land code + tests; `[test]` = add coverage to existing code.
Each lists a concrete **done-when** so an agent knows when to stop.

**`[research]` — self-contained investigations (good `/fleet` / subagent tasks):**

- **arm64 REST "POST returns prior GET" — could not reproduce; CLOSED** [done] — Lab repro
  (`test/lab/arm64-rest-ordering/repro.test.ts`) on RouterOS 7.23.1 / Bun 1.3.14 / arm64 KVM
  did **not** reproduce the stale-response: the POST returned its own response, never the
  prior GET's body (Scenario A `POST===GET: false`; Scenario D 0/10). Likely an already-fixed
  Bun issue (report predates a Bun bump). First run also caught a *repro bug* — POSTed
  `{".command":...}` (HTTP 400) instead of the real exec contract `{script, "as-string":true}`
  (exec.ts:54); fixed. Un-skipped the 2 arm64 `exec.test.ts` tests — **both pass on arm64 CI**
  (run 28111921441). The speculative `restGet()` socket-close wait was **removed** — Scenario A
  passes with a plain (no-wait) GET→POST, so the wait was unneeded defensive code.
- **arm64 `clean()` second-boot timeout** [P3] — **Fixed + confirmed on CI.** Root cause:
  `clean()` deleted `efi-vars.fd`, forcing UEFI to do a full device scan (~480s) on next boot.
  EFI vars only store boot order (not OS state), so deletion was wrong. Removed the delete from
  `clean()` (`src/lib/quickchr.ts`); skip removed from the integration test. Verified on
  `ubuntu-24.04-arm` (run 28109632411): `clean()` test passes in ~106s (was 480s timeout).
- **x86 QGA-under-HVF hypothesis test** [P3] — Confirm whether RouterOS restricts QGA
  activation to `/dev/kvm` (guest never opens the virtio-serial port under HVF). Compare
  KVM vs HVF on the same RouterOS version. *Done-when:* `docs/qga-x86-macos-qemu10-investigation.md`
  updated with a KVM-vs-HVF result and a verdict on whether any local workaround exists.
- **Error-diagnostics labs** [P2] — Induce the 3–5 highest-signal error codes (`MISSING_QEMU`,
  `PORT_CONFLICT`, `DOWNLOAD_FAILED`, `BOOT_TIMEOUT`, `SPAWN_FAILED`) and capture current
  output. *Done-when:* a `test/lab/errors/REPORT.md` with the real message/exit shape per code
  — the grounding the "LLM-actionable error diagnostics" item is blocked on.
- **`exec()` soft-error corpus** [P2] — Collect 5–10 real RouterOS HTTP-200-with-error-string
  outputs (e.g. `/dude/agent/add`). *Done-when:* a documented corpus so a future
  `throwOnCliError` / `isRouterOSError()` regex is grounded, not guessed.
- **REST timeout contract reconciliation (centrs ↔ quickchr)** [P2] — centrs records a
  RouterOS REST 60s ceiling for `via=rest-api`, while quickchr has lab rules for blocking
  endpoints (`device-mode/update`, `license/renew`) and uses longer host-side safety timers.
  *Done-when:* one lab report maps the effective RouterOS/HTTP behavior for normal REST,
  `/rest/execute`, `/console/inspect`, `license/renew`, and `device-mode/update`; update
  `.github/instructions/routeros-rest.instructions.md` and any code timeouts from evidence.

**`[implement]` — clear shape, an agent can land code + tests:**

- **Centralize error-message + logging surface** [P4] — single `code → format` source so
  strings stop drifting across CLI/wizard/library. *Done-when:* one module owns the strings,
  call sites import it, a unit test asserts every `ErrorCode` has a format entry.
- **Wizard storage preflight** [P2] — disk-free / `qemu-img` / socket_vmnet / port-block
  checks before start, wired into the same error-handling tests as the CLI path.
- **Integration evidence/report hook for centrs** [P2] — centrs currently wraps
  `QuickCHR.start()` and `subprocessEnv()` in `test/integration/chr.ts`, then writes its own
  JSONL/GitHub summary record. *Done-when:* quickchr exposes a stable run-summary helper or
  CLI JSON shape with machine name, requested version/channel, actual RouterOS version/board,
  ports, and redacted auth so centrs and future consumers stop hand-rolling evidence records.

**`[test]` — coverage for already-shipped code (mechanical, low-risk subagent work):**

- **Lift the sub-70% modules** — as of the 2026-05-30 review, `qemu.ts` (69.81%) remained
  the next candidate after focused `rest.ts`, `packages.ts`, `device-mode.ts`, and `platform.ts`
  coverage was added. Add unit tests that
  prove *correctness of uncovered paths* (use the `createServer` mock pattern from
  `license.test.ts` for REST-shaped modules). *Done-when:* each module's uncovered
  branches that encode real behavior have a test; don't chase the percentage for its own sake.
- **Cross-platform validation passes** [P3] — Linux-host bundle workflow; `completions
  --install` on bash + fish; `qemu-img` + `--boot-size` on Linux. *Done-when:* each runs
  green on the target host and the result is noted in the relevant item below.
- **centrs L2 lab feasibility** [P3] — centrs needs mac-telnet validation on an L2 segment;
  its current `startIntegrationChr()` uses user-mode SLiRP/hostfwd, which cannot carry L2
  broadcast/MAC-Telnet. *Done-when:* a quickchr + centrs spike proves one repeatable host
  topology (Linux TAP/socket or macOS socket_vmnet/vmnet) and documents what native helper
  is still needed for raw-L2 frame I/O.
  **Partly answered (2026-06-06, MNDP spike):** the repeatable rootless host topology is
  `socket-connect` (host runs a TCP server, CHR connects, QEMU streams length-prefixed L2
  frames over loopback). **No native helper is needed** for raw-L2 frame I/O on macOS — the
  earlier assumption was wrong. Verified end-to-end for MNDP receive *and* L2 injection
  (refresh) on Intel Mac/QEMU 11. See `docs/mndp.md`, `examples/mndp/`, `test/lab/mndp/REPORT.md`.
  Remaining for centrs: apply the same `socket-connect` topology to MAC-Telnet's request/reply.

> **Needs a human decision before an agent starts** (do not auto-implement): the two `[?]`
> port-allocation items (port-base randomness, fixed service-block redesign) and `[?]` config
> schema rationalization. They change the persisted state/port contract; an agent can write
> the design sketch but the direction call is the maintainer's. Recommended defaults are noted
> inline at each item.

### Pre-GitHub Push (ship readiness)

**Repo hygiene:**

- [x] LICENSE file (MIT, `a8c8cad`)
- [x] Removed stale test.jpg, reconciled /index.ts (`a8c8cad`)
- [x] .gitignore cleanup (`a8c8cad`)
- [x] Bumped to 0.1.1 (`36ad135`). Per the odd/even policy, 0.1.1 is the first GitHub release. Promote to 0.2.x after CI passes on the GitHub Actions runner matrix.

**Docs:**

- [x] README.md full rewrite (`36ad135`): all commands, full flag table, port offsets corrected
- [x] Split README → CONTRIBUTING.md (`36ad135`)
- [x] CHANGELOG.md created ([0.1.1] covering all implemented features as of first GitHub push)
- [x] SECURITY.md (minimal, points to GitHub Security Advisories)
- [x] JSDoc audit on barrel + QuickCHR + StartOptions (`36ad135`)
- [x] Comment audit (no stale TODO/FIXME in src/) (`36ad135`)

**Cross-platform testing:**

- [ ] [P3] Test from Linux host (bundle workflow: `git bundle create`, `scp`, `git clone`, `bun install && QUICKCHR_INTEGRATION=1 bun test`)
- [ ] [P3] Verify `quickchr completions --install` on bash and fish (zsh tested; bash/fish untested on real shells per `f7ca662`)
- [ ] [P3] Verify `qemu-img` detection + `--boot-size` on Linux (Intel Mac tested; arm64 Linux needs KVM pass)
- [x] [P3] **Windows integration — CI data captured (2026-06-07), suite green on TCG** — the informational `integration-windows-x86` job (dispatch input `windows-x86`) ran the full suite on windows-latest/TCG (run 27097457831): **56 pass / 0 fail / 3 skip**, ~25 min. Validated on Windows: CHR boot, monitor channel +6 (`disk` savevm/loadvm), serial channel +7 (`provisioning` + serial stream), SLiRP networking + port-forward (`forward-cli`), **scp upload/download round-trip** (`file-transfer` — works without `sshpass`, so that's a non-issue), REST exec/license-read/device-mode/library-api/anchor. The "local-first" worry is resolved: standard Windows paths work. Remaining Windows follow-ups split out below (QGA, socat).
- [ ] [P3] **Windows QGA channel (+8) — unvalidated, KVM-gated not a Windows bug** — `exec.test.ts` internally skips QGA on Windows ("QGA not available on win32/x64 within 30s… requires KVM"), same as macOS/HVF. The +8 TCP-localhost channel plumbing is therefore never exercised end-to-end on CI. Either validate it on a nested-KVM Windows host/self-hosted runner, or accept it stays unit-test-only until then. Track that `+6..+8` IPC offsets don't collide with user `extraPorts` (ties into the port-allocation redesign below).
- [ ] [P3] **Windows named-socket (socat) networking — no integration coverage** — `socat` is absent on Windows and no integration test exercises the named-socket path, so it's still unvalidated there. Decide: document SLiRP/user-mode + port-forward as the supported Windows networking mode (which CI now shows works via `forward-cli`), or add a socat-equivalent. Ties into the "ship Windows networking" item below.
- [x] [P3] **arm64 `clean()` second-boot timeout** — **Fixed + confirmed on CI** (run 28109632411: clean() test ~106s, was 480s timeout). Root cause: `clean()` deleted `efi-vars.fd`, forcing UEFI on the `virt` machine to do a full device scan on the next boot. EFI vars only store boot order (Boot0000 → first virtio-blk-pci disk), not OS state. Removed the deletion from `clean()`; disk image re-copy is sufficient for factory reset. Skip removed from the arm64 integration test.
- [x] [P3] **arm64 REST bug: POST returns prior GET's body — could not reproduce; CLOSED** — The 2026-06-24 lab repro (`test/lab/arm64-rest-ordering/repro.test.ts`) on RouterOS 7.23.1 / Bun 1.3.14 did NOT reproduce the stale-response (POST always returned its own body; Scenario D 0/10). Likely an already-fixed Bun issue. Un-skipped the 2 arm64 `exec.test.ts` tests — both pass on arm64 CI (run 28111921441). Removed the speculative `restGet()` socket-close wait (Scenario A passes with a plain no-wait GET→POST, so it was unneeded).
- [ ] [P3] **Boot respawn-once — watch-item, root cause unconfirmed** — `QuickCHR.start()` now respawns QEMU once on a wedged nested-KVM/HVF boot (DESIGN.md decision #8, `d62ee86`). This made CI green, but the trigger is **not diagnosed** — it could be runner CPU-steal, a SLiRP stall, or image timing rather than a true QEMU wedge. Deliberately scoped: **not** applied to `_launchExisting` (restart path), and `accelTimeoutFactor` left at 1.5× (no further ceiling inflation). **Watch for:** the `respawning QEMU once` line in CI `qemu.log`/run logs. If it fires often, or `BOOT_TIMEOUT` survives the respawn, or it shows up on the `_launchExisting` path → stop treating as flake; build a repro (serial-log a stuck boot to distinguish wedged vs slow) and decide between extending respawn to `_launchExisting`, raising the factor, or a real fix. Until then, leave the asymmetry as-is.

**Test coverage gaps:**

Coverage is 79.59% funcs / 67.86% lines (above thresholds). Remaining sub-70 candidates: `rest.ts` (41.76%), `packages.ts` (37.78%), `device-mode.ts` (61.36%), `platform.ts` (57.98%), `qemu.ts` (69.81%). Don't chase numbers; add tests when they prove correctness of uncovered paths.

- [x] credentials.ts, license.ts, secrets.ts, completions.ts, images.ts (all above 73%)
- [x] [P1] **Cache retention policy** — Default: **size-based, 2 GB** (fits 4 channels × stable/testing/development/long-term plus extras). When cap exceeded, evict by RouterOS version order (oldest first). `doctor` warns about items older than current long-term. Add `quickchr cache` command with `--older-than` / `--max-age` / `--dry-run` flags for manual purge. Size cap is a user setting (see "User-settings framework"); disabling auto-cleanup must be supported for users with dedicated disk.

### Provisioning

<details>
<summary>Completed provisioning work</summary>

- [x] Version guardrails (7.20.8+ for provisioning, older 7.x boot-only)
- [x] Centralized version gate, wizard UX for old versions, CLI/API error design
- [x] Integration tests (old version boot-only, provisioning block, 7.20.8+ green path)
- [x] Compatibility matrix, device-mode version gate, support policy published
- [x] `/system/device-mode` support, `instance.setDeviceMode()`, license verify read-back
- [x] License auth resolution (`renewLicense`/`getLicenseInfo` use `resolveAuth()`)
- [x] Console provisioning engine (`src/lib/console.ts`), wired to `exec --via=console`
- [x] Console fallback when REST times out, `ensureLoggedIn` logout guard
- [x] `disableAdmin()` race fix (verify with new-user creds, 20s deadline) (`b512137`)
- [x] Timeout scaling (`accelTimeoutFactor`, `defaultBootTimeout`, `--timeout-extra`, 8 unit tests)

</details>

### Robustness

<details>
<summary>Completed robustness work</summary>

- [x] SIGINT/SIGTERM cleanup, lock file, error messages (EFI mismatch, permission denied)
- [x] Retry download on network errors, machine name validation (reject `-` prefix)
- [x] ether1 DHCP ordering experiment (SLiRP hostfwd requires 10.0.2.15, user-first correct, lab: `test/lab/slirp-hostfwd/`)
- [x] HTTP consolidation (`rest.ts` module, node:http + agent:false, all 13 fetch() CHR calls replaced)
- [x] `start()` always waits for boot
- [x] `--forward` / service-port-pinning lock-in tests for existing behavior: `--forward winbox:8291`, same-name `extraPorts` replacement, duplicate last-wins semantics, and custom 8291 hostfwd. Production forwarding behavior unchanged.
- [x] Running-machine connection descriptor/env surface: `ChrInstance.descriptor()`, `quickchr inspect <name> [--json]`, and `quickchr env <name> [--json]`; stopped machines fail with `MACHINE_STOPPED`.

</details>

**Open robustness items:**

- [ ] [P2] **LLM-actionable error diagnostics** — structured `{code, message, hint, diagnostics?}` payloads with 50-char context. **Blocker:** not enough saved error-case tests to know what each code's `hint`/`diagnostics` should say. Before shaping the payload, build labs for the 3–5 highest-signal codes (`MISSING_QEMU`, `PORT_CONFLICT`, `DOWNLOAD_FAILED`, `BOOT_TIMEOUT`, `SPAWN_FAILED`) by inducing each in CI (qemu removed from PATH, port already bound, etc.) and capturing current output. Shape the struct around what's observed, not what's imagined. (Canonical code list: `ErrorCode` in `src/lib/types.ts`.)
- [ ] [P2] **Wizard remediation map** — per-failure-code "Why" + "Try this" suggestions. Prereq: persist a session-log (or at least the last run) per machine so remediation references observed output, not training-data guesses.
- [ ] [P2] **Wizard storage preflight** — start with disk free, `qemu-img` present, socket_vmnet alive (if shared/bridged selected), port block free. Wire into code-review + error-handling tests so wizard failures get the same treatment as CLI failures.
- [ ] [P2] Wizard post-start credential access info when managed login used (explain `exec`, `get <machine> creds`, API method for bridged VMs)
- [ ] [P3] Boot-wait progress UX — `waitForBootWithProgress` added; per-probe logging (HTTP attempt, REST init, timeout budget) not yet implemented
- [ ] [P3] Windows channel reliability — monitor/serial/QGA now use **TCP localhost** (`channels.ts`: monitor=portBase+6, serial=+7, qga=+8) because QEMU's Winsock `bind()` can't handle `\\.\pipe\` paths; named pipes remain only as a non-portBase fallback. **Update (2026-06-07):** monitor (+6) and serial (+7) are now validated on a real Windows CI run — `disk` savevm/loadvm (monitor) and `provisioning` + serial-stream tests passed on windows-latest/TCG (run 27097457831). QGA (+8) is still unexercised end-to-end (guest agent needs KVM → skipped under TCG/HVF; see the QGA item above). Remaining follow-up: confirm the +6/+7/+8 IPC offsets never collide with user `extraPorts` in the same block (ties into the port-allocation redesign below — extras must avoid +6..+8 on Windows).
- [ ] [P3] `/system/shutdown` exec returns HTTP 400 — handle gracefully. Test locally first: enable RouterOS debug logging, capture HTTP via `/tool/sniffer` or `tshark`, understand shutdown sequence.
- [ ] [P4] **Centralize error-message and logging surface** — error strings are duplicated across CLI, wizard, and library and drift independently. Extract a single source (code → format). Same underlying discipline as the dropped `--no-ansi` flag: separate presentation from content so a wording change lands in one place.

### Documentation

- [ ] [P2] Draft MANUAL.md covering CLI, library API, provisioning, storage layout. Command tree diagram for CLI rationalization. Document `exec` design (`--via=auto|ssh|rest|qga|console`), `console`/`attach` as serial access.
- [x] [P1] **Document `--json` semantics on `exec`** — `exec --json` wraps the quickchr response as JSON, not structured RouterOS output. The RouterOS command result is still a string (print output, command return, etc.). To get JSON *from RouterOS*, the script must use `:put [:serialize to=json [<path>/<cmd>/print detail as-value]]` — a RouterOS scripting concern, not a quickchr one. Document the pattern in MANUAL.md and mention it in `exec --help` so agents don't assume `--json` structures the RouterOS result. See `~/GitHub/vscode-tikbook/src/routeros.ts:220` and `notebook.ts:298` for the cross-project `:serialize` auto-wrap idea — parsing commands to know whether they're wrappable is a larger task, not on the quickchr side.

<details>
<summary>Completed test coverage work</summary>

- [x] State, QEMU, images, channels, credentials, secrets, completions, license, platform unit tests
- [x] Instance lifecycle integration tests (remove running, clean, provision corner cases)
- [x] Device-mode feature flags, exec (REST/QGA/console), SSH key provisioning
- [x] Anchor test (`test/integration/anchor.test.ts`) — 34 field-presence assertions across 6 endpoints
- [x] Windows unit tests (paths, channels, spawn) run in CI on every push/PR
- [x] Focused coverage-only unit tests for `rest.ts`, `device-mode.ts`, `packages.ts`, and `platform.ts`. Production behavior unchanged.

</details>

### Lab-Verified RouterOS REST Behavior (May 2026)

<details>
<summary>Lab experiments (test/lab/) documented exact REST API behavior</summary>

- device-mode-rest.md — POST always blocks; activation-timeout 10s–1d; attempt-count tested to 12; flagged independent
- packages-rest.md — `/system/package/apply-changes` required (NOT `/system/reboot`); `scheduled` values documented
- async-commands-rest.md — `duration="Xs"` → `.section` arrays; `once=""` → single-element; `once="false"` does NOT activate
- licensing-rest.md — Free CHR 2 fields only; error strings inside HTTP 200; `duration` controls server wait
- Lab tests in `test/lab/<topic>/` with `REPORT.md` files. See `test/lab/README.md`.

</details>

### Paired skill maintenance

Canonical location for the paired skills is `~/GitHub/routeros-skills/` (symlinked into `~/.copilot/skills/` and `~/.claude/skills/`). `quickchr` is the reference implementation for **two** skills now: `routeros-qemu-chr` (generic QEMU/CHR) and `routeros-quickchr` (driving quickchr itself). Keep their `SKILL.md` + `routeros-quickchr/references/quickchr-api.md` aligned when behavior changes.

**Workflow note:** for now, edit the skill in-place under `~/GitHub/routeros-skills/` (local path; that repo is under git but the PR-based publishing flow isn't active yet — backlog too busy here). SKILL.md files themselves must never contain local paths. Long-term goal: shift to a PR workflow against `tikoci/routeros-skills` once the work queue here is sparser. Skill updates should be part of code review whenever QEMU/CHR behavior changes.

- [x] **`references/quickchr-automation.md` → replaced by `routeros-quickchr/references/quickchr-api.md`** (2026-06-26). The automation reference (trigger terms, `QuickCHR.start()` options, `ChrInstance` methods/properties, port layout, error codes) was never created under `routeros-qemu-chr`; it now lives in the dedicated `routeros-quickchr` skill where it belongs. No stale paired-skill obligation remains under `routeros-qemu-chr`.

**Standalone lab tests (others merged into parent items):**

- [ ] [P3] Serial console device-mode observation (countdown timer during device-mode/update) — useful for timeout scaling work.
- [ ] [P3] Large-duration async memory check (`duration="60s"` on monitor-traffic) — useful before any streaming-API work.
- [ ] [P3] License "done" path confirmation with valid MikroTik.com credentials — grounds `licensing-rest.md`.

(Merged/subsumed: SCP `.npk` upload → part of "first-class file transfer API". QGA `guest-file-write` → subtask of QGA investigation on KVM. Multi-package enable version test → already tested on 7.10; 7.18 split is documented. ed25519 SSH key version → already tested in 2025-07-17 ssh-keys lab.)

<details>
<summary>Completed lab tests</summary>

- [x] SSH key provisioning lab (2025-07-17) — `add` (inline RSA-only on 7.10) vs `import` (upload file); ed25519/ECDSA unsupported on 7.10; DELETE 204; `test/lab/ssh-keys/REPORT.md`
- [x] Multi-package enable (7.10 tested) — `enable`/`disable` + `reboot` works; `/system/package/apply-changes` added in 7.18
- [x] SLiRP hostfwd experiment (2026-04-17) — Requires guest IP 10.0.2.15; user-first ordering correct; `test/lab/slirp-hostfwd/`
- [x] Bun HTTP pool (disproved) — `test/lab/bun-pool/REPORT.md`

</details>

### Bun HTTP Client Decision

**Rule:** Use `fetch()` except for long-polling/blocking CHR REST endpoints (device-mode, exec).
**Reason:** Bun's `req.destroy()` doesn't emit error → promise hangs on timeout (reproducible). The pool bug was NOT reproduced (`test/lab/bun-pool/REPORT.md`).

**TODO:**

1. [P3] File Bun issue for `req.destroy()` error silence
2. [P3] Re-test on Bun major versions
3. [P3] Unify to `fetch()` if Bun fixes it

---

## Open — CLI / UX

### CLI Design Principles

- **Interactive prompts confined to `setup`** — all other commands non-interactive (no selectors). Without `<name>`, print list + tip.
- **`start`/`stop` are pure operations** — no wizard, no creation. `add` creates, `setup` is wizard.
- **`set`/`get` for machine config, avoid post-provisioning mutations** — after provisioning, do not introduce commands that re-provision. The surface has a way of growing; each new post-provision capability needs careful testing against RouterOS edge cases.
- **`--json` on read commands** — same content as console output (richer metadata OK), pipe-friendly for `jq`. **No `--yaml`, no `--serialize`, no TSV/CSV** — callers pipe `--json` through `jq`/`yq`/`python` as needed. For `exec`, `--json` wraps the quickchr response; the RouterOS command result is still a string (see docs item).

<details>
<summary>Completed CLI/UX work</summary>

- [x] `add` command with all start creation options, error on duplicate (`36ad135`)
- [x] `start`/`stop` refactored (wizard removed, list+tip for no-name, `--all` flag)
- [x] `remove`/`clean` non-interactive (selectors removed, list+tip, `--all` on remove)
- [x] `list` merged with `status` (summary table + detail view, `status` aliased to `list`, `--json`)
- [x] `setup` wizard (top-level menu, zero-machine flow, manage/networks stubs)
- [x] `exec` command (REST transport, `as-string` sync, auth resolution, `--via=auto|rest|qga|console`)
- [x] `console` command (serial attach, TTY required)
- [x] `logs` command (`--follow`, `-n N` lines, `a8c8cad`)
- [x] `set`/`get` commands (`--license`, license/device-mode/admin query, `--json`)
- [x] `snapshot` CLI + API + wizard UX (savevm/loadvm/delvm/list, qcow2 guard, 16-cap)
- [x] Shell completions (bash/zsh/fish, context-aware, `quickchr completions --install`)
- [x] `networks` command (list user/socket/shared/bridged, `--json`)
- [x] `qga` command (ping/info/osinfo/hostname/time/file-read/file-write/exec, x86 only)
- [x] `inspect` / `env` connection descriptor commands (`--json`, running-only, secret-bearing output caveat)

</details>

**Open CLI/UX work:**

- [ ] [P3] **`quickchr cp <name> <src> <dst>` — file transfer on the CLI** ([#23](https://github.com/tikoci/quickchr/issues/23)). `ChrInstance.upload()`/`download()` exist (SCP via resolved creds), but there's **no CLI command** for them. Surfaced by the 2026-06-26 examples rework: `examples/file-transfer/` is library-only, and `examples/version-matrix/`'s CLI/Python driver can't upload the sample config (so it compares default exports only). A thin `cp`/`push`/`pull` wrapping the existing SCP plumbing (`src/lib/scp.ts`) would close both gaps and let those examples ship a real `.sh`/`.py` transfer path instead of a "no CLI" note. Direction: `quickchr cp <name>:<remote> <local>` and `quickchr cp <local> <name>:<remote>` (scp-style), or explicit `push`/`pull`. **Related:** no `quickchr install <name> <pkg>` for a *running* machine ([#24](https://github.com/tikoci/quickchr/issues/24)) — the library has `installPackage()`, the CLI only installs at first boot via `--add-package`.
- [x] [P1] **`--forward <name>:<host>:<guest>[/tcp|udp]` on `quickchr add`** — Surface `extraPorts` as a repeatable CLI flag. Today forwarding a guest service (SMB/445, Dude/2210) requires constructing the full `extraPorts` array in code. External agent (2026-04-22 tikoci/donny session) had to grep `types.ts` before knowing how to expose SMB. Pairs with the well-known guest-port registry (see library section).
- [ ] [P1] **User-settings framework (narrow scope)** — Framework for settings not tied to a specific machine: wizard defaults, cache size cap, default timeout scale, auth preferences (always-license-at-P1, never-license, etc.). **Out of scope:** post-provisioning machine-config mutations (that was the `set` confusion). Ship with ~5 concrete settings; grow only when a real user-facing choice appears. Don't build a general settings system first.
- [ ] [P2] **`--via=auto` smart routing** — Order: **REST → SSH → QGA (if KVM) → console**. SSH second because it's well-tested on RouterOS and works when REST can't. QGA is least-tested and gated on KVM (RouterOS may require `/dev/kvm` — see QGA investigation below); arm64+KVM is untested on our hardware but believed to work. Depends on SSH transport landing first.
- [ ] [P2] **SSH transport for `exec`** — `--via=ssh` (key provisioning done, transport not implemented). **Spike first:** compare `ssh2` npm package vs spawning system `ssh`. Check key-algorithm compatibility with RouterOS (does `ssh2` support the schemes RouterOS accepts? does system `ssh`?). Plan is to support both eventually (system `ssh` when user's keyring is already set up; `ssh2` for portability and avoiding per-distro variation). Pick the default after the spike.
- [ ] [P2] **`doctor` — enhancement + correctness review pass** — OS-level diagnostics (ps/port scan, stale machines, socket conflicts). Review pass: walk every known error path and confirm it's detectable by `doctor` (or add a check). Confirm every command `doctor` suggests is actually available on the host and produces the expected output — not just transcribed from training or docs.
- [ ] [P2] **`doctor --export`** — JSON file with machine list + state, machine configs, log tails (truncated, no binary), qemu/platform info. Goal: a single file a user can attach to a bug report. Ship a minimum v1 and iterate when we discover what's missing — better to have something now than wait for a complete spec.
- [ ] [P2] **`doctor` version staleness** — quickchr version vs. latest, RouterOS image staleness (odd/even policy, days-behind-latest), color-coded status.
- [ ] [P3] `exec --lint` — Pre-validate via `/console/inspect request=completion`. Depends on lsp-routeros-ts extraction (~50 lines).
- [ ] [P3] `list` enrichment — Live QEMU stats (CPU/mem via monitor) for detail view.
- [ ] [P4] **ANSI table cleanup** — Current tables use `——————` borders that don't wrap and look broken on small terminals. First step: borderless columns (we already column-align). Revisit box-drawing later, only if there's a clear UX win.

---

## Open — Port Allocation & Networking

Port assignment is a tangled knot. Two concerns bled together:

1. **Range selection** — `DEFAULT_PORT_BASE=9100` collides with JetDirect/PDL (printers) and picks a range agents memorize as "quickchr uses 9100 for REST" — only true for the first instance. Second machine gets 9110 and agents are surprised.
2. **Block scheme** — Fixed 10-port blocks with reserved offsets (`+0` HTTP, `+1` HTTPS, …). Extra ports bolted at `+6..+9` collide with Windows IPC channel offsets (monitor/serial/QGA), leaving 1 slot before spilling. Manual `extraPorts` bypass conflict checking entirely.

All quickchr users are our own code right now, so API/CLI can be refactored; don't let backwards-compat bog down the redesign. Test cases exist to make the API better.

- [x] [P1] **Port research spike** — Inventory all ports RouterOS may use (stable services + containers + common guest needs: SMB/445, Dude/2210, FTP/21, SNMP/161-udp, WinRM/5985, HTTP-alt/8080). Cross-reference IANA well-known and registered ranges. Output: `WELL_KNOWN_GUEST_PORTS` table (in `types.ts` or `guest-ports.ts`) mapping name → guest port + protocol + notes. Feeds `--forward smb:9145` auto-fill and any `--emulate-device` work.
- [x] [P1] **`extraPorts` host-port collision detection** — `buildPortMappings` validates auto-allocated ports only; manual `host:` in `extraPorts` bypasses conflict checking against live allocations. Fix: validate explicit `host:` against `listMachines()` before claiming. Lands regardless of the broader scheme redesign — it's a correctness bug.
- [ ] [P1] **[?] Port-base randomness** — Move off fixed 9100 start. Options: (a) random base in a clean range at machine-create time, persisted to state; (b) let API caller request a range; (c) both. (a) prevents "agents assume 9100"; (b) gives power users control. **Clarify:** v1 change with 9100 default removed, or v2 setting with 9100 as default? And what clean range — 19100+, 20000+, 30000+?
- [ ] [P1] **[?] Rethink the fixed "service block" concept** — Current reserved 10-port blocks are likely overfit. Proposal: instances declare what they need; allocator grows the block to fit. Documented offsets (HTTP, HTTPS, SSH, API, API-SSL, WinBox, monitor, serial, QGA) stay for core services; extras live elsewhere. **Clarify:** dynamic variable-size blocks, or fixed core pool + separate extras pool above? Both avoid the Windows IPC collision; dynamic is more general but bigger change.
- [x] [P2] **Named socket auto-create in API** — `networks: [{type:"socket", name:"foo"}]` currently requires `quickchr networks sockets create foo` first. Auto-create in `start()` if missing; track ownership; clean up on `remove()`.

See `docs/networking.md` for platform internals. Priority: macOS (local) & Linux (CI) → Windows.

<details>
<summary>Completed networking work</summary>

- [x] `--add-network` repeatable flag, network specifiers (user, socket::<name>, shared, bridged:<ifname>, aliases)
- [x] Named socket state (`~/.local/share/quickchr/networks/<name>.json`), port allocation
- [x] Platform resolution (shared/bridged → socket_vmnet or vmnet-shared or TAP), downgrade warnings
- [x] Interface alias resolution (wifi/ethernet/auto), wizard networking UI (before provisioning, retry loop)
- [x] `quickchr networks` command (list user/socket/shared/bridged, socket_vmnet detection, `--json`)
- [x] macOS socket_vmnet detection (pgrep for live daemon, shared/bridged sockets), daemon wrapping

</details>

**Open networking:**

- [ ] [P3] **`socket-mcast` broken on macOS (QEMU `SO_REUSEADDR`-only)** — Discovered 2026-06-06
  (`test/lab/mndp/REPORT.md`): QEMU's `socket,mcast=` netdev sets only `SO_REUSEADDR`; macOS/BSD
  require `SO_REUSEPORT` on all sockets sharing a multicast port, so mcast delivers nothing
  between local sockets on macOS — two CHRs on one group don't discover each other, and host
  capture gets zero frames. Works on Linux/CI. Documented in `docs/networking.md` and
  `docs/mndp.md`; `socket-connect` is the macOS-safe substitute for **point-to-point** and
  **host capture**. **Action:** `networks` command / wizard should warn when `socket-mcast` is
  selected on darwin. *Considered and rejected (2026-06-06):* adding a `udp=`/`localaddr`
  socket netdev — it's point-to-point, so it neither fixes the real gap (a **rootless multi-VM
  shared L2 segment on macOS**, which needs a userspace hub/relay or `socket_vmnet`) nor adds a
  capability over `socket-connect` (which already does cross-platform host capture and macOS
  point-to-point); its only gain is raw vs length-prefixed frames — not worth a new public
  specifier. If a rootless multi-VM macOS segment is ever needed, design a small frame-relay
  hub, not a per-link netdev.
- [ ] [P3] **`-netdev stream` + AF_UNIX as a port-free host-capture transport** — Floated as a
  cleaner alternative to `socket-connect` (no loopback TCP port; a filesystem socket instead) and
  hoped to also drop the length-prefix parsing. **Validated on macOS 2026-06-06**
  (`test/lab/mndp/stream-unix-probe.ts`, see REPORT.md): `-netdev stream,server=off,addr.type=unix,
  addr.path=…` (QEMU 7.2+) *works* on macOS — QEMU connects to a host AF_UNIX listener and streams
  guest ether2 frames (21 frames / 4 MNDP parsed, cross-checked vs REST, RouterOS 7.23.1, QEMU 11).
  **But it is still length-prefixed** — the same 4-byte big-endian length header as the legacy
  `-netdev socket` (first bytes `00 00 00 6e` = 110-byte frame). So the "no length-prefix parsing"
  hope is **wrong for `stream`**; its only real win over `socket-connect` is dropping the TCP port
  in favor of a path. The genuinely unframed option is **`-netdev dgram`** (SOCK_DGRAM, one
  datagram = one frame) — *not* validated here, and costlier to wire (paired `local`/`remote` unix
  paths, connectionless). **Verdict:** not worth a new public specifier now — same conclusion as the
  `udp=`/`localaddr` rejection above (no parsing simplification, no new capability over
  `socket-connect`). Revisit only if filesystem-path addressing (no port allocation) becomes
  valuable — e.g. capturing from many concurrent CHRs without consuming loopback ports — and at that
  point evaluate `dgram` for the unframed path.
- [ ] [P2] **sudo handling** — At CLI: error with a clear "sudo needed for vmnet/TAP" message; point to socket_vmnet / TAP pre-setup via brew services or systemd/launchd. In wizard: may prompt for sudo if a human explicitly chose a bridge network that requires it. **Do not re-exec `sudo quickchr start`** — agents often can't sudo, and wrapping CLI in sudo is invasive. Document the pre-setup paths so hosts are configured once and subsequent calls don't need root.
- [ ] [P3] **Windows — ship networking, not just docs** — Target: local parity with socket_vmnet UX via TAP-Windows adapter (OpenVPN TAP or wintun). **First step:** validate user-mode networking works today on Windows locally (not tested). Then add TAP driver detection + docs. Integration tests on `windows-latest` follow.
- [ ] [P3] macOS vmnet-bridged filter — Only physical interfaces (Multipass bug: virtual/bridge → errors)
- [ ] [P3] macOS multi-NIC socket_vmnet — Chained `socket_vmnet_client` calls (fd=3, fd=4). Verify exact fd numbering
- [ ] [P3] Linux TAP discovery — `quickchr networks` shows available TAPs/bridges. Document `tap-chr-shared` convention
- [ ] [P3] Linux CI — Rootless only (user + socket). No TAP unless self-hosted runners
- [ ] [P3] `--emulate-device` hardware profiles — start small: **hEX (5 NICs, no wifi)** is the clean first case. Add 1–2 more when there's a use case (RB5009 9-NIC is the obvious next). Lookup table embedded in quickchr; can ingest rosetta device data later. Limited by what QEMU can emulate — many RouterBOARD models have no viable QEMU profile.

**Rootless topologies (examples):**
Multi-CHR topologies with `user` + `socket` (rootless, CI-friendly). RouterOS tunneling (VXLAN, PPPoE, GRE, IPSec, VRRP over shared/bridged) documented in MANUAL.md. Examples below.

- [ ] [P3] **`rootless-l2` / `socket-lan` example — needs a 1-page design first** ([#25](https://github.com/tikoci/quickchr/issues/25)). Two CHRs linked by a named `socket::<name>` L2 segment (rootless), IP each side, ping across to prove inter-router L2. Deferred from the 2026-06-26 examples rework (the other five new examples shipped). **Do the topology sketch before coding** (per the scope-boundary principle): which CHR listens vs connects for `socket::`, IP plan, what's asserted, expected boot/wall time for 2 parallel CHRs. Then it becomes a normal `examples/rootless-l2/` (`.ts`+`.sh`+`.ps1`+README) closing the `socket::<name>` row in `examples/COVERAGE.md`.

---

## Open — Machine Config & State

- [ ] [P2] **Machine config audit/verify (not the connection descriptor)** — Ship a report command (name TBD now that `quickchr inspect` is the descriptor surface) that validates a running/stopped machine against its stored config: REST reachable with managed creds, installed packages match, RouterOS version matches, user accounts as expected. **Reports only — does not fix.** Re-provisioning after the initial provision has too many failure modes (version bumps change behavior, creds may be rotated, package deps may change). If the audit flags a mismatch, recreate. Larger tikoci story: lack of a shared RouterOS backup/restore library; don't introduce post-provisioning commands here until that exists.
- [ ] [P2] **[?] Config schema rationalization** — Separate "desired config" (cpu, mem, packages, networks) from "runtime state" (pid, status, lastStartedAt). Safe edits: cpu, mem, name. **Needs a 20-line sketch** of the field split before implementation is actionable — which fields land in which bucket, what the migration does for existing `machine.json`. Priority/timing not confirmed.
- [x] **Pretty-format `machine.json`** — Already tab-indented in `state.ts:50` (`JSON.stringify(state, null, "\t")`).

---

## Open — Ecosystem & Integrations

### LLM & Agent Friendliness

**Validated patterns (keep investing):**

- **`examples/` as the first place agents look.** Observed 2026-04-22: external Sonnet agent under GitHub Copilot CLI, working on tikoci/donny, opened `examples/vienk/vienk.test.ts` (now `examples/quickstart/quickstart.ts`) very early — after the shared skill reference and package.json, before `src/lib/`. Used it as its pattern anchor for writing new lab code. **Convention (2026-06-26 rework):** examples are **runnable `bun run` scripts** (`<name>.ts` + `.sh`/`.ps1`/`.py` siblings), short and self-contained; `grounding/` is the sole `bun:test` (assertions-as-documentation). The full convention lives in `.github/instructions/examples.instructions.md`; coverage is tracked in `examples/COVERAGE.md`; a CI validator (`scripts/validate-examples.ts`) + smoke harness (`test/integration/examples-smoke.test.ts`) keep it from rotting. Each new example is load-bearing agent-onboarding surface.

- **Agents reach for `StartOptions.extraPorts` for custom forwarding but hit two frictions:** (1) not knowing the guest port number (had to grep or guess `smb=445`, `dude=2210`), and (2) not knowing a safe host port. Mitigations: well-known port registry + `--forward` CLI flag (see above).

- **External clients with fixed local-port assumptions need recipes, not just generic port docs.** Observed 2026-04-30/05-01 in `tikoci/donny` dude-winbox validation: the Wine-hosted Dude client reliably connected only via `127.0.0.1:8291`, while quickchr had mapped WinBox to the allocated host port (`9105`). The agent built a useful loopback proxy (`8291 -> 9105`) instead of realizing a fresh quickchr machine could pin WinBox with `--forward winbox:8291` (or a compatible `portBase`). The current behavior is now locked by tests and documented in README/MANUAL; the remaining gap is paired-skill/examples discoverability.
- **Machine connection descriptors for agents shipped.** `ChrInstance.descriptor()`, `quickchr inspect`, and `quickchr env` provide the stable running-machine ports/URLs/auth/status/env surface that donny/centrs-style harnesses should use instead of reading `machine.json` directly. Descriptor/env output is intentionally credential-bearing.
- **Discoverability gaps are recurring, and they're about *finding* capabilities, not missing ones.** Issue #18 (centrs, 2026-06-25): UDP forwarding, `socket-connect` L2, and the guest→host gateway path **all already existed**, but centrs had to read `src/lib/network.ts` to choose among them — and nearly built a redundant feature. Same shape as the donny WinBox-pinning case above. Fix shipped: a by-goal decision guide (`docs/networking-recipes.md`), JSDoc parity on the option types (so the capability is visible at the call site), a verified gateway-UDP recipe + example, and the (genuinely missing) UDP range-forward. Pattern to keep: every CLI-documented capability needs a **library-facing, by-goal** surface (JSDoc + a recipe), or agents won't find it.

**Open work:**

- [x] **Networking-discoverability gap → dedicated `routeros-quickchr` skill (issue #18 strategy, 2026-06-26).** Resolved with option (b): a new public **`routeros-quickchr`** skill in `tikoci/routeros-skills` (beside `routeros-qemu-chr`), pointer-heavy so it can't drift from the API — it embeds the stable mental-model, the by-goal networking decision table (incl. the guest→host gateway path), the connection-surface/harness pattern, and grounding gotchas, deferring version-specific detail to quickchr's own GitHub-linked docs. Reference doc: `routeros-quickchr/references/quickchr-api.md`. `routeros-qemu-chr` cross-links it from Additional Resources. Skill is broader than "testing" — framed as "ground RouterOS config/scripts/API against a real router." Symlinked into both AI dirs (`make link`/`make check`). **Note:** edited in-place in `~/GitHub/routeros-skills/`; pushing that repo is a separate step.
- [x] **Paired-skill networking follow-up (deferred from #18) — done via the new skill.** The guest→host UDP gateway path (no-forward, unconnected socket) + the compact "traffic shape → mechanism" table now live in `routeros-quickchr` (not `routeros-qemu-chr`, which stays generic QEMU/CHR). Source of truth remains `docs/networking-recipes.md`, `docs/mndp.md`.
- [ ] [P4] **Service-port pinning API polish / paired-skill follow-up** — Existing `--forward winbox:<host>` same-name replacement is documented and unit-tested; production behavior is unchanged. Remaining question: keep this as the intended API or add an explicit service override (`--port winbox=<host>`, `servicePorts`, etc.). If keeping it, update examples and the paired `routeros-qemu-chr` skill; if changing it, emit a clear deprecation/error for ambiguous same-name `extraPorts`.
- [ ] [P2] Review CLI output and library API for LLM ergonomics — structured output options, clear error messages.
- [ ] [P2] Copilot skills and `.prompt.md` files — teach agents how to use quickchr. Update `~/GitHub/routeros-skills/routeros-qemu-chr/SKILL.md` in-place (see Paired skill maintenance). Include port pinning (`--forward winbox:8291`), `portBase`, `captureInterface`, `tzspGatewayIp`, `waitFor()`, and the "check status before using stored ports" rule.

### VS Code Integration

- [ ] [P3] tikoci/vscode-tikbook — quickchr library as backend for CHR manager sidebar (replaces UTM-via-AppleScript)

### Library Consumer Friction (from restraml, and Copilot-CLI/dude 2026-04-22)

<details>
<summary>Completed library consumer improvements</summary>

- [x] One-shot "start + license" via `StartOptions.license`
- [x] `instance.subprocessEnv()` helper for child processes (URLBASE, BASICAUTH)
- [x] Clearer `start()` readiness contract in JSDoc (REST-ready when provisioning completes)
- [x] Arch-aware defaults for `mem` and boot timeout
- [x] `stop({ destroy: true })` option
- [x] Instance-level package management (`availablePackages()`, `installPackage()`)

</details>

**Open library friction:**

- [x] **First-class file transfer on `ChrInstance`** — `upload(localPath, remotePath?)` and `download(remotePath, localPath)` shipped (`src/lib/quickchr.ts:518-538`, SCP plumbing in `src/lib/scp.ts`, integration test `test/integration/file-transfer.test.ts`). The `dude` example shipped 2026-06-26 (`examples/dude/`). File-transfer surface is summarized in `routeros-quickchr/references/quickchr-api.md`.
- [x] [P1] **Well-known guest service port registry** — Lookup table so callers can write `extraPorts: [{name:"smb"}]` and get `guest:445, proto:"tcp"` auto-filled. Pairs with `--forward`. Output of the port-research spike.
- [x] [P2] **`examples/README.md` — document three consumption patterns** — Same customer spent visible reasoning on how to reference `@tikoci/quickchr` from a sibling experiment dir (bun link vs workspace vs local path vs published npm). Short README naming the three supported patterns and when to use each.
- [x] **`waitFor`, `captureInterface`, `tzspGatewayIp`, `portBase` on `ChrInstance`** (0.3.0, `e6ca0dc`) — Surfaces from tikoci/donny dude-agent lab (2026-04-23): manual polling loop for "/dude enabled: yes", hardcoded `lo0`/`10.0.2.2` for TZSP capture, and digging into `state.portBase` to pick a non-colliding socket port. All four properties + 9 unit tests shipped together.

**New friction surfaced from tikoci/donny dude-agent lab (2026-04-23) — not yet addressed:**

- [ ] [P2] **`exec()` soft-error detection** — RouterOS commands like `/dude/agent/add` may resolve successfully while their output contains an error string (e.g. `"doAdd Agent not implemented"`). Customer caught this only by reading output. Options: (a) opt-in `exec(cmd, { throwOnCliError: true })` that scans for known RouterOS error patterns in `output`; (b) document the limitation prominently and provide a helper like `isRouterOSError(output)`. Lab evidence first — collect 5–10 real soft-error strings before committing to a regex. **Not all output text is an error** (some commands legitimately echo `"failure"` in non-error context), so a strict allowlist is risky. (JSDoc warning shipped 2026-04-23; runtime detection still open.)
- [x] [P3] **`exec()` multi-line/batch behavior — document or normalize** — Documented in `ChrInstance.exec()` JSDoc (2026-04-23): `/rest/execute` runs input as a single script statement; multi-line `\n` strings may run only the first line. Callers should call `exec()` per command or wrap in `:do { /cmd1; /cmd2 }`. `execBatch()` left for later if the pattern recurs.
- [x] [P4] **Rename or alias `secureLogin: false`** — `StartOptions.noAuth: true` shipped as a backward-compat alias (2026-04-23). Normalized at the top of `start()`/`add()`; explicit `secureLogin` wins. Also fixed a latent bug where `secureLogin` was silently dropped from `MachineState`.
- [x] [P3] **Validate `version` vs `channel` mix-up** — Soft-warn shipped (2026-04-23): `start()`/`add()` log via the progress logger when `version` matches a known `Channel` literal. Behavior unchanged (lenient acceptance preserved); JSDoc on `StartOptions.version` calls out the convenience.
- [x] [P4] **Discoverability — `upload()`/`download()`/`rest()` already exist** — `MANUAL.md §4 ChrInstance` now opens with a grouped "at a glance" table and the reference block lists every property + method including the new 0.3.0 additions.

**New friction surfaced from tikoci/centrs integration harness review (2026-05-30):**

centrs already depends on quickchr as its CHR-backed integration harness
(`~/Lab/centrs/test/integration/chr.ts`): it dynamically imports
`@tikoci/quickchr`, calls `QuickCHR.start({version|channel})`, and passes
`chr.subprocessEnv()` to protocol tests. There is no immediate provisioning code to vendor
wholesale, but centrs has reusable RouterOS protocol layers and sharp test-harness needs.

- [ ] [P2] **Machine evidence descriptor for downstream harnesses** — centrs writes its own
  JSONL/GitHub summary record with suite, protocol, requested RouterOS version/channel,
  actual RouterOS version/board, and quickchr machine name. Fold this into the machine
  descriptor work above (`quickchr env` / `inspect --json` / `doctor --export`) so centrs,
  donny, and future harnesses use one stable redacted shape instead of reading `machine.json`
  or duplicating summary code.
- [ ] [P2] **REST timeout contract audit** — centrs records a 60s REST ceiling for normal
  REST execution; quickchr has special handling for RouterOS blocking endpoints. Reconcile
  the two with lab evidence before changing code. If the ceiling is real for normal REST,
  quickchr should reject or clamp user-visible REST timeouts above 60s except for documented
  fire-and-forget/blocking endpoint flows.
- [ ] [P3] **Protocol adapter reuse spike** — centrs has a REST/native-api adapter seam plus
  native API login/tagged multiplexing code. Before implementing quickchr's SSH/native-api
  adjacent execution paths, compare centrs' adapter/error mapping with quickchr's `rest.ts`
  and `exec.ts`; either vendor/link a shared package or document why quickchr remains separate.
- [ ] [P3] **L2-capable harness mode for centrs mac-telnet** — quickchr supports L2-capable QEMU
  netdevs (socket/TAP/vmnet), but centrs' current harness uses SLiRP/hostfwd and cannot
  validate MAC-Telnet broadcast/default-routing behavior. Spike a rootless/rootful topology
  and document the remaining native-helper requirement for raw L2 frame I/O.
  **MNDP precursor shipped (2026-06-06):** `socket-connect` (host TCP server + CHR
  `socket-connect` NIC) carries raw L2 frames to/from the host on macOS with no native
  helper — verified for MNDP receive and L2 injection. MAC-Telnet (UDP/20561) is the same
  technique run bidirectionally; the `examples/mndp/` refresh-injection write-back is the
  injection primitive it needs. **No raw-socket/native helper required.** Remaining: build
  the MAC-Telnet request/handshake on top (centrs side). Reference: `docs/mndp.md`,
  `test/lab/mndp/REPORT.md`.

**Recency-aware channel/version API for CI consumers (issue #3, 2026-06-21):**

- [x] **Public version exports + recency API** — `src/index.ts` now re-exports the version
  helpers (`resolveVersion`, `resolveAllVersions`, `parseVersionParts`,
  `compareRouterOsVersion`, `isValidVersion`, `isProvisioningSupportedVersion`, `CHANNELS`,
  `Channel`) so consumers stop being blocked by the `.`-only `exports` map. Added the
  recency classifier: `resolveChannelStatuses`/`classifyChannels` (`ChannelStatus` =
  `{channel, version, maturity, aheadOfStable}`) and `resolveActiveChannels`/
  `selectActiveChannels` (released channels always + pre-release at/ahead of a reference,
  default `stable`). Pure variants take a `Record<Channel,string>` for network-free tests.
  Quickchr owns version facts + recency; merge-gating policy stays in the consumer (centrs).
- [x] **Suffix-aware comparator (bug fix)** — `compareRouterOsVersion` now orders
  `betaN < rcN < release < patch` (was stripping the suffix → `7.24beta2 == 7.24rc1 == 7.24`).
  Release-vs-release consumers (cache-prune, doctor stale-image) unaffected. Updated the
  anchor test that encoded the old equality.
- [x] **`version --json` / `doctor --json`** — `version --json` emits a `{channel: version}`
  map (offline → `{}`); `doctor --json` emits `{ok, checks, staleImages}` (exit still
  reflects `ok`).
- [ ] [P3] **`--json` for `networks` and `disk`** — follow-up from the issue #3 "other
  `--json` gaps" audit. `networks interfaces`/`sockets` and `disk` expose structured data
  (`getDiskInfo` → `DiskInfo`, socket registry, detected interfaces) but only print human
  tables. Add `--json` mirroring the `list`/`inspect`/`cache list`/`doctor` pattern when a
  consumer needs it. `cache prune`/`clear` could also emit evicted-entry JSON (minor).

### Examples (Rootless Multi-CHR Topologies)

**Design principles:**

- Every example works with `user` + `socket` (rootless) as baseline
- Every CHR keeps `user` mode (ether1) for management — tests assert via REST API
- Socket links create data-plane topology; RouterOS protocols (OSPF, VXLAN, PPPoE) run on top
- tris, solis, matrica CI-testable (rootless); divi requires root (VRRP)

<details>
<summary>Completed: matrica + vienk</summary>

- [x] `examples/matrica/matrica.test.ts` — LITE mode (2 channels, native arch, no extra packages) + full mode (4 channels, native arch, zerotier+container)
- [x] `examples/matrica/Makefile`, `matrica.py`, `README.md`, `rb5009-arm64.rsc`
- [x] `examples/vienk/vienk.test.ts` — simple quickstart (boot, identity, interface list, native arch, stable) (`36ad135`)
- [x] `examples/vienk/README.md` — quickstart guide with timing table

</details>

**Shipped 2026-06-26 (light `.test.ts` + README convention, all verified on real CHR):**

- [x] **`examples/grounding/`** — the canonical loop: apply config via `exec()`, read back via
  `rest()`, assert. Nonce-bearing machine name + asserted values (re-run safe). The example
  `routeros-quickchr` points to first.
- [x] **`examples/harness/`** — drive an external child process against a live CHR via
  `subprocessEnv()`/`descriptor()` (the restraml/centrs pattern); `child.ts` shows the
  `Basic ${btoa(BASICAUTH)}` header + the secret-bearing caveat.
- [x] **`examples/dude/`** — install the `dude` package (`installPackage`), enable it, read the
  setting back (x86; verified on 7.23.1). Shipped **without** a seeded `.db` fixture — a pre-built
  `dude.db` is version-fragile across releases, so the example grounds the install+config path
  deterministically instead (file-transfer API itself is already anchored by
  `test/integration/file-transfer.test.ts`).

**Open examples — each needs a 1-page design (topology sketch, .rsc seeds, assertions) before coding:**

> Evaluated 2026-06-26 alongside the skill work and **deferred** — each is multi-CHR, multi-boot, or
> root-only, so it adds materially more flake/cost than the three single-CHR examples above. Keep as
> design sketches; don't ship until a 1-pager pins the topology + deterministic assertions.

- [ ] [P4] tris (3-CHR hub-and-spoke, OSPF) — Makefile, bun:test, Python, README, hub.rsc, branch-a.rsc, branch-b.rsc. *Deferred: 3 boots + socket L2 topology.*
- [ ] [P4] solis (sequential version migration) — Makefile, bun:test, Python, README, rb5009-sample.rsc. *Deferred: multi-boot + in-guest upgrade timing.*
- [ ] [P4] trauks (/app container testing) — Makefile, bun:test, Python, README, github-workflow.yaml. *Deferred: in-guest OCI pulls (network-dependent).*
- [ ] [P4] divi (2-CHR redundancy, VRRP+VXLAN) — Requires root. Makefile, bun:test, Python, README, chr-a.rsc, chr-b.rsc. *Deferred: not rootless/CI-friendly.*

### Snapshots + RouterOS config export

- [ ] [P3] Windows snapshot smoke test (global install, PATH detection for `qemu-system-*` and `qemu-img`)
- [ ] [P3] **RouterOS `:export` alongside VM snapshot (opt-in, wizard asks)** — Snapshot always succeeds (qemu savevm works regardless of login state). When wizard takes a snapshot, ask "also save a RouterOS config export?" (default yes). If credentials available, attempt `/export` and save alongside snapshot metadata; if not, log the skip and keep going. Never block the snapshot on the export.

### QGA (investigation, not shipping work)

<details>
<summary>Completed QGA & credential work</summary>

- [x] QGA protocol (`qgaSync`, `qgaExec`, `qgaProbe`, `qgaInfo`), wired to `exec --via=qga` (x86 only)
- [x] Integration tests (x86: sync, probe, exec, info); file operations (`qgaFileWrite`, `qgaFileRead`)
- [x] Typed API (`QgaCommand` union, high-level helpers exported from index)
- [x] `quickchr qga` CLI (ping/info/osinfo/hostname/time/networks/fsfreeze/shutdown/file-read/file-write/exec)
- [x] Credential overhaul (`Bun.secrets` wrapper, config-file fallback, two scopes: MikroTik web + per-instance)
- [x] Managed account (`quickchr` user auto-created, password in secret store, `--no-secure-login` opt-out)
- [x] SSH key provisioning (ed25519, stored in `<machineDir>/ssh/`, `/rest/execute` scripting, `3580d53`)

</details>

**Open QGA:**

- [ ] [P3] **x86 QGA under macOS / QEMU 10.x — revised hypothesis** — Earlier analysis framed this as a QEMU bug (never sends `VIRTIO_CONSOLE_PORT_OPEN`; see `docs/qga-x86-macos-qemu10-investigation.md`). Revised: **RouterOS may restrict QGA activation to `/dev/kvm`** — the guest agent may never open the virtio-serial port under HVF, regardless of QEMU version. No conclusive evidence. Spike: compare RouterOS QGA behavior on the same version under KVM (steamdeck lab) vs HVF; confirm whether guest-side QGA ever opens the port under HVF. If it's RouterOS-side, there is no local workaround.
- [ ] [P3] **arm64 QGA — MikroTik ticket open, no ETA** — Once fixed (and once arm64+KVM is confirmed working), extend tests to arm64. QGA remains valuable because it's authless — can recover a machine whose REST/SSH credentials are broken.

---

## Deferred

Not rejected — deferred until prerequisites land or the need sharpens.

### MCP server

- [ ] Expose quickchr API over MCP. Lower priority than making CLI/library natively agent-friendly. Revisit after the `--forward` / well-known-ports / `upload`/`download` cluster lands, and cross-reference Anthropic's newer MCP App support — the right surface may have shifted.

### TUI Mode

- [ ] TUI (blessed-contrib / ink / bubbletea) — **Content first:** maximize useful info in 80×24 before building dashboard. Dashboard is a rendering layer over structured data — build the data layer first (`--json` everywhere, settings framework).

### Config Import

- [ ] Config `.rsc` / `.backup` import — Load RouterOS export/backup as part of machine creation. Blocked on broader tikoci story for shared RouterOS backup/restore.

### Auto-Update

- [ ] Auto-upgrade check — Notify when newer quickchr available. Passive notice, not blocker. Defer until `doctor` version reporting solid.

### Credential Profiles

- [ ] Save/restore username+password per machine or shared default (design incomplete).

### Snapshot search in wizard

- [ ] `@clack/prompts` search for machines/snapshots when lists grow large (>16).

---

## Won't Fix / Out of Scope

- **Cloud deployment** — `~/GitHub/chr-armed` has working code for OCI + AWS; archived pending quickchr maturity. Once local CHR is solid, cloud targets can reuse provisioning/image layers.
- **Multi-CHR orchestration** — Out of scope for CLI/library. `examples/` shows patterns; users/agents orchestrate.
- **Packaging (Homebrew/Deb)** — Lower priority than core functionality.
- **Service management (launchd/systemd)** — Optional promotion for long-running instances, not a requirement.
- **Machine templates** — CLI flags are templates, API objects can be reused, wizard always prompts. No separate template system.
- **`quickchr upgrade <name>`** — Replaced by a future config audit/verify report (reports mismatch; user recreates). Avoid post-provisioning mutations.
- **`--no-ansi` flag** — ANSI is fine in text output; `grep`/`jq` handle it. The underlying discipline (separate presentation from content) is addressed by "Centralize error-message surface".
- **`machine.json` → `machine.yaml`** — Staying JSON; pretty-printing addresses readability. YAML adds complexity for `jq` users without a matching benefit.
- **Separate multi-version/multi-arch test matrix runner** — Current CI matrix + `examples/matrica` cover this.
