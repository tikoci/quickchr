# quickchr Backlog

> Open work and design questions still under discussion live below. Completed items are collapsed to one-liners — full implementation notes are in git history, MANUAL.md, DESIGN.md, or `.github/instructions/*.md`. See the signal extraction report (in session state) for the mapping.

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
- [x] Bumped to 0.1.1 (`36ad135`). Per the odd/even policy, 0.1.1 is the first GitHub release (CI not yet green on hosted repo). Promote to 0.2.x after CI passes on the GitHub Actions runner matrix.

**Docs:**

- [x] README.md full rewrite (`36ad135`): all commands, full flag table, port offsets corrected
- [x] Split README → CONTRIBUTING.md (`36ad135`)
- [x] CHANGELOG.md created ([0.1.1] covering all implemented features as of first GitHub push)
- [x] SECURITY.md (minimal, points to GitHub Security Advisories)
- [x] JSDoc audit on barrel + QuickCHR + StartOptions (`36ad135`)
- [x] Comment audit (no stale TODO/FIXME in src/) (`36ad135`)

**Agent discoverability:**

- [ ] Create SKILL.md for `~/.copilot/skills/` so agents discover quickchr as CHR-via-QEMU entrypoint (trigger: "spin up CHR", "boot RouterOS locally"). Check if `~/.copilot/skills/routeros-qemu-chr/SKILL.md` should be the home instead

**Cross-platform testing:**

- [ ] Test from Linux host (bundle workflow: `git bundle create`, `scp`, `git clone`, `bun install && QUICKCHR_INTEGRATION=1 bun test`)
- [ ] Verify `quickchr completions --install` on bash and fish (zsh tested, bash/fish untested on real shells per `f7ca662`)
- [ ] Verify `qemu-img` detection + `--boot-size` on Linux (Intel Mac tested, arm64 Linux needs KVM pass)
- [ ] **Run full integration suite on Windows (QEMU for Windows)** — currently only unit tests run on `windows-latest`. Requires: install QEMU for Windows in CI, validate named-pipe channels under load, confirm `socket_vmnet`-equivalent network plumbing or document SLiRP-only mode. Track CHR boot timing on Windows + KVM-equivalent (WHPX) vs TCG.
- [ ] **clean() second-boot timeout on arm64** — `clean() resets disk to factory defaults` integration test is skipped on arm64 because the second boot (after clean()) consistently times out at 480s. Same flow on x86 KVM completes in ~66s. Likely a firmware/vars or pflash state interaction with the freshly-cleaned disk on the QEMU `virt` machine. Investigate whether `clean()` should also reset UEFI vars on arm64, or whether `_launchExisting` needs different args after a clean.
- [ ] **Bun arm64 node:http stale-response after GET→POST** — On `linux/aarch64` runners, `restPost` to `/rest/execute` returns the response body of the immediately-prior `restGet` to `/user/ssh-keys` (same host:port). All known workarounds applied (`agent: false`, `Connection: close` header, `node:http` instead of `fetch`) but the bug persists on arm64 only — same code on x86_64 works correctly. Two tests in `exec.test.ts` (`exec as managed quickchr user succeeds`, `exec with explicit provisioned credentials succeeds`) skipped on arm64. Likely a Bun runtime bug in aarch64 `node:http`. Reproduce in isolation, file upstream issue, or migrate to `child_process.spawn("curl")` for arm64.

**Test coverage gaps:**

Coverage is 79.59% funcs / 67.86% lines (above thresholds). Remaining sub-70 candidates: `rest.ts` (41.76%), `packages.ts` (37.78%), `device-mode.ts` (61.36%), `platform.ts` (57.98%), `qemu.ts` (69.81%). Don't chase numbers; add tests when they prove correctness of uncovered paths.

