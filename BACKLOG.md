# quickchr Backlog

## Completed

<details>
<summary>P0 — MVP (all done)</summary>

- [x] Core library modules (types, platform, versions, network, state, images, qemu, channels)
- [x] QuickCHR class API (start, list, get, doctor)
- [x] ChrInstance (stop, remove, clean, rest, monitor, serial, qga)
- [x] CLI with subcommands (start, stop, list, status, remove, clean, doctor, version, help)
- [x] Interactive wizard (@clack/prompts)
- [x] Unit tests (versions, network, state, platform, qemu-args)
- [x] Integration test scaffolds (start-stop, library-api)

</details>

<details>
<summary>P1 — Robustness (all done)</summary>

- [x] Foreground mode correctly awaits QEMU exit
- [x] Package SCP uses `sshpass` for RouterOS empty-password auth
- [x] Background mode is default; `--fg`/`--foreground` opts in to foreground
- [x] Arch-specific package lists (zerotier/wifi-qcom arm64-only)
- [x] `start --all` restarts all stopped machines
- [x] Interactive selectors for all commands when no name given
- [x] `remove --all` removes all machines
- [x] Foreground tips printed before QEMU launches
- [x] `status` output includes WinBox URL, SSH tip, state explanation
- [x] `sshpass` in `doctor` dependency check
- [x] `QUICKCHR_NO_PROMPT=1` suppresses interactive prompts
- [x] `waitForBoot` accepts 401/403 as "booted"
- [x] Boot timeout unified to 120s
- [x] Warning on boot timeout with pending provisioning
- [x] SSH warmup delay (2s) after HTTP up
- [x] Package install integration test (`container` package + REST verify)
- [x] Integration tests mandatory before commits
- [x] Foreground provisioning: boot → provision → attach serial (skip in non-TTY)
- [x] Wizard hints per mode (Ctrl-A X vs Ctrl-C)
- [x] Wizard 2s sleep before QEMU launch
- [x] `isPortAvailable` TCP connect probe (not SO_REUSEADDR bind)
- [x] `detectAccel` arm64 HVF uses `process.arch` (Intel Mac safety)
- [x] Provisioning integration test (user creation, admin disable, foreground non-TTY)
- [x] Dynamic package list via `all_packages.zip` download (no static `KNOWN_PACKAGES`)

</details>

<details>
<summary>CI & Publish (done)</summary>

- [x] CI matrix: linux/x86_64 + linux/aarch64; macOS optional via dispatch
- [x] Coverage enforcement: 75% funcs / 60% lines (warn, not hard-fail)
- [x] CI artifacts: coverage-report (14d), integration-logs-{platform} (7d)
- [x] Step summaries written to `$GITHUB_STEP_SUMMARY`
- [x] `publish.yml` runs lint + typecheck + unit tests before npm publish

</details>

---

## P1 — Ship Shape

Tighten before expanding. These are preconditions for most items below.

### Anchor Manual (MANUAL.md)

Highest-priority doc task. Write a comprehensive user guide **describing exactly how quickchr works today** — every command, every option, every provisioning step, port layout, storage layout. Like tikoci/mikropkl's QEMU.md but better. This is the "anchor document" (same concept as anchor tests): a human-readable spec that both users and agents reference, and that surfaces gaps when reality diverges from documentation.

- [ ] Draft MANUAL.md covering current CLI, library API, provisioning, and storage layout
- [ ] Include command tree diagram (becomes input for CLI rationalization)
- [ ] Document `exec` design: `exec --via=auto|ssh|rest|qga` (auto = try SSH first, fall back to REST `/execute`). `--output=json|csv|tsv` — on RouterOS, wrap commands in `[:serialize to=json [<cmd>]]` for structured output. `--via=auto` is the default.
- [ ] Document `console`/`attach` as the name for interactive serial access (currently hidden in `start --fg`)

The manual drives CLI design decisions forward — writing how it *should* work forces the design questions that "CLI rationalization" was deferring.

