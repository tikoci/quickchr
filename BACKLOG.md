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
- [x] `publish.yml` runs lint (biome & tsc --noEmit) + unit tests before npm publish

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

- [x] `/system/device-mode` support — `update container=yes scheduler=yes ...` with mode selection (`advanced`/`enterprise`/etc). Required for containers and other restricted features. Opt-in only (not configured unless explicitly requested). CHR ships with mode=advanced. Wizard defaults to rose when user opts in.
- [ ] `instance.setDeviceMode(options)` — allow changing device-mode on a running instance via the library API. Requires the hard-reboot QEMU flow, unlike most config changes that are simple REST calls. Useful for test scenarios that need to toggle device-mode features between runs.
- [ ] License apply should read back and verify via REST after write — RouterOS commands vary by version; early detection beats debugging later
- [ ] First-boot serial console provisioning (from `~/GitHub/chr-armed`): prompt detection with buffer offset tracking, `\r` not `\r\n` for PTY. chr-armed handles the full first-boot sequence: license Y/n screen, forced password change, and command execution over serial. The serial approach is valuable when REST API is unavailable (pre-boot, broken config, netinstall recovery). Code to vendor from: `chr-armed/src/oracle/console.ts`.

### Robustness

- [x] Graceful SIGINT/SIGTERM cleanup in foreground mode (currently leaves pid file)
- [x] Lock file to prevent concurrent starts of same machine
- [x] Better error messages for common QEMU failures (EFI size mismatch, permission denied)
- [x] Retry download on transient network errors
- [x] Machine name validation — reject names starting with `-` to prevent flag confusion (e.g. `quickchr start -fg` creating a machine named `-fg`)

### Docs & Project

- [ ] Split README.md → CONTRIBUTING.md: move `git clone`, dev setup, and contributor workflow out of README so it focuses on end-user usage
- [x] Align test coverage organically — don't chase numbers, but audit gaps. Coverage report captured Apr 2026; specific gaps tracked in "Test Coverage Gaps" section below.

### Test Coverage Gaps

From `bun test --coverage` (Apr 2026). Don't chase numbers — each item should prove correctness of the covered path, not just hit lines.

**State utilities (unit — no QEMU):**
- [x] `state.ts`: unit tests for `updateMachineStatus`, `isMachineRunning`, `refreshAllStatuses`, and `pruneCache` — added to `test/unit/state.test.ts` (11 new tests)

**QEMU build + error paths (unit — no QEMU):**
- [x] `qemu.ts`: unit tests for TCG-specific arg generation (`tb-size=256`, correct CPU per arch) — added to `test/unit/qemu-args.test.ts`
- [x] `qemu.ts`: vmnet-shared and vmnet-bridge network mode arg generation — added to `test/unit/qemu-args.test.ts`
- [x] `qemu.ts`: additional `buildQemuErrorMessage` patterns — EFI+size branch covered
- [ ] `qemu.ts`: `waitForBoot` timeout/warning branch — always bypassed in integration tests because HVF/TCG boot completes well within 120 s; consider a mock-fetch unit test

**Image management (unit — mock fetch/fs):**
- [x] `images.ts`: unit test `listCachedImages` for empty, absent, and populated cache dirs — `test/unit/images.test.ts` (new file, 4 tests)
- [ ] `images.ts`: `downloadImage` error paths — HTTP 4xx (non-retriable abort), 5xx retry exhaustion — mock `fetch`; integration tests only hit the cached-image path

**License error paths (unit — mock fetch):**
- [x] `license.ts`: unit tests for `renewLicense` and `getLicenseInfo` error branches (network error, HTTP 4xx/5xx, level normalisation) using mocked fetch — added to `test/unit/license.test.ts` (6 new tests)

**Channels (unit + integration):**
- [x] `channels.ts`: unit tests for `monitorCommand` error paths (socket-not-found, server-close-before-prompt, quit resolves), `serialStreams` no-socket, `qgaCommand` arm64 guard — `test/unit/channels.test.ts` (new file, 6 tests)
- [x] `channels.ts + quickchr.ts`: integration test for `instance.serial()` — readable stream delivers bytes from a running CHR's serial console — added to `test/integration/start-stop.test.ts`

**Instance lifecycle (integration — needs running QEMU):**
- [x] `quickchr.ts`: integration test for `instance.remove()` on a *running* machine — stop-then-delete path — added to `test/integration/start-stop.test.ts`
- [x] `quickchr.ts`: integration test for `instance.clean()` — reset disk image from cache, verify CHR returns to factory state (custom user gone, admin/empty works) — added to `test/integration/start-stop.test.ts`
- [x] `quickchr.ts`: bug fix — `clean()` test was missing `waitForBoot` after `_launchExisting` restart; REST assertions raced the boot and failed intermittently; fixed in `test/integration/start-stop.test.ts`
- [x] `provision.ts`: provisioning corner cases — invalid group → PROCESS_FAILED; new user placed in "full" group with write access — added to `test/integration/provisioning.test.ts`

**Device-mode feature flags (integration):**
- [x] `device-mode.ts`: integration test for `mode=basic` with `enable: [bandwidth-test, ipsec]` + `disable: [zerotier]` — verifies non-rose mode + non-empty enable/disable arrays are fully applied and confirmed via `verifyDeviceMode`; covers the CLI `--device-mode-enable`/`--device-mode-disable` code path end-to-end — added to `test/integration/device-mode.test.ts`
- [ ] `quickchr.ts`: `hardRebootMachine` signal fallback — monitor socket unavailable → SIGTERM cascade. Device-mode integration test covers the monitor-quit path only; signal path is untested