- [x] credentials.ts, license.ts, secrets.ts, completions.ts, images.ts (all above 73%)
- [ ] Cache retention policy for CHR images and extra packages (design needed: age-based vs count-based, user-facing commands, avoid deleting assets for active machines)

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
- [x] `start()` always waits for boot (background+no-provisioning was immediate without waitForBoot)

</details>

**Open robustness items:**

- [ ] Boot-wait progress UX — `waitForBootWithProgress` added; per-probe logging (HTTP attempt, REST init, timeout budget) not yet implemented
- [ ] Windows named-pipe reliability — monitor/serial/QGA channels untested under load on Windows. Consider TCP port fallback (monitor = portBase + 7) if pipes unreliable
- [ ] LLM-actionable error diagnostics — structured `{code, message, hint, diagnostics?}` payloads with 50-char context to reduce agent guesswork
- [ ] `/system/shutdown` exec returns HTTP 400 — handle gracefully. **Test locally first:** enable RouterOS debug logging (`/system/logging`, `/log/print`), capture HTTP via `/tool/sniffer` or `tshark`, understand shutdown sequence
- [ ] Wizard remediation map — per-failure-code "Why" + "Try this" suggestions for seamless UX
- [ ] Wizard post-start credential access info when managed login used (explain `exec`, `get <machine> creds`, API method for bridged VMs)
- [ ] Wizard storage preflight — run doctor-style checks before interactive flow (low-disk, prerequisites) so failures happen early

### Documentation

- [ ] Draft MANUAL.md covering CLI, library API, provisioning, storage layout. Command tree diagram for CLI rationalization. Document `exec` design (`--via=auto|ssh|rest|qga|console`), `console`/`attach` as serial access

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

### SKILL References

<details>
<summary>Completed SKILL.md files (~/.copilot/skills/routeros-fundamentals/references/)</summary>

- [x] routeros-scripting.md — `:execute` vs `:do`, `:parse`, `:serialize`, script permissions/policies
- [x] routeros-firewall-rest.md — `/ip/firewall/filter`, `/nat`, `/mangle` CRUD; `place-before` gotchas
- [x] routeros-users-rest.md — `/user` CRUD, `/user/group`, `/user/ssh-keys`, admin expired flag (REST unaffected)
- [x] routeros-networking-rest.md — `/ip/address`, `/ip/route`, `/ip/dhcp-client`, `/ip/dns`, `/interface`
- [x] bun-runtime-gotchas.md — 4 bugs consolidated (req.destroy silence, connection pool, Keychain, event loop)

</details>

**Missing SKILL references (to create):**

- [ ] quickchr-automation.md — Trigger terms, `QuickCHR.start()` options, `ChrInstance` methods, port block layout
- [ ] routeros-logging-rest.md — `/log/print`, topic hierarchy, filtering with `where`
- [ ] qemu-monitor-protocol.md — Monitor socket commands (`system_reset`, `quit`, `info status`)
- [ ] routeros-identity-rest.md — `/system/identity` GET/set, `/system/resource` full field list

**Open lab tests (to run):**

- [ ] SCP package upload — Third-party `.npk` via SCP → apply-changes
- [ ] QGA file delivery — Can `guest-file-write` deliver `.npk` on x86 CHR?
- [ ] Multi-package enable version test — Apply-changes first in 7.18; <7.18 must use `/system/reboot`
- [ ] Serial console device-mode — Observe countdown timer during device-mode/update
- [ ] Large duration async — Memory implications of `duration="60s"` on monitor-traffic
- [ ] License success shape — Confirm `"done"` path with valid MikroTik.com credentials
- [ ] ed25519 SSH key version — When added? Test on 7.16+/7.18+ CHR

<details>
<summary>Completed lab tests</summary>

- [x] SSH key provisioning lab (2025-07-17) — `add` (inline RSA-only on 7.10) vs `import` (upload file); ed25519/ECDSA unsupported on 7.10; DELETE 204; `test/lab/ssh-keys/REPORT.md`
- [x] Multi-package enable (7.10 tested) — `enable`/`disable` + `reboot` works; `/system/package/apply-changes` added in 7.18
- [x] SLiRP hostfwd experiment (2026-04-17) — Requires guest IP 10.0.2.15; user-first ordering correct; `test/lab/slirp-hostfwd/`
- [x] Bun HTTP pool (disproved) — `test/lab/bun-pool/REPORT.md`