### Provisioning

- [ ] `/system/device-mode` support — `update container=yes scheduler=yes ...` with mode selection (`advanced`/`enterprise`/etc). Required for containers and other restricted features. Reference: tikoci/mikropkl `qemu.sh` handles this; chr-armed provisions device-mode via serial console.
- [ ] License apply should read back and verify via REST after write — RouterOS commands vary by version; early detection beats debugging later
- [ ] First-boot serial console provisioning (from chr-armed): prompt detection with buffer offset tracking, `\r` not `\r\n` for PTY. Pattern worth lifting if we add console-based provisioning.

### Robustness

- [ ] Graceful SIGINT/SIGTERM cleanup in foreground mode (currently leaves pid file)
- [ ] Lock file to prevent concurrent starts of same machine
- [ ] Better error messages for common QEMU failures (EFI size mismatch, permission denied)
- [ ] Retry download on transient network errors
- [ ] Machine name validation — reject names starting with `-` to prevent flag confusion (e.g. `quickchr start -fg` creating a machine named `-fg`)

### Docs & Project

- [ ] Split README.md → CONTRIBUTING.md: move `git clone`, dev setup, and contributor workflow out of README so it focuses on end-user usage
- [ ] Align test coverage organically — don't chase numbers, but audit gaps. If something isn't unit testable, add an integration test. Add comments where tests are intentionally skipped.

---

## P2 — CLI & UX

### New Commands

- [ ] `quickchr logs <name>` — tail `qemu.log`
- [ ] `quickchr exec <name> <command>` — run a RouterOS CLI command. Default `--via=auto` tries SSH, falls back to REST `/execute`. Options: `--via=ssh|rest|qga`. Output: `--output=text|json|csv|tsv` (RouterOS trick: wrap in `[:serialize to=json [<cmd>]]` for structured output; see tikoci/restraml `lookup.html` for CLI→REST mapping).
- [ ] `quickchr console <name>` — attach to serial console of a running background instance (current `attachSerial` logic, promoted to a top-level command)

### Shell Completions

- [ ] Completions for bash, zsh, fish — subcommands, machine names, `--flag` options
- [ ] Explore generating completions without requiring Homebrew/package install (standalone shell script)

### Output & Display

- [ ] ANSI table cleanup — replace heavy box-drawing borders with minimal style; improve color usage and terminal-width-aware column layout for clean copy-paste
- [ ] `quickchr status <name>` enrichment — pull live QEMU stats (CPU, memory) via monitor channel, tail recent qemu.log, show richer details from machine state
- [ ] `doctor` enhancements — OS-level diagnostics: `ps`/port scan correlated with our PID files, stale machine detection (not started in >10 days), "prescription" hints for each finding. Keep `status`/`list` for per-machine detail; `doctor` is system-wide health.

### TUI Mode (exploratory)

- [ ] Full terminal UI with interactive controls — passgo-style (see rootisgod/passgo for multipass). Live machine list with start/stop/status actions. Lower priority but a natural evolution of the wizard.

---

## P3 — Core Features

### Disks

- [ ] Extra disks — attach N additional blank qcow2 disks at specified sizes (`--disk 512M`), so RouterOS can format/use them. Simpler than resize; just append `-drive` + `-device` to QEMU args.
- [ ] Disk resize support (`--disk-size 512M` for the primary disk)

### Snapshots

- [ ] QEMU snapshot/restore via monitor `savevm`/`loadvm`
- [ ] Start with an integration test to validate it actually works (resolve technical risk first). Consider saving RouterOS `:export` alongside the VM snapshot for a richer "checkpoint" concept.

### QGA (Guest Agent)

- [ ] Integration tests for QGA on x86 — verify `guest-sync-delimited`, basic commands. We offer the QGA channel but don't currently test it. Reference: tikoci/mikropkl Lab has extensive QGA exploration.
- [ ] QGA file operations — push config files via guest agent (x86 only today)
- [ ] ARM64 QGA — MikroTik has an open bug for ARM64 guest agent support. Once fixed, extend tests to arm64. Be ready to test when the fix drops.