**CI-gated / platform-specific:**
- [ ] `state.ts` / `platform.ts`: Windows path logic (`LOCALAPPDATA`, `USERPROFILE`, PowerShell qemu paths) — needs Windows CI runner (tracked under P4)
- [ ] `platform.ts`: KVM detection with `/dev/kvm` present/absent — Linux CI matrix should exercise both paths explicitly

---

## P2 — CLI & UX

### Design Principles

**Interactive prompts are confined to `setup` (and future `tui`).** Every other command is non-interactive — no clack selectors, no `QUICKCHR_NO_PROMPT=1` needed. Without a `<name>` argument, commands print a helpful machine list with a tip instead of launching a selector. Shell completions cover the "discovery" need that interactive selectors were filling. This makes every command safe for scripts, LLMs, CI, and pipes by default.

**`start`/`stop` are pure operations.** They start or stop a machine. No wizard, no creation, no prompts. `add` creates machines. `setup` is the interactive wizard for humans exploring the tool.

**`set`/`get` for machine configuration.** License, device-mode, admin accounts — anything that mutates machine config goes through `set`. Avoids a proliferation of top-level commands (`quickchr license`, `quickchr device-mode`, `quickchr admin`, etc.). Loosely follows RouterOS `set`/`get` naming.

**`--json` and `--yaml` on all read commands.** Structured output for scripts and LLMs. Plain table is the default for humans.

### Command Reference (target design)

```text
quickchr — MikroTik CHR QEMU Manager

Usage:
  quickchr                           Run 'setup' wizard (TTY) or 'help' (non-TTY / QUICKCHR_NO_PROMPT=1)
  quickchr <command> [options]

Lifecycle:
  add <name> [options]    Create a new CHR instance (download image, allocate ports)
  start [<name>|--all]    Start existing instance(s). No name → list startable machines with tip
  stop [<name>|--all]     Stop instance(s). No name → list stoppable machines with tip
  remove [<name>|--all]   Remove instance(s) and disk. No name → list removable machines with tip
  clean [<name>]          Reset instance disk to fresh image. No name → list machines with tip

Interaction:
  exec <name> <command>   Run RouterOS CLI command (--via=auto|ssh|rest|qga, --output=text|json)
  console <name>          Attach to serial console (interactive TTY required)
  logs <name>             Tail qemu.log

Configuration:
  set <name> [options]    Set machine properties (see 'quickchr help set')
  get <name> [options]    Get machine properties (--json, --yaml)

Inspection:
  list [--json|--yaml]    List all instances with summary status
  networks [--json]       List available networks (interfaces, named sockets)
  doctor [--json]         Check prerequisites and system health

Interactive:
  setup                   Interactive wizard — create, manage, configure machines (TTY only)

Meta:
  version                 Show version info
  help [command]          Show help

Environment:
  QUICKCHR_NO_PROMPT=1    Force non-interactive (bare 'quickchr' runs 'help' instead of 'setup')
  MIKROTIK_ACCOUNT        MikroTik.com account email (for license via 'set')
  MIKROTIK_PASSWORD       MikroTik.com password (for license via 'set')
```

### Command Details

#### `add` — Create Machine (replaces old `start` wizard path)

Takes the same options as the current `start` wizard but as CLI flags. Errors on duplicate name. Non-interactive.

```text
quickchr add my-chr --version stable --arch x86_64 --mem 512 --add-network user
quickchr add rb-sim --version long-term --emulate-device rb5009
quickchr add arm-test --arch arm64 --packages container,zerotier
```

- [x] Implement `add` command with all current `start` creation options
- [x] Error on duplicate name (currently silent overwrite risk)
- [x] After creation, print machine summary and `tip: quickchr start my-chr`

#### `start` / `stop` — Pure Operations

`start <name>` starts a stopped machine. `start --all` starts all stopped machines. No name and no `--all` → print list of startable machines with tip.

```text
$ quickchr start
NAME        STATUS    VERSION    ARCH
my-chr      stopped   7.22       x86_64
arm-test    stopped   7.22       arm64

tip: quickchr start <name>  or  quickchr start --all

$ quickchr start my-chr
● my-chr started (http://127.0.0.1:9100)
```

- [ ] Refactor `start` to remove wizard/creation logic — pure start only
- [x] `start` without name: list startable machines, print tip, exit 0
- [x] `stop` without name: list stoppable machines, print tip, exit 0
- [x] Remove all clack selectors from `start` and `stop`
- [x] `--all` flag on both

#### `set` / `get` — Machine Configuration

Unified interface for machine properties that were previously separate commands or only in the wizard.

```text
# License
quickchr set my-chr --license --account user@example.com --password secret
quickchr set my-chr --license                    # uses MIKROTIK_ACCOUNT/PASSWORD env

# Device mode
quickchr set my-chr --device-mode advanced
quickchr set my-chr --device-mode-enable ipsec,bandwidth-test
quickchr set my-chr --device-mode-disable zerotier

# Admin account
quickchr set my-chr --disable-builtin-admin
quickchr set my-chr --add-admin-user deploy --password secret123

# Read back
quickchr get my-chr                              # all settable properties
quickchr get my-chr --json                       # structured output
quickchr get my-chr license                      # specific property group
quickchr get my-chr device-mode
quickchr get my-chr admin                        # RouterOS users in group=full
```

- [ ] Implement `set` command — license, device-mode, admin account
- [ ] Implement `get` command — query settable properties via REST API. `--json`/`--yaml` output.
- [ ] `get` without a property group: show all settable config (license level, device-mode, admin users)
- [ ] Deprecate standalone `license` command → alias to `set <name> --license`

