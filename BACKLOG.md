# quickchr Backlog

> Open work and design questions live below. Completed items are collapsed — full notes are in git history, MANUAL.md, DESIGN.md, or `.github/instructions/*.md`.
>
> Open items are tagged [P1]–[P4]. Last review pass: 2026-04-24.

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

</details>

<details>
<summary>CI & Publish</summary>

- [x] CI matrix (linux x86/arm64, macOS dispatch), coverage 79.59% funcs / 67.86% lines (above thresholds)
- [x] Artifacts (coverage-report 14d, integration-logs 7d), `publish.yml` gating

</details>

<details>
<summary>Wizard / CLI UX</summary>

- [x] Shell completions (bash/zsh/fish) context-aware machine names (`f7ca662`)
- [x] Wizard main-menu loop, `Back` navigation, snapshot UX (qcow2 guard, 16-item cap)
- [x] Disk management (`--boot-size`, `--add-disk`), credentials in status, orphaned-dir cleanup (`a1fa7c3`)

</details>

---

## Open Work

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
- [ ] [P3] **Windows — local validation first, then CI** — validate named-pipe channels under load, confirm socket_vmnet-equivalent network plumbing (or document SLiRP-only mode), track CHR boot timing on Windows + WHPX vs TCG. Expand integration suite on `windows-latest` CI only after local validation passes.
- [ ] [P3] **arm64 `clean()` second-boot timeout** — `clean() resets disk to factory defaults` integration test is skipped on arm64; second boot after `clean()` consistently times out at 480s, same flow on x86 KVM is ~66s. Likely a firmware/vars or pflash state interaction with the freshly-cleaned disk on QEMU `virt`. Spike (1–2h): does `clean()` need to reset UEFI vars on arm64, or does `_launchExisting` need different args after a clean?
- [ ] [P3] **arm64 REST bug: POST returns prior GET's body (research + test)** — On `linux/aarch64` runners, `restPost` to `/rest/execute` returns the response body of the immediately-prior `restGet` to `/user/ssh-keys` (same host:port). Two tests in `exec.test.ts` skipped on arm64. `agent: false`, `Connection: close`, and `node:http` (not `fetch`) all fail the same way — which narrows the set of explanations but **does not prove Bun is the culprit**. Don't encode "Bun bug" as project truth until it's demonstrated in isolation. Build a minimal repro outside quickchr (plain Bun hitting the same CHR REST endpoints); determine whether RouterOS arm64 REST, quickchr's request pipelining, or the Bun runtime is at fault. Then file upstream, fix locally, or fall back to `child_process.spawn("curl")` on arm64.

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

</details>

**Open robustness items:**

- [ ] [P2] **LLM-actionable error diagnostics** — structured `{code, message, hint, diagnostics?}` payloads with 50-char context. **Blocker:** not enough saved error-case tests to know what each code's `hint`/`diagnostics` should say. Before shaping the payload, build labs for the 3–5 highest-signal codes (`MISSING_QEMU`, `PORT_CONFLICT`, `DOWNLOAD_FAILED`, `TIMEOUT`, `SPAWN_FAILED`) by inducing each in CI (qemu removed from PATH, port already bound, etc.) and capturing current output. Shape the struct around what's observed, not what's imagined.
- [ ] [P2] **Wizard remediation map** — per-failure-code "Why" + "Try this" suggestions. Prereq: persist a session-log (or at least the last run) per machine so remediation references observed output, not training-data guesses.
- [ ] [P2] **Wizard storage preflight** — start with disk free, `qemu-img` present, socket_vmnet alive (if shared/bridged selected), port block free. Wire into code-review + error-handling tests so wizard failures get the same treatment as CLI failures.
- [ ] [P2] Wizard post-start credential access info when managed login used (explain `exec`, `get <machine> creds`, API method for bridged VMs)
- [ ] [P3] Boot-wait progress UX — `waitForBootWithProgress` added; per-probe logging (HTTP attempt, REST init, timeout budget) not yet implemented
- [ ] [P3] Windows named-pipe reliability — monitor/serial/QGA channels untested under load. Consider TCP port fallback (monitor = portBase + 7) if pipes unreliable
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

Canonical location for `routeros-qemu-chr` is `~/GitHub/routeros-skills/routeros-qemu-chr/` (symlinked into `~/.copilot/skills/` and `~/.claude/skills/`). `quickchr` is the reference implementation — keep `SKILL.md` + `references/quickchr-automation.md` aligned when QEMU/CHR behavior changes.

