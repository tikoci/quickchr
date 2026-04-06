# quickchr Backlog

## P0 — MVP

- [x] Core library modules (types, platform, versions, network, state, images, qemu, channels)
- [x] QuickCHR class API (start, list, get, doctor)
- [x] ChrInstance (stop, remove, clean, rest, monitor, serial, qga)
- [x] CLI with subcommands (start, stop, list, status, remove, clean, doctor, version, help)
- [x] Interactive wizard (@clack/prompts)
- [x] Unit tests (versions, network, state, platform, qemu-args)
- [x] Integration test scaffolds (start-stop, library-api)

## P1 — Robustness

- [x] Foreground mode now correctly awaits QEMU exit (was returning immediately)
- [x] Package SCP uses `sshpass` for RouterOS empty-password auth (was failing silently)
- [x] Background mode is now the correct default (`--fg`/`--foreground` opts in to foreground)
- [x] Arch-specific package lists — zerotier/wifi-qcom are arm64-only; x86 wizard only shows valid packages
- [x] `start --all` restarts all stopped machines
- [x] Interactive selectors for `start`, `stop`, `status`, `remove`, `clean` when no name given
- [x] `remove --all` removes all machines
- [x] Foreground tips printed before QEMU launches (Ctrl-A X to quit, etc.)
- [x] `status` output includes WinBox URL, SSH tip, state explanation
- [x] `sshpass` added to `doctor` dependency check
- [x] `QUICKCHR_NO_PROMPT=1` env var suppresses all interactive prompts (for LLMs / scripts)
- [x] `waitForBoot` accepts 401/403 HTTP responses as "booted" (RouterOS may require auth on `/`)
- [x] Boot timeout unified to 120s (HVF/KVM boots in <30s; 120s covers TCG)
- [x] Warning logged when boot timeout expires with packages/provisioning pending
- [x] Small SSH warmup delay (2s) added after HTTP comes up before starting SCP uploads
- [x] Package install integration test added (`container` package install + REST verify)
- [x] Integration test instructions updated: mandatory before git commits
- [x] Foreground mode with provisioning: CHR boots in background, provisions (packages/users/license), then attaches serial socket to stdio. In non-TTY (CI/tests) serial attach is skipped silently.
- [x] Wizard shows correct hints per mode (QEMU mux Ctrl-A X for no-provisioning; Ctrl-C detach for provisioning)
- [x] Wizard adds 2s sleep before QEMU starts so user can read hints
- [x] `isPortAvailable` uses TCP connect probe instead of bind — immune to SO_REUSEADDR false positives on macOS
- [x] `detectAccel` arm64 HVF check uses `process.arch` not `hw.optional.arm64` sysctl (Intel Mac safety)
- [x] Provisioning integration test: user creation, admin disable, foreground non-TTY path
- [ ] Graceful cleanup on SIGINT/SIGTERM in foreground mode (SIGINT currently leaves pid file)
- [ ] Lock file to prevent concurrent starts of same machine
- [ ] Better error messages for common QEMU failures (EFI size mismatch, permission denied)
- [ ] Retry download on transient network errors
- [ ] `quickchr logs <name>` — tail qemu.log
- [ ] `quickchr exec <name> <command>` — execute RouterOS CLI command via SSH

## P2 — Enhanced Features

- [ ] Dynamic package list from cached all_packages.zip instead of static `KNOWN_PACKAGES` constants (version + arch dependent; current approach requires manual updates per release)
- [ ] Disk resize support (`--disk-size 512M`)
- [ ] Snapshot/restore using QEMU monitor savevm/loadvm
- [ ] QGA file operations (push config files via guest agent on x86)
- [ ] Machine templates (save/apply config presets)
- [ ] Auto-update check for QEMU and RouterOS
- [ ] `quickchr upgrade <name>` — upgrade RouterOS in-place

## P3 — Distribution & CI

- [ ] npm publish workflow (GitHub Actions on tag)
- [ ] CI with real CHR boot on ubuntu-latest KVM
- [ ] Homebrew formula
- [ ] Binary builds via bun compile
- [ ] Shell completions (bash, zsh, fish)

## P4 — Advanced Networking

- [ ] vmnet-shared and vmnet-bridge tested on macOS
- [ ] TAP networking on Linux
- [ ] Multi-CHR mesh networking (connect instances via bridge)
- [ ] VXLAN overlay between CHRs

## Ideas

- Web UI dashboard (Bun.serve + SSE for live status)
- VS Code extension with CHR manager sidebar
- RouterOS config diff tool (capture config before/after)
- Test matrix runner (spin up CHR on multiple versions, run test suite)