#### `remove` / `clean` — Non-Interactive

Without a name: print list of machines with tip. No selectors.

```text
$ quickchr remove
NAME        STATUS    VERSION    ARCH
my-chr      stopped   7.22       x86_64
arm-test    running   7.22       arm64     (stop first)

tip: quickchr remove <name>  or  quickchr remove --all

$ quickchr remove my-chr
my-chr removed.
```

- [x] Remove clack selectors from `remove` and `clean`
- [x] Print machine list with tip when no name given
- [x] `--all` flag on `remove` (already exists). Add to `clean`.
- [x] For running machines in `remove` list, show "(stop first)" hint

#### `list` — Unified Machine List

Merge current `list` and `status` into one command. `list` shows the summary table. `list <name>` shows detailed status for one machine (what `status <name>` does today). `status` becomes an alias for `list`.

```text
$ quickchr list
NAME        STATUS    VERSION    ARCH      PORTS           NETWORKS
my-chr      running   7.22       x86_64    9100-9109       user
hub         running   7.22       x86_64    9110-9119       user, socket::hub-a, socket::hub-b
branch-a    stopped   7.22       x86_64    9120-9129       user, socket::hub-a

$ quickchr list my-chr
Name:       my-chr
Status:     running (PID 12345)
Version:    7.22 (stable)
Arch:       x86_64
...

$ quickchr list --json
[{"name":"my-chr","status":"running",...}]
```

- [ ] Merge `list` and `status` — `list` for table, `list <name>` for detail
- [ ] Keep `status` as alias for `list`
- [ ] `--json` / `--yaml` output on `list`
- [ ] Enrichment: pull live QEMU stats (CPU, memory) via monitor channel for `list <name>` detail view
- [ ] Show network info (names, any downgrades) in both table and detail views

#### `setup` — Interactive Wizard

All interactive UI lives here. The "home screen" for humans exploring quickchr.

```text
$ quickchr setup

  ◆ quickchr setup
  │
  │ What would you like to do?
  │ ○ Create a new machine
  │ ○ Manage machines (start/stop/remove)
  │ ○ Configure networks
  │ └
```

**Flow when zero machines exist:** Jump straight to "Create a new machine" (current wizard flow).

**Flow when machines exist:**

- **Create** → current wizard flow → `add` under the hood
- **Manage** → list machines with state → per-machine choices:
  - Running: start, stop, "stop and edit" (future)
  - Stopped: start, edit config (stub as unimplemented for now), remove
- **Networks** → show available networks by type:
  - `user`: list machines with user networks and their port mappings. Tip: controlled by machine config.
  - `socket`: list active named sockets with connected machines. Option to add new socket link between machines.
  - `shared`/`bridge`: show available platform networks (vmnet on macOS, TAPs on Linux). Stub for now — full implementation deferred to P5 networking work.

- [x] Create `setup` command with top-level menu
- [x] Wire "Create" to existing wizard flow
- [x] Wire "Manage" to machine list with per-machine actions
- [x] Stub "Networks" with basic listing, mark advanced networking as unimplemented
- [x] Make bare `quickchr` (no args, TTY) invoke `setup`
- [x] Make bare `quickchr` (no args, non-TTY or `QUICKCHR_NO_PROMPT=1`) invoke `help`

#### `exec` — Run RouterOS Commands

- [ ] `quickchr exec <name> <command>` — `--via=auto|ssh|rest|qga` (auto: try SSH, fall back to REST `/execute`). `--output=text|json|csv|tsv` (RouterOS trick: `[:serialize to=json [<cmd>]]` for structured output; see tikoci/restraml `lookup.html` for CLI→REST mapping). `--strict` pre-validates via `/console/inspect request=completion` — check for `"error"` or `"obj-invalid"` (from `~/GitHub/lsp-routeros-ts` and `~/GitHub/vscode-tikbook`). Strict mode is especially valuable for LLM-generated commands.

#### `console` — Serial Console

- [x] `quickchr console <name>` — attach to serial console of a running background instance (current `attachSerial` logic, promoted to top-level command). Requires TTY. The only interactive command besides `setup`.

#### `logs` — QEMU Log

- [ ] `quickchr logs <name>` — tail `qemu.log`. `--follow` for live tail. `--json` for structured log entries if we add structured logging later.

### Shell Completions

Shell completions replace interactive selectors as the "discovery" mechanism for machine names and flags. Higher priority now that commands are non-interactive.

- [ ] Completions for bash, zsh, fish — subcommands, machine names (from state dir), `--flag` options
- [ ] Explore generating completions without requiring Homebrew/package install (standalone shell script that reads `~/.local/share/quickchr/machines/` for names)
- [ ] Machine name completion should be context-aware: `start` completes to stopped machines, `stop` completes to running machines, etc.

### Output & Display

- [ ] ANSI table cleanup — replace heavy box-drawing borders with minimal ANSI style; improve color and terminal-width-aware column layout. No new borders on any new output.
- [ ] `--json` / `--yaml` output on: `list`, `get`, `networks`, `doctor`, `exec`. Consistent structure across commands.
- [ ] `--no-ansi` option (low priority) — strip colors/formatting for log capture. ANSI may actually help LLMs as visual signal, so unclear if needed. Track but don't rush.
- [ ] `doctor` as `bun test` — the checks are essentially assertions about the environment. Consider expressing doctor checks as a test file (`test/environment/doctor.test.ts`) that `bun test` can run, with `quickchr doctor` as a CLI wrapper. Keeps the "prescription" hints and rich output.
- [ ] `doctor` enhancements — OS-level diagnostics: `ps`/port scan correlated with PID files, stale machine detection, named socket port conflict detection. System-wide health.

