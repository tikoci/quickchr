# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Even minor versions (0.2.x, 0.4.x) are releases; odd minors (0.3.x, 0.5.x) are pre-releases.

## [Unreleased]

### Added

- Interactive setup wizard (`quickchr setup`) with main-menu loop
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

### Fixed

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