</details>

### Bun HTTP Client Decision

**Rule:** Use `fetch()` except for long-polling/blocking CHR REST endpoints (device-mode, exec).
**Reason:** Bun's `req.destroy()` doesn't emit error → promise hangs on timeout (real bug, reproducible). The pool bug was NOT reproduced (`test/lab/bun-pool/REPORT.md`).

**TODO:**
1. File Bun issue for `req.destroy()` error silence
2. Re-test on Bun major versions
3. Unify to `fetch()` if Bun fixes it

---

## Open — CLI / UX

### CLI Design Principles

**Interactive prompts confined to `setup`** — All other commands non-interactive (no selectors). Without `<name>`, print list + tip.
**`start`/`stop` are pure operations** — No wizard, no creation. `add` creates, `setup` is wizard.
**`set`/`get` for machine config** — License, device-mode, admin accounts via unified interface.
**`--json` and `--yaml` on all read commands** — Structured output for scripts/agents.

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

- [ ] `exec --json` / `--serialize=json|yaml|tsv|csv` — Re-add auto-wrap for `:serialize`. Canonical: `--serialize=`, `--json` as alias
- [ ] **`--forward <name>:<host>:<guest>[/tcp|udp]` on `quickchr add`** — Surface `extraPorts` as a repeatable CLI flag. Today, forwarding a guest service (e.g. SMB/445, Dude/2210) requires constructing the full `extraPorts` array in code; there is no CLI equivalent. An external agent (2026-04-22 lab session) had to discover the `StartOptions.extraPorts` shape by grepping types.ts before knowing how to expose SMB. A `--forward smb:9145:445` flag would make one-off forwarding discoverable.
- [ ] SSH transport for `exec` — `--via=ssh` (key provisioning done, transport itself not implemented). Depends on SSH key in machine dir
- [ ] `--via=auto` smart routing — REST first → console fallback → QGA (x86) → SSH. Currently REST-only
- [ ] `exec --lint` — Pre-validate via `/console/inspect request=completion`. Depends on lsp-routeros-ts extraction (~50 lines)
- [ ] User preference overrides / settings architecture — Design incomplete (`.local` config, `prefer-transport`, `default-timeout`). Half anti-pattern without clear scope
- [ ] `list` enrichment — Live QEMU stats (CPU/mem via monitor) for detail view
- [ ] `doctor` enhancements — OS-level diagnostics (ps/port scan, stale machines, socket conflicts), `--export` for bug reports
- [ ] ANSI table cleanup — Minimal style, terminal-width-aware, no new box borders
- [ ] `--serialize=` output on all read commands (list, get, networks, doctor, exec) — TSV for `head`/`tail`/`cut`
- [ ] Version staleness reporting in `doctor` — Odd/even policy, days-behind-latest, color-coded status

---

## Open — Disks & Snapshots

<details>
<summary>Completed disks & snapshots work</summary>

- [x] Extra disks (`--add-disk 512M`), disk resize (`--boot-size`), qcow2 conversion, state persistence
- [x] Integration tests (disk artifacts, RouterOS-visible drives)
- [x] Snapshots (savevm/loadvm/delvm/list via monitor, `SnapshotInfo` type, `ChrInstance.snapshot` API)
- [x] `quickchr snapshot` CLI (`--json`), wizard UX (formatted table, ISO dates, qcow2 guard)

</details>

**Open disks & snapshots:**

- [ ] Windows smoke test (global install, PATH detection for `qemu-system-*` and `qemu-img`)
- [ ] RouterOS `:export` alongside VM snapshot — Auto-save config dump when snapshotting (unless disabled/no-creds)