### TUI Mode (future)

- [ ] `quickchr tui` or `quickchr manage` — full terminal UI with live machine list, start/stop/status actions, log viewer. Separate from `setup` wizard (which is guided creation). Lower priority but a natural evolution. Reserve the command name now.

### Migration Path (current → target)

The refactoring is not all-or-nothing. Incremental steps:

1. [x] **Add `add` command** — copy current creation logic from `start`. Both work temporarily.
2. [x] **Add `setup`** — move wizard from bare `quickchr` and `start` into `setup`.
3. [x] **Strip `start`/`stop`** — selectors removed; machine-list+tip behavior implemented. Remaining pure-start cleanup tracked above.
4. [x] **Strip `remove`/`clean`** — same pattern (list + tip).
5. **Add `set`/`get`** — start with license (migrate from `license` command).
6. **Merge `list`/`status`** — `list` does both, `status` becomes alias.
7. **Deprecation notices** — old `license` command prints "use `set <name> --license`" for one release cycle.
8. **Shell completions** — fill the gap left by removed selectors.

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

### Networking Rationalization

The core tension: different use cases need different network modes, each with different `sudo`/privilege requirements and platform availability. quickchr needs a coherent story for how networking is configured across the CLI, library API, and wizard — without hiding the complexity from users who need to understand it.

**Network modes and their realities:**

| Mode | Platforms | Root/sudo? | CHR gets real IP? | Multi-CHR L2? | Host access? | Notes |
|------|-----------|------------|-------------------|---------------|-------------|-------|
| `user` (default) | All | No | No (NAT via hostfwd) | No | Yes (hostfwd) | Sufficient for REST API, SSH. restraml's use case |
| `socket` | All | No | No | Yes (point-to-point) | No | QEMU `-netdev socket` for inter-VM links. listen/connect pairs on localhost ports. Simplest multi-CHR |
| `vmnet-shared` | macOS | Yes (`sudo`) | Yes (DHCP from vmnet) | Yes | Yes (shared NAT) | Tested on Intel Mac (`~/GitHub/mikropkl`). macOS's built-in NAT network via `vmnet.framework` |
| `vmnet-bridged` | macOS | Yes (`sudo`) | Yes (from LAN DHCP) | Yes (same bridge) | Yes (LAN peer) | Needs `ifname` selection (e.g. `en0`). Real LAN presence |
| `tap` | Linux | Yes (or CAP_NET_ADMIN) | Depends on bridge config | Yes (same bridge) | Depends | User configures bridge externally; quickchr discovers + presents available TAPs |

### Rootless Network Topologies

**Key insight: `user` + `socket` are the universal rootless pair.** The default is one `user` network (management via REST API hostfwd). Multi-CHR topologies add `socket` links for inter-VM data-plane connectivity. This combination is cross-platform, rootless, CI-friendly, and covers the majority of use cases (testing, training, tooling, CI). vmnet/TAP are "upgrades" for scenarios needing real LAN presence or host-visible broadcast domains. Rootless should be the default path — if someone sees three CHRs routing OSPF from `make` or `bun test`, *then* they'll be willing to `sudo` something for the next step. (Compare: Multipass requires a privileged daemon just to start — "Waiting for daemon..." with no workaround if launchd is unhappy.)

For network admins familiar with GNS3/EVE-NG — quickchr rootless topologies are not trying to replace those tools for large-scale simulation. The sweet spot is 2-5 CHRs with realistic routing/VPN configs, automatable from a Makefile or test script, runnable in CI. The fun "two-cute-by-half" tricks (PPPoE over socket, VXLAN overlays, IPSec site-to-site — all rootless) are worth calling out in MANUAL.md for network engineers who'll appreciate the cleverness.

#### CLI Design: `--add-network`

**Semantics:** Zero `--add-network` flags = default 1 `user` network (ether1). Once you specify ANY `--add-network`, you are specifying ALL networks — the count of `--add-network` flags equals the number of NICs. Use `--no-network` for zero NICs (headless/serial-only).

```text
# Default: 1 NIC (user)
quickchr start test1

# Explicit: same as default
quickchr start test1 --add-network user

# 2 NICs: user + named socket
quickchr start hub --add-network user --add-network socket::spoke-a

# 3 NICs: user + 2 named sockets
quickchr start hub --add-network user --add-network socket::spoke-a --add-network socket::spoke-b

# 9 NICs: emulate RB5009 layout
quickchr start rb-sim --emulate-device rb5009

# 0 NICs: serial-only (no networking)
quickchr start headless --no-network
```

**Network specifier syntax** — uses `:` separators (prefix:type:name):

| Specifier | Resolves to | Root? | Notes |
|-----------|------------|-------|-------|
| `user` | `-netdev user,hostfwd=...` | No | Management NIC with port forwarding |
| `socket::<name>` | `-netdev socket,listen=:<auto-port>` or `connect` | No | Named socket. First machine to use a name listens, others connect. Port auto-allocated and tracked in `~/.local/share/quickchr/networks/<name>.json` |
| `socket:listen:<port>` | `-netdev socket,listen=:<port>` | No | Explicit port, listen side |
| `socket:connect:<port>` | `-netdev socket,connect=127.0.0.1:<port>` | No | Explicit port, connect side |
| `socket:mcast:<group>:<port>` | `-netdev socket,mcast=<group>:<port>` | No | Multicast socket, shared L2 segment |
| `:shared:<name>` | `-netdev vmnet-shared` (macOS) | Yes | Named shared network. Discovered via `quickchr networks`, not created per-machine |
| `:bridge:<ifname>` | `-netdev vmnet-bridged,ifname=<iface>` (macOS) or `-netdev tap,ifname=<tap>` (Linux) | Yes | Bridge to host interface. Same specifier, platform-resolved |
| `<tap-name>` | `-netdev tap,ifname=<tap>` | Yes | Direct TAP name (Linux). Discovered via `quickchr networks` |