### Machine Config

- [ ] `machine.json` → `machine.yaml` migration — YAML is friendlier for humans and LLMs. Accept `.json` as fallback; prefer `.yaml` when both exist.
- [ ] Config schema rationalization — separate "desired config" (cpu, mem, packages, network) from "runtime state" (pid, status, lastStartedAt). Users should be able to edit the config section and have changes apply on next start. Safe edits: cpu, mem, name. Complex edits: packages (drift detection between file and RouterOS). Document the schema and what is/isn't user-editable.
- [ ] Config `.rsc` / `.backup` import — load a RouterOS export script or backup as part of machine creation, for reproducible test environments.

### Credentials

- [ ] Credential profiles — save/restore username+password per machine or as a shared default. `rest()` and CLI commands auto-use stored credentials. Clack prompts handle the "which credential?" decision interactively.

### Templates & Upgrade

- [ ] Machine templates (save/apply config presets) — lower priority; agents can already compose options. Revisit after config schema is solid.
- [ ] `quickchr upgrade <name>` — in-place RouterOS version upgrade. Tension: test workflows prefer fresh instances over in-place mutation. May be better as a declarative `ensure.version` in machine config than an imperative command. Defer until config schema design settles.

### Version Checks

- [ ] Auto-update check — notify when a newer QEMU or RouterOS version is available. Ties into tikoci's existing routeros-channel-check workflows.

---

## P4 — Distribution & Packaging

### Publishing

- [ ] npm publish workflow needs `NPM_TOKEN` secret in repo settings (workflow exists)
- [ ] CI image cache auto-invalidation — detect stale cache via RouterOS release feed instead of manual `-v1` suffix bumps

### Packaging

- [ ] Homebrew formula — first distribution target. Link to daemonization: a `brew services` managed quickchr could promote instances to launchd services. Homebrew is easiest to test (macOS primary platform); Deb package as second target (testable in CI).
- [ ] `bun compile` binary builds — lower priority. Bun runtime dep is acceptable; avoids Gatekeeper/SmartScreen signing hassles on macOS/Windows.
- [ ] AppImage or creative alternatives — keep the barrier low. Avoid signing/notarization overhead where possible.

### Service Management

- [ ] Daemonization support — promote a quickchr machine to a system service (launchd on macOS, systemd on Linux, Scheduled Tasks on Windows). Should be "proper" — wrapped in a real package, not loose files. Linked to Homebrew/Deb packaging.

### CI

- [ ] Windows CI runner — add after existing macOS/Linux matrix is proven stable. Windows adds new challenges (HAXM?, path conventions, no KVM/HVF).
- [ ] Multi-version test matrix — run integration tests across RouterOS versions. Simpler than other tikoci projects since quickchr doesn't rebuild per release.

---

## P5 — Networking

Platform priority: macOS → Linux → Windows.

### macOS

- [ ] vmnet-shared and vmnet-bridge testing — higher priority (primary dev platform). vmnet-shared needs root; vmnet-bridge needs `ifname` selection.

### Linux

- [ ] TAP networking — philosophy: **discover and present**, don't configure. Show available TAP interfaces (from `ip link`), let the user pick, generate the QEMU flag. Don't edit `/etc/network/` files or manage bridge creation. Link to tikoci docs for detailed setup guides.

### Multi-CHR (examples, not orchestration)