---

## Open — QGA & Credentials

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

**Open QGA & credentials:**

- [ ] **x86 QGA broken on macOS / QEMU 10.x** — QEMU bug (never sends `VIRTIO_CONSOLE_PORT_OPEN`). Root cause confirmed. See `docs/qga-x86-macos-qemu10-investigation.md`. No workaround without patching QEMU
- [ ] ARM64 QGA — MikroTik bug; once fixed, extend tests to arm64
- [ ] `--via=auto` smart routing — REST → QGA (x86) → console → SSH (key provisioned, transport not impl)
- [ ] Credential profiles — Save/restore user+password per machine or shared default (design incomplete, tracked in Deferred)

---

## Open — Networking

See `docs/networking.md` for platform internals (QEMU, socket_vmnet, TAP, Windows). Priority: macOS (local) & Linux (CI) → Windows.

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

- [ ] sudo handling — Transparent `sudo quickchr start` when vmnet/TAP needed. No daemon requirement. Wizard detects root, adjusts options
- [ ] macOS vmnet-bridged filter — Only physical interfaces (Multipass bug: virtual/bridge → errors)
- [ ] macOS multi-NIC socket_vmnet — Chained `socket_vmnet_client` calls (fd=3, fd=4). Verify exact fd numbering
- [ ] Linux TAP discovery — `quickchr networks` shows available TAPs/bridges. Document `tap-chr-shared` convention
- [ ] Linux CI — Rootless only (user + socket). No TAP unless self-hosted runners
- [ ] Windows — Document TAP-Windows adapter install (OpenVPN TAP or wintun). No auto-config
- [ ] `--emulate-device` hardware profiles — RB5009 (9 NICs), hAP ax3 (5 ports). Lookup table from rosetta device data
- [ ] **`DEFAULT_PORT_BASE` conflict risk** — 9100 is registered as JetDirect/PDL (printers); common on developer LAN. Consider raising default to a less-congested range (19100, or 10000+). Low-severity but enough friction that an external agent noted it in 2026-04-22 lab session.
- [ ] **`extraPorts` host-port collision detection** — `allocatePortBlock()` only avoids collisions between instance *base* ports; manually-specified `host:` in `extraPorts` bypasses all conflict checking. Example from lab session (2026-04-22): `extraPorts: [{name:"smb", host:9145, guest:445}]` lands in block 9140–9149 (5th instance's range). Fix: `buildPortMappings` should validate explicit `host:` against all live allocations (from `listMachines()`), just like `findAvailablePortBlock`. Also: auto-allocated extra slots at `portBase+6+i` overlap with Windows IPC channel offsets (monitor=+6, serial=+7, qga=+8), leaving only offset +9 before spilling into the next block. Either widen `PORTS_PER_BLOCK` or allocate extra ports from a separate pool above the service block.
- [ ] **Named socket auto-create in API** — `networks: [{type:"socket", name:"foo"}]` currently requires a prior `quickchr networks sockets create foo` CLI step or the API throws. If the named socket doesn't exist at `start()` time, auto-create it (and document it as created by that machine, to be removed on `remove()`). Reduces friction for multi-CHR scripts that wire up their own topology without a separate CLI pre-step.

**Rootless topologies (examples):**
Multi-CHR topologies with `user` + `socket` (rootless, CI-friendly). RouterOS tunneling (VXLAN, PPPoE, GRE, IPSec, VRRP over shared/bridged) documented in MANUAL.md. Examples deferred to P6 below.

---

## Open — Machine Config & Version Checks

- [ ] Config schema rationalization — Separate "desired config" (cpu, mem, packages, networks) from "runtime state" (pid, status, lastStartedAt). Safe edits: cpu, mem, name. Document schema, user-editable sections
- [ ] Doctor version reporting — quickchr staleness, RouterOS image staleness, color-coded status (odd/even policy, days-behind-latest)

---

## Open — Ecosystem & Integrations

### LLM & Agent Friendliness

**Validated patterns (keep investing):**

- **`examples/` as the first place agents look.** Observed 2026-04-22: external Sonnet agent running under GitHub Copilot CLI, working on tikoci/donny, reached for `examples/vienk/vienk.test.ts` very early in its exploration — after reading the shared skill reference and package.json, it opened the examples directory before diving into `src/lib/`. It then used `vienk.test.ts` as its pattern anchor for writing new lab code. **Implication:** keep examples as runnable `.test.ts` files (not prose), keep them short and self-contained, and treat new examples as load-bearing agent-onboarding surface — each `examples/<name>/` closes a capability gap and becomes the template next agent copies. This validates the current direction; don't let examples rot.

- **Agents reach for `StartOptions` via `extraPorts` for custom forwarding, but struggle with two things: (1) not knowing the guest port number (had to grep or guess `smb=445`, `dude=2210`), and (2) not knowing a safe host port that doesn't collide with another instance's block.** Observed 2026-04-22 tikoci/donny lab session. Agents can handle `extraPorts` once they find it; the friction is the two-step discovery (what type? what port?). Mitigations: well-known port registry + `--forward` CLI flag (see networking and CLI/UX open items).

**Open work:**

- [ ] Review CLI output and library API for LLM ergonomics — structured output options, clear error messages
- [ ] Copilot skills and `.prompt.md` files — teach agents how to use quickchr. Update `~/.copilot/skills/routeros-qemu-chr/SKILL.md`
- [ ] MCP server — expose quickchr API over MCP protocol. Lower priority than making CLI/library natively agent-friendly

### VS Code Integration

- [ ] tikoci/vscode-tikbook — quickchr library as backend for CHR manager sidebar (replaces UTM-via-AppleScript)

### Test Matrix Runner

- [ ] Multi-version, multi-arch test runner using quickchr as engine. Simpler than other tikoci projects since quickchr doesn't rebuild per release

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

**Open library friction (active):**

- [ ] **First-class file transfer on `ChrInstance`** — add `upload(localPath, remotePath?)` and `download(remotePath, localPath)`. Today the only SCP code is buried in `src/lib/packages.ts::uploadPackages()` (internal, push-only). Customer (tikoci/donny, Copilot-CLI + Sonnet, 2026-04-22) ran four separate greps across `quickchr.ts` / `index.ts` / `packages.ts` hunting for `scp|upload|sendFile|sftp|putFile` before concluding there was no public SCP method and planning to shell out manually. Factor the SCP helper out of `packages.ts`, reuse for both push and pull. Common cases: seed a `.db` before enabling `/dude`, push a `.rsc` for `:import`, pull `/log/` exports, pull `/file/print` artifacts. Update shared-skill reference (`routeros-skills/routeros-qemu-chr/references/quickchr-automation.md`) with a recipes section.
- [ ] **Well-known guest service port registry** — Add a lookup table of common RouterOS/guest service ports (smb/445, dude/2210, ftp/21, http-alt/8080, winrm/5985, snmp/161-udp) so callers can write `extraPorts: [{name:"smb"}]` and get `guest:445, proto:"tcp"` auto-filled. Today the agent had to know `guest:445` to forward SMB. Combine with `--forward` CLI flag (see CLI/UX). Could be a `WELL_KNOWN_GUEST_PORTS` constant alongside `SERVICE_PORTS` in `types.ts`, or merged into a single extended map.
- [ ] **`examples/README.md` — document three consumption patterns** — Same customer spent visible reasoning on how to reference `@tikoci/quickchr` from a sibling experiment directory (bun link vs workspace vs local path vs published npm). `examples/vienk` and `examples/matrica` exist but don't frame the *why* of their layout. Short `examples/README.md` naming the three supported patterns and when to use each would close this.

### Examples (Rootless Multi-CHR Topologies)

**Design principles:**
- Every example must work with `user` + `socket` (rootless) as baseline
- Every CHR keeps `user` mode (ether1) for management — tests assert via REST API
- Socket links create data-plane topology. RouterOS protocols (OSPF, VXLAN, PPPoE) run on top
- At least tris, solis, matrica CI-testable (rootless). divi requires root (VRRP)

**Completed examples:**

<details>
<summary>matrica (parallel version matrix) and vienk (simple single-machine)</summary>

- [x] `examples/matrica/matrica.test.ts` — LITE mode (2 channels, native arch, no extra packages) + full mode (4 channels, native arch, zerotier+container)
- [x] `examples/matrica/Makefile`, `matrica.py`, `README.md`, `rb5009-arm64.rsc`
- [x] `examples/vienk/vienk.test.ts` — simple quickstart (boot, identity, interface list, native arch, stable) (`36ad135`)
- [x] `examples/vienk/README.md` — quickstart guide with timing table

</details>

**Open examples:**

- [ ] tris (3-CHR hub-and-spoke, OSPF) — Makefile, bun:test, Python, README, hub.rsc, branch-a.rsc, branch-b.rsc
- [ ] divi (2-CHR redundancy, VRRP+VXLAN) — Requires root. Makefile, bun:test, Python, README, chr-a.rsc, chr-b.rsc
- [ ] solis (sequential version migration) — Makefile, bun:test, Python, README, rb5009-sample.rsc
- [ ] trauks (/app container testing) — Makefile, bun:test, Python, README, github-workflow.yaml
- [ ] dude (Dude package + custom `.db` load) — from tikoci/donny ask, 2026-04-22. Boot CHR, `installPackage("dude")`, `chr.upload(localDb, "/dude/dude.db")`, `exec("/dude/set enabled=yes data-directory=dude")`, assert `/dude/devices/print` matches seeded devices. Doubles as anchor test for new `upload()`/`download()` API and as reference for any `/dude/*` work. Prerequisite: upload/download API landed.

---

## Deferred

Items moved here are not rejected — deferred until prerequisites met or need becomes clear.

### TUI Mode

- [ ] TUI (blessed-contrib / ink / bubbletea) — **Content first:** maximize useful info in 80×24 before building dashboard. Dashboard is rendering layer over structured data — build data layer first (`--serialize` output, settings architecture)

### Templates & Upgrade

- [ ] Machine templates (save/apply config presets) — Lower priority; agents can already compose options
- [ ] `quickchr upgrade <name>` — In-place RouterOS version upgrade. Tension: test workflows prefer fresh instances. May be better as declarative `ensure.version` in machine config

### Config Import/Export

- [ ] Config `.rsc` / `.backup` import — Load RouterOS export/backup as part of machine creation
- [ ] `machine.json` → `machine.yaml` migration — YAML friendlier for humans/LLMs

### Output Polish

- [ ] `--no-ansi` flag — Complex with `@clack/prompts` (ANSI deeply embedded). ANSI may help LLM parsing
- [ ] Snapshot search in wizard — `@clack/prompts` search for machines/snapshots when lists grow large (>16)

### Auto-Update

- [ ] Auto-upgrade check — Notify when newer quickchr available. Passive notice, not blocker. Defer until version reporting in `doctor` solid

### Credential Profiles

- [ ] Credential profiles — Save/restore username+password per machine or shared default (design incomplete)

---

## Won't Fix / Out of Scope

- **Cloud deployment** — Reference: `~/GitHub/chr-armed` has working code for OCI + AWS. Archived pending quickchr maturity. Once local CHR is solid, cloud targets can reuse provisioning and image management layers.
- **Multi-CHR orchestration** — Out of scope for CLI/library. `examples/` directory shows patterns; users/agents handle orchestration.
- **Packaging (Homebrew/Deb)** — Deferred to P4 (lower priority than core functionality).
- **Service management (launchd/systemd)** — Deferred to P4 (optional promotion for long-running instances, not requirement).