**Named sockets (`socket::<name>`)** are the key usability improvement over explicit ports. quickchr tracks named socket state in `~/.local/share/quickchr/networks/<name>.json` — which port, which machine is listen vs connect. This avoids port conflicts and makes configs readable:

```text
quickchr start hub --add-network user --add-network socket::hub-to-a --add-network socket::hub-to-b
quickchr start branch-a --add-network user --add-network socket::hub-to-a
quickchr start branch-b --add-network user --add-network socket::hub-to-b
```

**Multi-NIC mapping in QEMU:** Each `--add-network` adds a `-netdev`/`-device virtio-net-pci` pair. RouterOS sees them as `ether1` (first `--add-network`), `ether2`, etc. Ordering is deterministic and matches the order of flags on the command line.

**Cross-platform portability:** If `~/.local/share/quickchr` is synced between Mac and Linux, rootless configs (user + socket) work unchanged. Privileged configs (`:bridge:en0`) use the same specifier but resolve differently per platform — document the TAP naming convention so Linux users can create TAPs matching macOS interface names.

**Network downgrade:** If a machine config references `:bridge:en0` but quickchr isn't running as root (or the interface doesn't exist), show a yellow warning and downgrade to `user` or `socket`. `quickchr list` and `quickchr status` should clearly indicate downgraded networks (e.g., `ether2: :bridge:en0 → user (no root)`).

#### `quickchr networks` — Discovery Command

Inspired by `multipass networks`. Lists available network interfaces and named sockets:

```text
$ quickchr networks
TYPE          NAME            STATUS    NOTES
user          (default)       always    hostfwd port forwarding
socket        hub-to-a        active    listen:4001 (hub), connect (branch-a)
socket        hub-to-b        active    listen:4002 (hub), connect (branch-b)
vmnet-shared  shared0         available macOS vmnet (requires root)
bridge        en0             available Ethernet (Realtek), 1Gbps, connected
bridge        en1             available Wi-Fi (AirPort), 802.11ac
tap           tap0            available Linux TAP (pre-configured)
```

