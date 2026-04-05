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

- [ ] Graceful cleanup on SIGINT/SIGTERM in foreground mode
- [ ] Lock file to prevent concurrent starts of same machine
- [ ] Better error messages for common QEMU failures (EFI size mismatch, permission denied)
- [ ] Retry download on transient network errors
- [ ] `quickchr logs <name>` — tail qemu.log
- [ ] `quickchr exec <name> <command>` — execute RouterOS CLI command via SSH

## P2 — Enhanced Features

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