quickchr is the QEMU expert. Orchestrating multi-router topologies is out of scope for the CLI/library itself — that's the user's (or their agent's) job.

Provide an `examples/` directory with each scenario in three forms: **Makefile** (recipe-driven, tikoci tradition — see tikoci/netinstall), **bun:test** (library API, TypeScript), and **Python** (subprocess CLI, the language agents and network engineers both reach for). Building examples early finds CLI soft spots before we add more commands.

#### "divi" — 2-CHR Redundancy (Latvian for "two")

Two CHRs on the same LAN (`--vmnet-bridged` or TAP) with VXLAN tunnels over user-mode networking as OOB management. `/ip/vrrp` presents a redundant virtual router to the local network. Validates: multi-instance, VRRP failover, VXLAN over user-mode, mixed network modes.

- [ ] `examples/divi/Makefile`
- [ ] `examples/divi/divi.test.ts` (bun:test)
- [ ] `examples/divi/divi.py` (Python, subprocess CLI)

#### "trīs" — 3-CHR Hub-and-Spoke (Latvian for "three")

One hub + two branch offices. Dynamic routing via IS-IS (or OSPF). Tests topology convergence and route propagation between sites.

- [ ] `examples/tris/Makefile`
- [ ] `examples/tris/tris.test.ts` (bun:test)
- [ ] `examples/tris/tris.py` (Python, subprocess CLI)

---

## P6 — Ecosystem & Integrations

### LLM & Agent Friendliness

- [ ] Review CLI output and library API for LLM ergonomics — structured output options (JSON?), clear error messages, `QUICKCHR_NO_PROMPT` behavior audit
- [ ] Copilot skills and `.prompt.md` files — teach agents how to use quickchr to spin up RouterOS test environments. Also update `~/.copilot/skills/routeros-qemu-chr/SKILL.md` to reference quickchr.
- [ ] MCP server — expose quickchr API over MCP protocol. Lower priority than making CLI/library natively agent-friendly. Auth complexity (MikroTik credentials) makes MCP setup non-trivial. But tracked: enables tikoci project ecosystem (tikoci/restraml for schemas, tikoci/rosetta for docs-as-RAG).

### VS Code Integration

- [ ] tikoci/vscode-tikbook — quickchr library as the backend for a CHR manager sidebar. Replaces earlier UTM-via-AppleScript experiment. Cross-platform where UTM was Mac-only.

### RouterOS Config Diff

- [ ] Capture config before/after — conceptually linked to snapshots. Broader challenge: RouterOS `:export` output varies by options and version (implied defaults shift between releases). Proper diffing may need tikoci/restraml `inspect.json` alignment. Track as exploratory.

### Test Matrix Runner

- [ ] Multi-version, multi-arch test runner using quickchr as the engine. Simpler here than in other tikoci projects since quickchr doesn't need to rebuild per RouterOS release — just re-run integration tests with a different `--version`.

### Cloud Deployment (future)

Reference: `~/GitHub/chr-armed` — working code for CHR lifecycle on OCI (ARM64 A1.Flex + x86 E2.1.Micro) and AWS (x86 t3.micro). Provisioning via serial console with prompt detection + buffer offset tracking. Key lessons: ARM64 on AWS lacks ENA driver (use OCI for ARM64); raw OCI REST API (not SDK, Bun-compatible); security-list-first boot model (lock → boot → provision via serial → open ports). Archived pending quickchr maturity — once local CHR is solid, cloud targets can reuse the provisioning and image management layers.

---

## Cross-Cutting

Items that don't fit cleanly into one priority tier.

### Related tikoci Projects

| Project | Relationship to quickchr |
|---|---|
| tikoci/restraml | RouterOS API schemas; `lookup.html` maps CLI→REST for `exec --via=rest` |
| tikoci/rosetta | RouterOS docs as SQLite FTS5 RAG (MCP); helps agents write RouterOS commands |
| tikoci/mikropkl | Pkl-based QEMU support; extensive QGA lab work; `qemu.sh` handles device-mode |
| tikoci/netinstall | Elegant Makefile (~100 lines) for packaging; model for `examples/` Makefiles |
| tikoci/vscode-tikbook | VS Code extension; will use quickchr as backend (replacing UTM) |
| `~/GitHub/chr-armed` | OCI/AWS CHR deployment; serial console provisioning patterns; not yet on GitHub |
| `~/Lab/tiktui` | Archived HTMX+SSE experiment; lesson: don't combine experiments in one project |