- [ ] `quickchr networks` — list available networks. `--format json|table` output.
- [ ] macOS: enumerate physical interfaces only (Multipass learned the hard way — listing virtual bridges QEMU can't actually bridge to caused bugs). Filter via `networksetup -listallhardwareports`.
- [ ] Linux: `ip link show type tun` for TAPs, `ip link show type bridge` for bridges.
- [ ] Show active named sockets with port allocations and connected machines.

#### `--emulate-device` — Hardware Profiles

Shorthand for NIC count + other QEMU settings matching a specific MikroTik hardware model:

```text
quickchr start rb-sim --emulate-device rb5009
# Expands to: --add-network user + 8x socket::<auto> (ether1..ether9)
```

- [ ] `--emulate-device <model>` — lookup in built-in table, expand to network + QEMU args. Start with RB5009 (9 NICs) and hAP ax3 (5 ports). WiFi interfaces won't work on CHR but interface count is useful for config testing.
- [ ] Device table as JSON/YAML file in package. Possibly sourced from tikoci/rosetta device data (144 devices with specs).

#### `--add-network` Implementation

- [ ] Implement `--add-network` CLI flag (repeatable). Parse the specifier syntax above.
- [ ] Extend `NetworkMode` type: `network: NetworkMode` → `networks: NetworkConfig[]`. Each entry has type, name, and platform-resolved QEMU args.
- [ ] Semantics: zero flags = `[user]`. Any flags = exactly what you specified (count of flags = count of NICs). `--no-network` = `[]`.
- [ ] Named socket state management: `~/.local/share/quickchr/networks/<name>.json` tracks port, listen machine, connect machines.
- [ ] Wizard: detect available modes and only show viable options. If not root, show `user` and `socket` only. If macOS + root, add `:shared:` and `:bridge:<ifname>`.
- [ ] Store in `machine.json`/`.yaml` as `networks: [...]` array. Re-applicable on restart.
- [ ] CI (GitHub Actions): `user` + `socket` only (no root). Document.

#### sudo Handling

- [ ] quickchr should NOT prompt for sudo itself. Require `sudo quickchr start ...` when vmnet or TAP is needed. More transparent, avoids privilege escalation surprises, matches mikropkl's `sudo qemu-system-*` pattern. The wizard detects root and adjusts available options.
- [ ] **No daemon.** quickchr runs QEMU directly as a child process (foreground) or detached process (background). No launchd/systemd service required for basic operation. This is a deliberate contrast to Multipass's daemon architecture — no "Waiting for daemon..." failure mode, no socket permissions, no gRPC complexity. Daemonization (P4) is an optional promotion for long-running instances, not a requirement.

#### Creative Networking Tricks (RouterOS-side, no root needed)

These use RouterOS's own tunneling capabilities to create "real" interfaces over rootless socket/user networks. Worth documenting in MANUAL.md as "rootless network topology" recipes:

- **VXLAN over socket:** Two CHRs connected via `socket` get L2 adjacency. RouterOS VXLAN on top creates additional overlay segments. This is the standard enterprise pattern (underlay + overlay) and works perfectly rootless.
- **PPPoE server/client over socket:** One CHR as PPPoE server, another as client. Client gets a dynamic `pppoe-out1` interface with an IP from the server's pool. Creates routed point-to-point links. Useful for testing PPPoE configurations (common in ISP/WISP deployments).
- **EoIP/GRE tunnels:** RouterOS EoIP creates L2 tunnels over L3. Useful for extending broadcast domains across routed socket links.
- **IPSec/L2TP/PPTP VPN:** Build VPN tunnels between CHRs over socket links. Tests the full VPN stack without any host configuration. IPSec site-to-site is especially common in MikroTik deployments.
- **VRRP over vmnet-shared:** Requires root, but the VIP floats on a real macOS network segment. This is the one scenario where rootless socket mode genuinely can't substitute — VRRP needs a shared broadcast domain visible to the host.

### Multipass Comparison Notes

Reviewed Multipass (Canonical) as a reference for multi-VM CLI design. Key lessons:

**Adopt:** `multipass networks` → `quickchr networks` (discovery). Always-present default NIC aligns with our `user` default. `--format json|yaml|csv|table` on inspection commands (tracked in P2). Mutable resources post-creation (`multipass set local.<instance>.cpus=4` on stopped instances — consider for quickchr config schema). Flat command namespace.

**Avoid:** Daemon requirement (`multipassd` runs as privileged launchd service — broken daemon = nothing works). The `local.bridged-network` indirection for adding NICs to existing instances (set global pref, toggle per-instance — awkward). Driver-dependent networking (different behavior on QEMU vs Hyper-V vs VirtualBox — quickchr targets QEMU only, one backend = consistent). macOS vmnet-bridged only works with physical interfaces (Multipass discovered this via bugs — apply same filter in `quickchr networks`).

### macOS

- [ ] vmnet-shared and vmnet-bridge via `:shared:` and `:bridge:<ifname>`: generate correct `-netdev vmnet-shared,id=netN` or `-netdev vmnet-bridged,id=netN,ifname=<iface>`. Reference: `~/GitHub/mikropkl` `qemu.sh` and `qemu.cfg`. Key: QEMU vmnet is macOS-only (`vmnet.framework`). vmnet-bridged only works with physical interfaces — filter in `quickchr networks`.
- [ ] vmnet-shared and vmnet-bridged are **discovered, not created** per-machine. They exist as macOS platform capabilities. quickchr references them; it doesn't manage them. (Contrast with named sockets, which quickchr does manage.)

### Linux

- [ ] TAP networking via `--add-network <tap-name>` or `:bridge:<ifname>`: philosophy is **discover and present**, don't configure. `quickchr networks` shows available TAPs and bridges. Don't edit `/etc/network/` or manage bridge creation — an agent can figure out the right TAP for a given OS in one prompt better than a generic script.
- [ ] Cross-platform config hint: document TAP naming convention so Linux users can create TAPs matching macOS interface names (e.g., name a TAP `en0`) for portable machine configs.
- [ ] CI (GitHub Actions): rootless only (`user` + `socket`). No TAP in CI unless runner has pre-configured TAPs (self-hosted runners).

### Windows (low priority, document the scheme)

- [ ] QEMU on Windows: `winget install QEMU.QEMU` or MSYS2. User-mode and socket networking work. No vmnet equivalent.
- [ ] TAP equivalent: OpenVPN TAP-Windows adapter or WireGuard `wintun`. Both require admin install. `quickchr networks` could discover installed TAP adapters.
- [ ] WHPX acceleration: Windows Hypervisor Platform as alternative to TCG. Requires Hyper-V enabled.
- [ ] Document: "user + socket works everywhere. For bridged networking on Windows, install OpenVPN TAP adapter." Don't automate Windows networking config.

### Multi-CHR (examples, not orchestration)

quickchr is the QEMU expert. Orchestrating multi-router topologies is out of scope for the CLI/library itself — that's the user's (or their agent's) job.

Provide an `examples/` directory with each scenario in three forms: **Makefile** (recipe-driven, tikoci tradition — see tikoci/netinstall), **bun:test** (library API, TypeScript), and **Python** (subprocess CLI, the language agents and network engineers both reach for). Building examples early finds CLI soft spots before we add more commands.

**Example design principles:**

- Every example must work with `user` + `socket` (rootless) as the baseline. Note vmnet/TAP as upgrades where relevant.
- Every CHR keeps `user` mode (ether1) for management — tests assert via REST API over hostfwd.
- Socket links create the data-plane topology. RouterOS protocols (OSPF, VXLAN, PPPoE, etc.) run on top.
- At least tris, solis, and matrica should be CI-testable (rootless). divi requires root (VRRP needs shared broadcast domain on host).

#### "tris" — 3-CHR Hub-and-Spoke (Latvian for "three") **[build first]**

**Priority: build this first.** It exercises `socket` mode, multi-instance, and dynamic routing — all rootless and CI-testable. Findings here drive CLI design for all other examples.

**Topology:**

```text
quickchr start hub      --add-network user --add-network socket::hub-a --add-network socket::hub-b
quickchr start branch-a --add-network user --add-network socket::hub-a
quickchr start branch-b --add-network user --add-network socket::hub-b

                 user:hostfwd (REST mgmt)
                        |
                   +---------+
                   |   HUB   |
                   | ether1  | user (mgmt, port base 9100)
                   | ether2  | socket::hub-a  ──── OSPF area 0
                   | ether3  | socket::hub-b  ──── OSPF area 0
                   +---------+
                    /         \
          socket::hub-a      socket::hub-b
           /                        \
   +-----------+              +-----------+
   | BRANCH-A  |              | BRANCH-B  |
   | ether1    | user (mgmt,  | ether1    | user (mgmt,
   | ether2    | port 9110)   | ether2    | port 9120)
   +-----------+ socket link  +-----------+ socket link
                  to hub                    to hub
```

**RouterOS config on each:**

- **Hub:** OSPF instance with two interfaces (ether2, ether3) in area 0. Redistribute connected. IP addresses on ether2 (10.0.1.1/30) and ether3 (10.0.2.1/30). A loopback or bridge with 10.0.0.1/32 as router-id.
- **Branch-A:** OSPF on ether2 (10.0.1.2/30), area 0. Loopback 10.0.10.1/32 (advertised). Default route learned from hub.
- **Branch-B:** OSPF on ether2 (10.0.2.2/30), area 0. Loopback 10.0.20.1/32 (advertised). Default route learned from hub.

**What this validates:**

- `--add-network socket:listen/connect` works for point-to-point links
- Multiple CHR instances with different port bases coexist
- OSPF adjacency forms over socket interfaces (proves L2 works)
- Route propagation: Branch-A learns Branch-B's loopback via hub (proves L3 routing over socket works)
- Test asserts via REST API: check `/routing/ospf/neighbor` for FULL state, check `/ip/route` for learned routes, ping far loopback via `/tool/ping`

**CI-testable:** Yes (rootless, user + socket only).

**Stretch goals:**

- VXLAN overlay: Branch-A and Branch-B establish a VXLAN tunnel through the hub (L2 over L3 over L2). Validates overlay networking without root.
- IPSec: site-to-site tunnel between branches through hub. Common MikroTik deployment pattern.

- [ ] `examples/tris/Makefile`
- [ ] `examples/tris/tris.test.ts` (bun:test)
- [ ] `examples/tris/tris.py` (Python, subprocess CLI)
- [ ] `examples/tris/README.md`
- [ ] `examples/tris/hub.rsc` (RouterOS config)
- [ ] `examples/tris/branch-a.rsc`
- [ ] `examples/tris/branch-b.rsc`

#### "divi" — 2-CHR Redundancy (Latvian for "two")

**Requires root** (vmnet-shared for VRRP broadcast domain visible to host). Not CI-testable in GitHub Actions.

**Topology:**

```text
sudo quickchr start chr-a --add-network user --add-network :shared:vrrp-lan --add-network socket::divi-sync
sudo quickchr start chr-b --add-network user --add-network :shared:vrrp-lan --add-network socket::divi-sync

     [macOS host / LAN]
            |
     :shared:vrrp-lan (vmnet-shared on macOS, TAP+bridge on Linux)
       |          |
  +---------+ +---------+
  |  CHR-A  | |  CHR-B  |
  | ether1  | | ether1  | user (mgmt, hostfwd)
  | ether2  | | ether2  | :shared:vrrp-lan (VRRP)
  | ether3  | | ether3  | socket::divi-sync (VXLAN sync)
  +---------+ +---------+
       |          |
    VRRP VIP floats on :shared:vrrp-lan
    VXLAN tunnel over socket::divi-sync
```

**RouterOS config on each:**

- **CHR-A (master):** VRRP instance on ether2 with priority 200, VIP 192.168.64.100/24 (vmnet-shared subnet). VXLAN interface over ether3 (socket link to CHR-B) for internal state sync or routed traffic.
- **CHR-B (backup):** Same VRRP config, priority 100. Same VXLAN.

**What this validates:**

- `:shared:` and `socket::` mixed network modes with root
- VRRP failover: stop CHR-A, verify VIP migrates to CHR-B (test via host ping to VIP)
- VXLAN over socket: internal sync channel between routers

**Linux equivalent:** Replace vmnet-shared with a TAP interface attached to a bridge. quickchr doesn't create the bridge — user sets it up, quickchr discovers and uses it.

**Why root is unavoidable here:** VRRP sends gratuitous ARP on a shared broadcast domain. The host (or other LAN devices) need to see the VIP. Socket mode provides inter-VM L2 but is invisible to the host. vmnet-shared (or TAP+bridge) puts CHR traffic on a network the host participates in.

- [ ] `examples/divi/Makefile`
- [ ] `examples/divi/divi.test.ts` (bun:test)
- [ ] `examples/divi/divi.py` (Python, subprocess CLI)
- [ ] `examples/divi/README.md`
- [ ] `examples/divi/chr-a.rsc`
- [ ] `examples/divi/chr-b.rsc`

#### "solis" — Sequential Version Migration (Latvian for "steps")

Runs a **sequence**: load config into `long-term` CHR, export, load export into `stable` CHR, export, ... through `testing` and `development`. Detects config drift across RouterOS version migrations.

**Arch choice:** x86 (broader user base, faster on Intel Mac with HVF, SeaBIOS — no firmware hassle). Uses `--emulate-device rb5009` to give the CHR 9 interfaces matching the RB5009 layout, so configs referencing `ether1`..`ether9` have somewhere to land.

**Topology (per step, one CHR at a time):**

```text
quickchr start solis-lt --version long-term --emulate-device rb5009
# Expands to: --add-network user + 8x socket::<auto> → ether1..ether9
```

The 9 socket NICs don't need to be connected — they exist purely so RouterOS sees the interfaces and the config can reference them.

**Flow:**

1. Start CHR at `long-term` version with 9 NICs
2. Upload `.rsc` config via SCP or REST API file upload
3. `/system/reset-configuration run-after-reset=<file> keep-users=yes skip-backup=yes`
4. Wait for reboot, `:export file=step1` via REST `/execute` or SSH
5. Download exported config, stop CHR
6. Start new CHR at `stable` version with same 9 NICs
7. Upload step1's export, repeat
8. Continue through `testing` → `development`
9. Diff the final export against the original input. Any differences = version migration changed the config

**What this validates:**

- quickchr version resolution across all 4 channels
- `--add-network` with many unconnected sockets (interface count, not connectivity)
- `.rsc` config import/export cycle via REST API
- Sequential CHR lifecycle: create → provision → use → destroy → repeat

**CI-testable:** Yes (rootless, user + unconnected sockets). Needs a sample `.rsc` config to ship with the example.

- [ ] `examples/solis/Makefile`
- [ ] `examples/solis/solis.test.ts` (bun:test)
- [ ] `examples/solis/solis.py` (Python, subprocess CLI)
- [ ] `examples/solis/README.md`
- [ ] `examples/solis/rb5009-sample.rsc` (sample config — bridge, firewall, DHCP server, DNS, basic security)

#### "matrica" — Parallel Version Matrix (Latvian for "matrix")

Same concept as solis but runs all 4 versions **in parallel**, comparing exports at the end. Fast way to know if a config works as-is across all current RouterOS channels.

**Arch choice:** ARM64 (complement to solis's x86, and ARM64 CHR has extra packages). Add `zerotier` and `container` packages to test configs that reference these. ARM64 on Intel Mac uses TCG (slower) but 4 parallel CHRs at ~20-60s boot each is still practical since the total wall-clock time is dominated by the slowest.

**Topology:** Same as solis (`--emulate-device rb5009` for 9 NICs) but 4 CHRs running simultaneously on different port bases.

```text
quickchr start matrica-lt    --version long-term   --arch arm64 --port-base 9200 --emulate-device rb5009
quickchr start matrica-st    --version stable       --arch arm64 --port-base 9210 --emulate-device rb5009
quickchr start matrica-test  --version testing      --arch arm64 --port-base 9220 --emulate-device rb5009
quickchr start matrica-dev   --version development  --arch arm64 --port-base 9230 --emulate-device rb5009
```

**Flow:**

1. Start all 4 CHRs in parallel (different port bases, same .rsc config)
2. Install `zerotier` + `container` packages on each (ARM64 has both)
3. Upload config, reset-configuration on each
4. Wait for all to reboot, export from each
5. 4-way diff of exports. Differences = version-specific migration behavior

**What this validates:**

- 4 concurrent CHR instances (port allocation, no conflicts)
- ARM64 CHR package install (zerotier, container — ARM64-only packages)
- Parallel lifecycle management via library API
- Cross-version config compatibility in a single test run

**CI-testable:** Partially. ARM64 on x86 GitHub runners = TCG, very slow for 4 parallel VMs. May need a "matrica-lite" CI variant that runs 2 versions (long-term + stable) on x86 instead. Full ARM64 matrix is a local/self-hosted-runner exercise.

- [ ] `examples/matrica/Makefile`
- [ ] `examples/matrica/matrica.test.ts` (bun:test)
- [ ] `examples/matrica/matrica.py` (Python, subprocess CLI)
- [ ] `examples/matrica/README.md`
- [ ] `examples/matrica/rb5009-arm64.rsc` (sample config with zerotier/container references)

#### Example Summary

| Example | Arch | Root? | CI? | Network modes | Primary test |
|---------|------|-------|-----|---------------|-------------|
| **tris** | x86 | No | Yes | user + socket | OSPF, multi-CHR routing, VXLAN overlay |
| **divi** | x86 | Yes | No | user + vmnet-shared + socket | VRRP failover, mixed network modes |
| **solis** | x86 | No | Yes | user + socket (unconnected) | Sequential version migration, config drift |
| **matrica** | arm64 | No | Partial | user + socket (unconnected) | Parallel version matrix, ARM64 packages |

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
| tikoci/restraml | **Beta customer #1.** RouterOS API schemas; `lookup.html` maps CLI→REST for `exec --via=rest`. Needs quickchr for local iteration on `deep-inspect.json` extraction. Use case: user-mode networking (REST API only). Wants ARM64 CHR for complete package schema (zerotier, wifi-qcom). Sequential package install for per-package schema attribution |
| tikoci/rosetta | RouterOS docs as SQLite FTS5 RAG (MCP); helps agents write RouterOS commands |
| tikoci/mikropkl | Pkl-based QEMU support; extensive QGA lab work; `qemu.sh` handles device-mode. **Vendor from here:** vmnet-shared/vmnet-bridge networking (tested on Intel Mac), `qemu.cfg` config separation pattern. `Lab/` has grounded QEMU facts from many experiments |
| tikoci/netinstall | Elegant Makefile (~100 lines) for packaging; model for `examples/` Makefiles |
| tikoci/vscode-tikbook | VS Code extension; will use quickchr as backend (replacing UTM) |
| `~/GitHub/chr-armed` | OCI/AWS CHR deployment. **Vendor from here:** serial console provisioning (`src/oracle/console.ts`) — full first-boot sequence handling (license Y/n, password change, `\r` not `\r\n`). Also: ARM64 CHR lacks AWS ENA driver (MikroTik bug reported) |
| `~/Lab/tiktui` | Archived HTMX+SSE experiment; lesson: don't combine experiments in one project |