**Workflow note:** for now, edit the skill in-place under `~/GitHub/routeros-skills/` (local path; that repo is under git but the PR-based publishing flow isn't active yet — backlog too busy here). SKILL.md files themselves must never contain local paths. Long-term goal: shift to a PR workflow against `tikoci/routeros-skills` once the work queue here is sparser. Skill updates should be part of code review whenever QEMU/CHR behavior changes.

- [ ] [P2] **`references/quickchr-automation.md`** — trigger terms, `QuickCHR.start()` options, `ChrInstance` methods, port layout. Update whenever behavior changes here (e.g. when `upload()`/`download()` lands).

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

</details>

**Open CLI/UX work:**

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

- [ ] [P2] **sudo handling** — At CLI: error with a clear "sudo needed for vmnet/TAP" message; point to socket_vmnet / TAP pre-setup via brew services or systemd/launchd. In wizard: may prompt for sudo if a human explicitly chose a bridge network that requires it. **Do not re-exec `sudo quickchr start`** — agents often can't sudo, and wrapping CLI in sudo is invasive. Document the pre-setup paths so hosts are configured once and subsequent calls don't need root.
- [ ] [P3] **Windows — ship networking, not just docs** — Target: local parity with socket_vmnet UX via TAP-Windows adapter (OpenVPN TAP or wintun). **First step:** validate user-mode networking works today on Windows locally (not tested). Then add TAP driver detection + docs. Integration tests on `windows-latest` follow.
- [ ] [P3] macOS vmnet-bridged filter — Only physical interfaces (Multipass bug: virtual/bridge → errors)
- [ ] [P3] macOS multi-NIC socket_vmnet — Chained `socket_vmnet_client` calls (fd=3, fd=4). Verify exact fd numbering
- [ ] [P3] Linux TAP discovery — `quickchr networks` shows available TAPs/bridges. Document `tap-chr-shared` convention
- [ ] [P3] Linux CI — Rootless only (user + socket). No TAP unless self-hosted runners
- [ ] [P3] `--emulate-device` hardware profiles — start small: **hEX (5 NICs, no wifi)** is the clean first case. Add 1–2 more when there's a use case (RB5009 9-NIC is the obvious next). Lookup table embedded in quickchr; can ingest rosetta device data later. Limited by what QEMU can emulate — many RouterBOARD models have no viable QEMU profile.

**Rootless topologies (examples):**
Multi-CHR topologies with `user` + `socket` (rootless, CI-friendly). RouterOS tunneling (VXLAN, PPPoE, GRE, IPSec, VRRP over shared/bridged) documented in MANUAL.md. Examples below.

---

## Open — Machine Config & State

- [ ] [P2] **Machine `inspect` (not `upgrade`)** — Ship `quickchr inspect <name>` (or `status --inspect`) that validates a running/stopped machine against its stored config: REST reachable with managed creds, installed packages match, RouterOS version matches, user accounts as expected. **Reports only — does not fix.** Re-provisioning after the initial provision has too many failure modes (version bumps change behavior, creds may be rotated, package deps may change). If inspect flags a mismatch, recreate. Larger tikoci story: lack of a shared RouterOS backup/restore library; don't introduce post-provisioning commands here until that exists.
- [ ] [P2] **[?] Config schema rationalization** — Separate "desired config" (cpu, mem, packages, networks) from "runtime state" (pid, status, lastStartedAt). Safe edits: cpu, mem, name. **Needs a 20-line sketch** of the field split before implementation is actionable — which fields land in which bucket, what the migration does for existing `machine.json`. Priority/timing not confirmed.
- [x] **Pretty-format `machine.json`** — Already tab-indented in `state.ts:50` (`JSON.stringify(state, null, "\t")`).

---

## Open — Ecosystem & Integrations

### LLM & Agent Friendliness

**Validated patterns (keep investing):**

- **`examples/` as the first place agents look.** Observed 2026-04-22: external Sonnet agent under GitHub Copilot CLI, working on tikoci/donny, opened `examples/vienk/vienk.test.ts` very early — after the shared skill reference and package.json, before `src/lib/`. Used `vienk.test.ts` as its pattern anchor for writing new lab code. Keep examples as runnable `.test.ts` files, short and self-contained; each new example is load-bearing agent-onboarding surface.

- **Agents reach for `StartOptions.extraPorts` for custom forwarding but hit two frictions:** (1) not knowing the guest port number (had to grep or guess `smb=445`, `dude=2210`), and (2) not knowing a safe host port. Mitigations: well-known port registry + `--forward` CLI flag (see above).

**Open work:**

- [ ] [P2] Review CLI output and library API for LLM ergonomics — structured output options, clear error messages.
- [ ] [P2] Copilot skills and `.prompt.md` files — teach agents how to use quickchr. Update `~/GitHub/routeros-skills/routeros-qemu-chr/SKILL.md` in-place (see Paired skill maintenance).

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

- [x] **First-class file transfer on `ChrInstance`** — `upload(localPath, remotePath?)` and `download(remotePath, localPath)` shipped (`src/lib/quickchr.ts:518-538`, SCP plumbing in `src/lib/scp.ts`, integration test `test/integration/file-transfer.test.ts`). Unblocks the `dude` example. Skill recipes update for `routeros-qemu-chr/references/quickchr-automation.md` is the remaining follow-up.
- [x] [P1] **Well-known guest service port registry** — Lookup table so callers can write `extraPorts: [{name:"smb"}]` and get `guest:445, proto:"tcp"` auto-filled. Pairs with `--forward`. Output of the port-research spike.
- [x] [P2] **`examples/README.md` — document three consumption patterns** — Same customer spent visible reasoning on how to reference `@tikoci/quickchr` from a sibling experiment dir (bun link vs workspace vs local path vs published npm). Short README naming the three supported patterns and when to use each.
- [x] **`waitFor`, `captureInterface`, `tzspGatewayIp`, `portBase` on `ChrInstance`** (0.3.0, `e6ca0dc`) — Surfaces from tikoci/donny dude-agent lab (2026-04-23): manual polling loop for "/dude enabled: yes", hardcoded `lo0`/`10.0.2.2` for TZSP capture, and digging into `state.portBase` to pick a non-colliding socket port. All four properties + 9 unit tests shipped together.

**New friction surfaced from tikoci/donny dude-agent lab (2026-04-23) — not yet addressed:**

- [ ] [P2] **`exec()` soft-error detection** — RouterOS commands like `/dude/agent/add` may resolve successfully while their output contains an error string (e.g. `"doAdd Agent not implemented"`). Customer caught this only by reading output. Options: (a) opt-in `exec(cmd, { throwOnCliError: true })` that scans for known RouterOS error patterns in `output`; (b) document the limitation prominently and provide a helper like `isRouterOSError(output)`. Lab evidence first — collect 5–10 real soft-error strings before committing to a regex. **Not all output text is an error** (some commands legitimately echo `"failure"` in non-error context), so a strict allowlist is risky.
- [ ] [P3] **`exec()` multi-line/batch behavior — document or normalize** — Customer ran `exec("/tool/sniffer/set …\n/tool/sniffer/start")` and was unsure whether quickchr concatenates, splits, or sends as one REST request. Today `exec()` sends a single string; the REST endpoint runs only the first command and ignores subsequent lines. Either (a) add `execBatch(cmds: string[])` that sends each separately, or (b) document the single-command rule clearly in the JSDoc and add a runtime warning when `cmd.includes("\n")`. (a) is the cleaner API; (b) is the cheap safety net.
- [ ] [P4] **Rename or alias `secureLogin: false`** — Customer found this name cryptic ("had to check docs"). Real meaning: skip the managed `quickchr` user provisioning and leave admin password-less. Suggested alternative: `auth: "none"` or `noAuth: true`. Backwards-compat alias is cheap; deprecate `secureLogin` only if/when we hit semver 1.0.
- [ ] [P3] **Validate `version` vs `channel` mix-up** — Customer accidentally passed a channel name (`"long-term"`) to the `version` field; `resolveVersion()` was lenient enough that boot still worked, masking the bug for a long time. Add a startup check: if `version` matches a known `Channel` literal, throw `QuickCHRError("INVALID_VERSION", ..., "Did you mean channel: \"long-term\"?")`. Five-line guard, big payoff for agent confusion.
- [ ] [P4] **Discoverability — `upload()`/`download()`/`rest()` already exist** — The same agent didn't realize these were already shipped and reasoned through implementing them from scratch. Suggests `MANUAL.md`/`README.md` API surface table is buried. Light fix: top-of-MANUAL "ChrInstance methods at a glance" table with a one-liner per method; pair with the `references/quickchr-automation.md` skill update already tracked above.

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

**Open examples — each needs a 1-page design (topology sketch, .rsc seeds, assertions) before coding:**

- [ ] [P4] tris (3-CHR hub-and-spoke, OSPF) — Makefile, bun:test, Python, README, hub.rsc, branch-a.rsc, branch-b.rsc
- [ ] [P4] solis (sequential version migration) — Makefile, bun:test, Python, README, rb5009-sample.rsc
- [ ] [P4] trauks (/app container testing) — Makefile, bun:test, Python, README, github-workflow.yaml
- [ ] [P4] divi (2-CHR redundancy, VRRP+VXLAN) — Requires root. Makefile, bun:test, Python, README, chr-a.rsc, chr-b.rsc
- [ ] [P4] **dude** (Dude package + custom `.db` load, from tikoci/donny 2026-04-22) — Now unblocked (`upload()`/`download()` shipped). Boot CHR, `installPackage("dude")`, `chr.upload(localDb, "/dude/dude.db")`, `exec("/dude/set enabled=yes data-directory=dude")`, assert `/dude/devices/print` matches seeded devices. Doubles as anchor test for the file-transfer API and reference for any `/dude/*` work.

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
- **`quickchr upgrade <name>`** — Replaced by `quickchr inspect` (reports mismatch; user recreates). Avoid post-provisioning mutations.
- **`--no-ansi` flag** — ANSI is fine in text output; `grep`/`jq` handle it. The underlying discipline (separate presentation from content) is addressed by "Centralize error-message surface".
- **`machine.json` → `machine.yaml`** — Staying JSON; pretty-printing addresses readability. YAML adds complexity for `jq` users without a matching benefit.
- **Separate multi-version/multi-arch test matrix runner** — Current CI matrix + `examples/matrica` cover this.
