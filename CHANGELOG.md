# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Even minor versions (0.2.x, 0.4.x) are releases; odd minors (0.3.x, 0.5.x) are pre-releases.

## [Unreleased]

### Fixed

- **Descriptor v1 now advertises the plain forwards (plain-first), not the TLS ones**
  (issue #95). 0.4.4's secure-preferred order pointed `services["rest-api"]` /
  `services["native-api"]` at endpoints that are not dialable on a stock CHR:
  `www-ssl` is disabled by default and `api-ssl` is certificate-less (TLS handshake
  alert 40; grounded on CHR 7.23.2). The descriptor now picks `http`/`api` — the same
  ports `restUrl` has always used — falling back to `https`/`api-ssl` (with
  `tls: true`) only when the plain forward is excluded. First surfaced by the first
  real consumer, `tikoci/centrs#134` `--quickchr` CHR acceptance.

## [0.4.4] — 2026-07-18

### Added

- Provisioning now verifies the managed SSH key with a real host-OpenSSH batch login
  (`BatchMode=yes`, `PasswordAuthentication=no`) and persists the result on the machine
  as `managedSshKey` (`{ privateKeyPath, algorithm, batchVerified }`). Best-effort: a
  failed verification never aborts provisioning. Settles the managed-key algorithm as
  `ed25519` (grounded from RouterOS 7.12+; issue #74).

### Changed

- **`ChrInstance.descriptor()` / `quickchr inspect` restructured to descriptor v1**
  (issue #71) — **breaking change** to the `MachineDescriptor` public type, accepted
  pre-1.0 since no external consumers depend on the old shape yet. The flat
  `ports`/`urls`/`auth`/`env` blob is replaced by `Descriptor`: a versioned
  (`descriptorVersion: 1`), per-service `services` map (`rest-api`, `native-api`, `ssh`)
  with `tls`, availability, and provenance, plus optional `customForwards` (e.g.
  `winbox`) and topology-only `networks`. This is the structured contract
  `tikoci/centrs#134` (`--quickchr <name>`) resolves connection facts through — full
  shape and mapping rules in [`docs/centrs-interface.md`](docs/centrs-interface.md).
  The `env` field is dropped from the descriptor entirely: `quickchr env` now calls
  `ChrInstance.subprocessEnv()` directly instead of reading `descriptor().env`
  (`subprocessEnv()` itself is unchanged).
- `installSshKey` failures now surface RouterOS's console rejection output and throw a
  typed `QuickCHRError` instead of a plain `Error`.
- Managed SSH key verification now matches the generated key's RouterOS row by
  comment/fingerprint and runs OpenSSH with `IdentitiesOnly=yes` plus an ignored
  ssh_config (`-F` to the platform null device), preventing older user keys or
  agent/config identities from producing a false verified result.

### Fixed

- Linux/arm64 TCG managed SSH key provisioning no longer reports a false install
  failure when the first `/rest/user/ssh-keys` listing takes longer than 5 seconds.
  The listing check now has one 30-second convergence budget and reports its attempt
  count and elapsed time when the cold path is slow.
- Windows: the managed SSH key's batch-login verification (`batchVerified`) no longer
  fails 100% of the time. `ssh -F <null-device>`, used to suppress `ssh_config`,
  isn't honored by Win32-OpenSSH's config-file loader (`Can't open user config file
  NUL`); it now points `-F` at a real empty file instead, which works identically on
  every platform. The failed probe's `ssh` output is also now logged instead of
  collapsing to a bare `false` (issue #87).

## [0.4.3] — 2026-07-06

### Added

- **Boot-history log + boot timing fields** (issue #30) — every successful boot appends
  `{ts, name, version, arch, accel, bootMs, host}` to `<dataDir>/boot-log.ndjson`
  (rotated at 1000→500 lines), and `machine.json` gains `lastAccel`/`lastBootMs`.
  Feeds the CI metrics scheme (`ci-data` branch); locally useful to answer
  "how slow are my boots" per accel/version.
- **`quickchr settings` command** (issue #46) — a small user-scoped settings framework for 5
  previously-hardcoded defaults: `default-channel`, `default-arch`, `cache-max-size`,
  `timeout-extra`, `secure-login`. Stored in `~/.config/quickchr/quickchr.env` (dotenv-style).
  Precedence: CLI flag > `QUICKCHR_<KEY>` env var > `quickchr.env` > built-in default.
  `add`/`start`, the setup wizard's channel/arch selection, and the post-boot cache
  auto-prune cap all now consult these. Never mutates `machine.json`; refuses to hold
  credential-shaped values (mirrors `tikoci/centrs`'s `settings` precedent). New
  `quickchr settings print|get|set|reset` verbs; see MANUAL.md §3/§11/§14.
- **`routeros-quickchr` agent skill** (in `tikoci/routeros-skills`) — a pointer-heavy guide for
  AI agents (and anyone) on grounding RouterOS config/scripts/API against a real router with
  quickchr: the apply→read-back loop, the by-goal networking decision table, the harness
  connection-surface, and grounding gotchas. Cross-linked from `routeros-qemu-chr`.
- **Three runnable examples** — `examples/grounding/` (apply config via `exec()` → read back via
  `rest()` → assert; re-run-safe via a per-run nonce), `examples/harness/` (drive an external
  child process against a live CHR via `subprocessEnv()`/`descriptor()`), and `examples/dude/`
  (install the `dude` package and ground its config, x86). All verified on real CHR (7.23.1).
- **UDP port-range forwarding** (issue #18) — `--forward name:hostStart-hostEnd[:guestStart-guestEnd][/proto]`
  expands to one `hostfwd` per port, for L3 peers with dynamic data ports (e.g. btest).
  New `expandForwardSpec()` export (range-aware; `parseForwardSpec()` stays single-port)
  plus `FORWARD_RANGE_MAX`. Host range is required and capped at 64 ports.
- **Networking recipes guide** (`docs/networking-recipes.md`) — a "which mechanism for
  which traffic shape" decision table, linked from README/MANUAL and surfaced in JSDoc.
- **Guest→host UDP gateway recipe** — receiving UDP a CHR *sends* (syslog, NetFlow, TZSP,
  or a server reply) needs no forward: the guest targets `10.0.2.2` and the host binds an
  *unconnected* loopback socket. Verified end-to-end (`test/lab/gateway-udp/REPORT.md`),
  with a runnable example (`examples/udp-gateway/`). Generalizes the existing
  `ChrInstance.tzspGatewayIp` primitive beyond TZSP.

### Changed

- **CI system refactored end-to-end** (issue #29) — one reusable integration workflow
  (`integration.yml`, dispatchable per platform × RouterOS target × test filter) replaces
  the old `verify-extended.yml`/`publish.yml` duplication. Integration tests moved off
  PRs onto every push to `main`, with a required PR "Integration freshness" gate; weekly
  all-platform sweep; daily new-RouterOS-version check that auto-tests never-seen
  versions; boot/test timing collected to the `ci-data` branch; releases are now a
  one-click `release.yml` dispatch (replacing `bun run release`/`scripts/release.ts` —
  the `release` package script is gone). Repo is squash-merge-only. Contributor-facing:
  see CONTRIBUTING.md "Pull Requests & Merging" and "Releasing".
  Follow-up round: TCG platforms (windows-x86, macos-x86) now run the **full suite by
  default** on dispatches — `platforms=all` really means everything (the old implicit
  anchor-smoke narrowing reported green on ~2-minute legs); smoke is opt-in via the new
  `tcg-smoke` input (the weekly sweep uses it to cap cost). `tested-versions.json` now
  credits exactly a run's target version — never versions booted incidentally by
  upgrade/pinned-channel tests — and `ci-metrics refold` rebuilds the rollup from the
  per-run files. Manual dispatches collect metrics by default.
- **Wizard channel default** (issue #46) now resolves the same way `add`/`start` do (`stable`
  when not configured, or the `default-channel` setting) instead of a hardcoded `long-term`,
  fixing a pre-existing inconsistency between the two entry points. The "recommended for
  provisioning" hint on `long-term` is unchanged. The wizard's architecture prompt and login
  prompt now similarly reflect the `default-arch`/`secure-login` settings.
- **`quickchr start --timeout-extra 0`** is now honored as an explicit zero instead of being
  silently treated as if the flag were omitted (incidental fix while wiring the new
  `timeout-extra` setting; issue #46).
- **`DESIGN.md`/`MANUAL.md`** storage-layout diagrams corrected: the documented-but-never-
  implemented `$QUICKCHR_DATA_DIR/quickchr/config.json` is replaced with the real
  `~/.config/quickchr/quickchr.env` (issue #46).
- **JSDoc parity** on the networking option types (`StartOptions.networks`/`extraPorts`,
  `NetworkSpecifier`, `PortMapping`, `tzspGatewayIp`) — maps specifiers to goals, documents
  UDP/range forwards, and notes the CLI↔library equivalence, so consumers don't have to read
  `network.ts` to discover capabilities (issue #18).
- Tightened `qemu-args` anchor assertions (single `-M`, `-m`/`-smp` values, `-drive` +
  headless `-display none`, indexed `-netdev`/`-drive` lookup, TCG-branch coverage) and added
  an empty-body `resolveVersion` → `INVALID_VERSION` case. Folds in the sound parts of the
  closed AI-findings PRs (#6/#8/#9).

### Fixed

- **arm64 snapshots never worked — savevm failed silently, loadvm wedged the guest**
  (issue #31). QEMU refuses `savevm` while the EFI-vars pflash is a writable raw file;
  the per-machine vars are now a qcow2 pflash (legacy machines migrate in place, NVRAM
  preserved), so `snapshot.save()/load()` genuinely work on arm64. Three masking layers
  fixed alongside: monitor responses are cleaned of command echo/ANSI so `Error:` lines
  reach the error checks, `snapshot.save()` throws instead of fabricating an entry when
  the snapshot is absent from `info snapshots`, and a failed `loadvm` issues `cont` so
  the guest is never stranded in `paused (restore-vm)`. Full evidence chain in
  `test/lab/arm64-rollback/REPORT.md`.
- **`secureLogin` was silently dropped when starting an already-`add()`-created machine**
  (issue #46) — `QuickCHR.start()`'s "first boot of an add()-created machine" path computed
  its own `hasPending` provisioning check without `secureLogin`, and didn't fall back to the
  value stored in `machine.json` the way sibling fields (`user`, `disableAdmin`, etc.) already
  did. This meant `--secure-login` (and the new `secure-login` setting/`QUICKCHR_SECURE_LOGIN`
  env var) had no effect at all for the standard `add` then `start <name>` workflow — only a
  single combined `add --secure-login` immediately followed by boot worked. Found via the new
  `secure-login` setting's integration test; fixed by including `secureLogin === true` in the
  pending-provisioning check and adding the missing `?? existing.secureLogin` fallback.
- **Wizard "quickchr managed login" never actually provisioned the managed account**
  (issue #46) — the wizard's `userChoice === "managed"` branch only set `disableAdmin: true`,
  never `secureLogin: true`, and `provision()` only auto-creates the replacement `quickchr`
  account when `secureLogin` is explicitly `true`. Choosing the recommended "managed login"
  option in the wizard could disable the default admin account with no replacement login
  provisioned at all. Fixed by setting both fields together; the decision logic is now a pure,
  directly unit-tested `resolveUserChoiceOptions()` export in `src/cli/wizard.ts`.
- **`quickchr start --all` ignored `timeout-extra`/`secure-login` entirely** (issue #46) — the
  bulk-restart path called `QuickCHR.start({ name, background: true })` directly, bypassing
  the settings/env/flag resolution the single-target path used. Both bulk and single-target
  restarts now share the same `resolveTimeoutExtraMs()`/`resolveSecureLoginFlag()` helpers.
- **An invalid `--timeout-extra` value silently became `NaN`** (issue #46) — e.g.
  `--timeout-extra abc` flowed through as `StartOptions.timeoutExtra: NaN`, serializing as
  `null` in `--dry-run` output and potentially causing an immediate boot-timeout cleanup on a
  real start. The flag is now validated with the same non-negative-integer rule the
  `timeout-extra` setting itself uses (shared `parseTimeoutExtraSeconds()`), while an explicit
  `--timeout-extra 0` is still correctly honored as zero, not "omitted."
- **`-T` (the documented short alias for `--timeout-extra`) never actually worked** (issue #46,
  found while adding test coverage for the previous fix) — `parseFlags()` only recognizes `--`
  prefixed flags; a bare `-T 15` fell through entirely into positional args and was silently
  ignored. Fixed with a small `applyTimeoutExtraShortFlag()` helper (same pattern `cmdLogs`
  already uses for its own `-f`/`-n` single-dash aliases), with unit coverage.
- **`quickchr settings print` crashed on a single malformed value** instead of showing the rest
  of the table (issue #46) — the all-keys path resolved each key with the strict
  `resolveSetting()` rather than the already-tested tolerant `settingsPrint()` helper. Now uses
  `settingsPrint()`, with CLI-level regression coverage (`test/unit/cli-settings.test.ts`).
- **`cache-max-size`/`timeout-extra` settings metadata contradicted their own documented
  defaults** (issue #46) — `quickchr settings print` showed `(unset)` for both even though
  MANUAL.md and the CLI's own help text documented concrete defaults (`2G`/`0`). Both now have
  a real `builtinDefault` (`DEFAULT_CACHE_MAX_BYTES` / `0`) — every consumer already treated
  "unset" and these exact values identically, so this is display-only, not a behavior change.
  `secure-login` intentionally keeps no `builtinDefault`: the wizard needs to distinguish "not
  configured" from "explicitly false" to know whether to still recommend managed login.

### Security

- All workflows now declare least-privilege `permissions: contents: read`
  (`ci.yml`, `publish.yml`, `verify-extended.yml`); the publish job keeps its per-job
  `id-token: write`. Clears the CodeQL `actions/missing-workflow-permissions` findings.
- The `test/lab/mndp/*` probes no longer pass network-derived data (`srcMac(frame)`) as a
  `console.log` format string (CodeQL `js/tainted-format-string`), and `ethToUdpPayload` now
  guards `udpLen >= 8`.

## [0.4.2] — 2026-06-21

### Added

- Public version/channel API for CI consumers (issue #3). The package entry
  (`@tikoci/quickchr`) now re-exports `resolveVersion`, `resolveAllVersions`,
  `parseVersionParts`, `compareRouterOsVersion`, `isValidVersion`,
  `isProvisioningSupportedVersion`, `CHANNELS`, and the `Channel` type — no more
  blocked deep `src/lib/...` imports.
- Recency-aware channel API: `resolveChannelStatuses()` / `classifyChannels()`
  classify each channel by `maturity` (`released` | `prerelease`) and
  `aheadOfStable`; `resolveActiveChannels()` / `selectActiveChannels()` return the
  channels currently worth booting — every released channel plus any pre-release at
  or ahead of a reference channel (default `stable`). The pure `classifyChannels` /
  `selectActiveChannels` take a `Record<Channel, string>` for network-free use.
  This answers "what's worth booting," never "what must pass" — gate policy stays
  with the consumer.
- `quickchr version --json` emits a `{ channel: version }` object (offline → `{}`).
- `quickchr doctor --json` emits `{ ok, checks, staleImages }`; exit code still
  reflects `ok`.

### Fixed

- `compareRouterOsVersion` now orders RouterOS pre-release suffixes:
  `7.24beta2` < `7.24rc1` < `7.24` < `7.24.1` (previously the `beta`/`rc` suffix was
  stripped, so those compared **equal**). **Behavior change** for callers that
  compared pre-release versions; release-vs-release comparisons (cache-prune,
  doctor stale-image check) are unaffected.

## [0.4.1] — 2026-06-17

### Fixed

- Downloads now resolve MikroTik's `upgrade`/`download` hosts via public DNS
  and connect over IPv4, so `resolveVersion()` and image/package downloads work
  on GitHub-hosted CI runners. Those runners' system resolver returns
  `ESERVFAIL` (slowly, 2–26 s) for `*.mikrotik.com` via both `getaddrinfo` and
  c-ares-over-`resolv.conf`, which made a plain `fetch` time out or fail with
  `errno: 0` before any CHR booted. New `fetchResilient()` (`src/lib/net.ts`)
  queries `1.1.1.1`/`8.8.8.8` directly (3 s timeout), connects to the IPv4
  literal with `Host` + TLS SNI preserved, and falls back to a normal `fetch`
  when public DNS is blocked. Consuming projects (e.g. centrs) need no
  `/etc/hosts` workaround. See DESIGN.md decision #9.

## [0.4.0] — 2026-06-07

First stable release on the `latest` track since 0.2.0 — rolls up the 0.3.x
pre-release line (`waitFor`, `captureInterface`, `tzspGatewayIp`, `portBase`)
plus the changes below.

### Added

- `StartOptions.noAuth` — convenience alias for `secureLogin: false`. Skip the
  managed `quickchr` user provisioning and leave admin password-less. Self-
  documenting alternative for callers who found `secureLogin: false` cryptic.
  When both are set, an explicit `secureLogin` value wins.
- `MachineState.secureLogin` is now persisted (was silently dropped in
  `start()` and add() state construction). Pre-0.3.1 machines are unaffected
  — the field is optional and defaults to undefined on read.
- `ChrInstance.exec()` JSDoc — documents the single-command-per-call rule
  (`/rest/execute` runs the input as one statement; multi-line `\n` strings
  may execute only the first line) and the soft-error pattern (RouterOS may
  return HTTP 200 with an error string in `output`, e.g. `/dude/agent/add`).
- `MANUAL.md` — new "ChrInstance at a glance" table grouping every method
  by purpose (identity, capture, lifecycle, comms, provisioning, files,
  snapshots, diagnostics). The reference block also now lists `portBase`,
  `captureInterface`, `tzspGatewayIp`, `waitFor()`, `upload()`, `download()`
  which had been added without a docs update.

### Changed

- `QuickCHR.start()` / `QuickCHR.add()` now warn (via the progress logger)
  when a channel name (`"stable"`, `"long-term"`, `"testing"`, `"development"`)
  is passed in the `version` field. Behavior is unchanged — the value still
  resolves as a channel — but the warning steers callers toward the
  self-documenting `channel:` field. JSDoc on `StartOptions.version` updated
  to call out the lenient acceptance.

## [0.3.0] — 2026-04-23

### Added

- `ChrInstance.waitFor(condition, timeoutMs?)` — polling helper that calls an
  async condition every 2 s, swallows errors, and resolves `true` when the
  condition passes or `false` on timeout. Replaces ad-hoc polling loops in lab
  scripts.
- `ChrInstance.captureInterface` — `"lo0"` on macOS, `"any"` on Linux; the
  correct `-i` value for `tshark` when capturing TZSP in QEMU user-mode
  networking. Previously callers had to hardcode the platform-specific value.
- `ChrInstance.tzspGatewayIp` — always `"10.0.2.2"` (QEMU slirp host gateway);
  the correct target for RouterOS `/tool/sniffer` streaming and RouterOS
  routing-server addresses to reach the host.
- `ChrInstance.portBase` — convenience alias for `state.portBase`, exposing the
  instance's collision-free port block base without requiring callers to access
  `state` internals.

## [0.2.0]

- Shell completions for bash, zsh, and fish (`quickchr completions`)
- Snapshot support: save, load, delete, list (`quickchr snapshot`)
- Disk management: `--boot-size`, `--add-disk`, `quickchr disk`
- Multi-NIC networking: `--add-network user|shared|bridged:<iface>|socket::<name>|tap:<iface>`
- Named virtual sockets for L2 inter-VM tunnels (`quickchr networks sockets`)
- `quickchr exec` — run RouterOS CLI commands via REST, QGA, or serial console
- `quickchr console` — attach to serial console of a running instance
- `quickchr get` — query live machine config (license, device-mode, credentials)
- `quickchr logs` — tail QEMU log with optional `--follow`
- Device-mode provisioning (`--device-mode`, `--device-mode-enable`, `--device-mode-disable`)
- CHR trial license provisioning (`--license-level`)
- Managed login with auto-generated credentials (`--no-secure-login` to opt out)
- Package install from `all_packages.zip` (`--add-package`, `--install-all-packages`)
- Provisioning version guardrails: post-boot provisioning requires RouterOS ≥ 7.20.8
- `quickchr clean` — reset disk to fresh image
- `quickchr status` — detailed instance info with credentials and connection tips
- CI: Linux x86_64 + aarch64 integration tests, macOS runners via dispatch
- CI: Windows unit tests on `windows-latest`
- CI: coverage enforcement (75% functions / 60% lines, warn-only)
- Library API: `QuickCHR.start()`, `ChrInstance` with `stop/remove/rest/exec/qga/snapshot/serial`
- `ChrInstance.upload()` / `.download()` — first-class SCP push/pull to a running CHR (uses instance credentials, no `sshpass` needed)
- `StartOptions.arch` now accepts `"auto"` as an explicit synonym for omission — both resolve to `hostArchToChr()`

### Fixed

- `arch: "auto"` silently falling through to arm64 (qemu-binary selector is a two-way switch). `resolveArch()` now normalizes `"auto"` and `undefined` to the host arch; agents no longer hit 480s TCG boot timeouts when they spell out the default.
- Bun connection pool stale-response bugs (all CHR REST now uses `node:http` + `agent: false`)
- Bun `req.destroy()` not emitting error event (timeout pattern with `done` flag)
- License error classification: `"ERROR: ..."` in HTTP 200 body now throws immediately
- Boot timeout auto-cleanup: failed boots remove QEMU process + state automatically
- `secureLogin` default changed to `false` (explicit opt-in, not surprise provisioning)

## [0.1.1] - 2026-04-20

- First GitHub release as `tikoci/quickchr`. Pre-release per the odd/even
  policy above: GitHub Actions CI has not yet run end-to-end against the
  hosted repo. Promote to `0.2.0` only after a green CI run on `main`.
- Not yet published to npm. Install from the GitHub repo (`bun add github:tikoci/quickchr`)
  or by cloning. The npm publish workflow exists (`.github/workflows/publish.yml`)
  but is gated on tagging `v0.2.0`.
