# quickchr Design

> Architecture and rationale. For the user-facing reference (every CLI
> command, every library API, provisioning, channels, networking, errors)
> see **[MANUAL.md](./MANUAL.md)**.

## Architecture

quickchr is a TypeScript/Bun CLI + importable library to manage MikroTik CHR virtual machines via QEMU.

### Layers

```text
CLI (src/cli/)          ← Arg parsing, wizard, formatting
    ↓
Library API (src/lib/quickchr.ts)  ← QuickCHR class, ChrInstance
    ↓
Modules (src/lib/)      ← qemu, images, versions, network, state, ...
```

- **CLI** — git-style subcommands + interactive wizard. Thin layer over the library.
- **Library** — `QuickCHR` class with static methods: `start()`, `add()`, `list()`, `get()`, `doctor()`. Returns `ChrInstance` handles with `stop()`, `remove()`, `rest()`, `exec()`, `monitor()`, etc.
- **Modules** — Pure functions for QEMU arg building, image download, port allocation, state persistence.

### Key Design Decisions

1. **JSON state, not SQLite** — Portable to Windows without native deps. Each machine gets a `machine.json` file in `~/.local/share/quickchr/machines/<name>/`.

2. **Port block allocation** — 10 ports per instance (base + 0-9). Default starts at 9100. Avoids conflicts by scanning existing machines and probe-binding.

3. **No shell scripts** — QEMU args built entirely in TypeScript. Enables Windows support and testability.

4. **Optional qcow2** — Default boot disk uses raw `.img` (MikroTik provides them). Users can opt into `qcow2` format for boot resize and QEMU snapshot/restore support. Requires `qemu-img` when enabled.

5. **ARM64 VirtIO rule** — Never use `if=virtio` on aarch64 `virt` machine. Always explicit `-device virtio-blk-pci,drive=drive0`.

6. **Class-based API** — `QuickCHR` is a class with static methods for clean namespacing. `ChrInstance` is an interface implemented as a plain object with closures.

## Port Layout

| Offset | Service    | Guest Port |
|--------|------------|------------|
| +0     | HTTP/REST  | 80         |
| +1     | HTTPS      | 443        |
| +2     | SSH        | 22         |
| +3     | API        | 8728       |
| +4     | API-SSL    | 8729       |
| +5     | WinBox     | 8291       |
| +6—9   | Custom     | —          |

## Storage Layout

```text
~/.local/share/quickchr/
├── cache/                     # Downloaded images
│   ├── chr-7.22.1.img.zip
│   ├── chr-7.22.1.img
│   └── ...
├── machines/
│   └── 7.22.1-arm64-1/
│       ├── machine.json       # Config + state
│       ├── disk.img           # Working copy
│       ├── efi-vars.fd        # UEFI vars (arm64)
│       ├── monitor.sock       # QEMU monitor
│       ├── serial.sock        # Serial console
│       ├── qga.sock           # QGA (x86 only)
│       ├── qemu.pid           # PID file
│       └── qemu.log           # Output log
└── config.json                # Global config
```

## Platform Support

| Platform               | x86 CHR | arm64 CHR | Notes |
|------------------------|---------|-----------|-------|
| macOS x86_64           | HVF     | TCG       | Intel Mac |
| macOS arm64 (native)   | HVF     | HVF       | Apple Silicon, bun is arm64 |
| macOS arm64 (Rosetta)  | HVF     | TCG       | bun is x86_64; arm64 HVF skipped |
| Linux x86_64           | KVM     | TCG       | KVM requires `/dev/kvm` writable |
| Linux aarch64          | TCG     | KVM       | x86 TCG on arm64 Linux |
| Windows x86_64         | TCG     | TCG       | HVF/KVM not available |

**Acceleration detection** (`detectAccel`):
- macOS: checks `kern.hv_support` via sysctl; for arm64 guest additionally checks `process.arch === "arm64"` (native bun = Apple Silicon).
- Linux: checks `/dev/kvm` writability.
- Falling back to TCG is always safe, just slower (~20s x86 TCG boot on Apple Silicon; ~2 min arm64 TCG on Intel).

## CI System

**Workflows**: `.github/workflows/{ci,verify-extended,publish}.yml`. Full artifact map and
failure-diagnosis guide live in `.github/instructions/ci.instructions.md` — this section is
the high-level rationale only.

**`ci.yml`** — core quality gate on every push/PR to `main`:

```text
lint (ubuntu)  ──┐
unit-tests (ubuntu, --coverage) ──┴→ integration-x86 (ubuntu) → windows-unit-tests (windows-latest)
```

`lint` and `unit-tests` run in parallel. `integration-x86` boots an x86 CHR (KVM if
available, else TCG) and gates on both. `windows-unit-tests` runs last — if the core is
broken, Windows runner minutes add no signal. Only x86 integration runs on every push;
cross-arch and macOS are too slow/fragile for the per-push gate.

**`verify-extended.yml`** — `workflow_dispatch` only. Independent jobs (no cross-`needs:`)
for the platforms kept out of the per-push gate: linux/aarch64, macOS (arm64 + x86), and
Windows. Dispatch inputs `arm64` / `macos` / `windows` select platforms; `test-filter`
narrows to specific test files for fast iteration. Each runner boots a CHR matching its
native arch — `detectAccel()` selects KVM/HVF/TCG automatically, no per-runner overrides.

**`publish.yml`** — triggers on `v*` tags (or dispatch). Runs lint + unit + x86 integration +
windows-unit before `npm publish` (`--tag next` for odd/pre-release minors, `--tag latest`
for even/stable). See "Release Process" in `ci.instructions.md`.

**Coverage**: `unit-tests` parses `bun test --coverage` output and compares against thresholds
(default 75% functions, 60% lines). Failures emit `::warning::` annotations but do NOT block
merges (`continue-on-error: true`). Thresholds are overridable via dispatch inputs
`min-funcs` / `min-lines`.

**Artifacts**:
- `coverage-report` — full per-file coverage table (14 days)
- `integration-logs-{platform}` — bun test output + machine.json + qemu.log (7 days)

## Design Principles

### Scope Boundary — QEMU Expert, Not Orchestrator

quickchr manages individual CHR instances. Multi-router topologies, test matrices, and workflow orchestration are **out of scope** for the CLI and library. Provide `examples/` with Makefiles and `bun:test` scripts to inspire, but don't build a framework. Users (and their AI agents) compose quickchr instances into whatever topology they need — we give them reliable building blocks.

### Networking — Discover, Don't Configure

For advanced networking (TAP interfaces, bridges), quickchr **discovers and presents options** but does not manage OS-level network configuration. On macOS, vmnet is straightforward (root + a QEMU flag). On Linux, TAP requires editing system files that vary by distro and network manager — that's the user's domain. quickchr will enumerate available interfaces, generate the correct QEMU flags, and link to tikoci docs for setup guides.

#### SLiRP hostfwd — Why User-Mode Must Be ether1

QEMU SLiRP (`-netdev user`) hostfwd **requires** the guest to have an IP address (default `10.0.2.15`) on the SLiRP-connected interface. Without it, `hostfwd` accepts TCP connections on the host side (creating a half-open state) but the guest never receives data — HTTP requests hang until timeout.

RouterOS auto-creates a DHCP client only on ether1. SLiRP includes a DHCP server that assigns `10.0.2.15`. Therefore **SLiRP must be ether1** for zero-config provisioning. This is why `user` is always the first network in multi-NIC configurations.

When adding shared/bridged as ether2+, a manual DHCP client is needed:
```
POST /rest/ip/dhcp-client/add
{"interface":"ether2","use-peer-dns":"yes","add-default-route":"yes","default-route-distance":"2"}
```

The `default-route-distance=2` ensures the shared route is backup — SLiRP ether1 remains the primary gateway, avoiding ECMP dual-gateway side effects.

**TCG hazard:** SLiRP half-open connections (TCP connect succeeds, data never flows) burn the full per-probe HTTP timeout in `waitForBoot`. Under cross-arch TCG where TCP round-trips are slow, this compounds badly. Lab: `test/lab/slirp-hostfwd/`.

### Platform Priority

macOS → Linux → Windows. Mac and Linux share most code paths with minor `#ifdef`-style branches. Windows is tracked but lower priority — larger RouterOS admin audience there, but fewer recipes and harder to test. Windows CI runner planned after the existing macOS/Linux matrix is stable.

### CLI Design

Tighten before expanding. New subcommands (`logs`, `exec`, `console`) wait for a full command tree review. The CLI should be discoverable without paging `--help` — shell completions help more than a long command list. Use multipass and virsh as reference points for symmetry, not to copy.

### RouterOS Verification

Always read back what we write. One extra REST API call after a provisioning action (license, user, package) catches version-specific command drift early. Surface errors with actionable hints rather than silent failures.

### Provisioning Scope

quickchr provisions at first boot and (optionally) on restart:
- **User creation** — create user, set password, optionally disable admin
- **Package install** — SCP `.npk` files, reboot to activate
- **License** — `/system/license/renew` for trial
- **Device-mode** — `/system/device-mode/update mode=rose container=yes ...` for restricted features (containers, traffic-gen, routerboard). Opt-in: not configured unless explicitly requested via CLI `--device-mode` or API `deviceMode` option. CHR ships with `mode=advanced` which is sufficient for most use cases. Device-mode requires a hard QEMU power-cycle to confirm changes — this is the MikroTik-mandated confirmation mechanism (physical button press on real hardware, cold reboot on VM). The wizard defaults to `rose` when the user opts in, since it enables containers. See: https://help.mikrotik.com/docs/spaces/ROS/pages/93749258/Device-mode
- **Config import** — planned: load `.rsc` or `.backup` at creation time

Provisioning via REST API is preferred (simple HTTP calls). Serial console provisioning (prompt detection + buffer tracking, as in chr-armed) is a fallback for locked environments. Key lessons from chr-armed serial work: use `\r` not `\r\n` on PTY; accumulate buffer with offset tracking to prevent re-matching; detect prompts dynamically, don't use fixed delays.

### Exec Transport Design

`quickchr exec` supports multiple transports via `--via=auto|ssh|rest|qga`:
- **auto** (default) — currently REST only; future: try SSH first, fall back to REST `/execute`
- **rest** (implemented) — POST to `/rest/execute` with `{"script": "<command>"}` (RouterOS 7.1+). No SSH needed. 60-second server-side timeout. Uses `resolveAuth()` for smart credential resolution.
- **ssh** (planned) — full RouterOS CLI, supports interactive commands, requires `sshpass`
- **qga** (implemented) — QEMU Guest Agent commands (x86 only today, ARM64 pending MikroTik fix)

**Credential resolution** (`src/lib/auth.ts`): Priority order is (1) explicit `--user`/`--password` override, (2) provisioned user from `machine.json` (`state.user`), (3) CHR default `admin:` (empty password). Both `exec()` and `rest()` on ChrInstance use this.

Output formatting via `--json` flag. RouterOS trick for structured output: wrap commands in `[:serialize to=json [<routeros-cmd>]]` to get JSON from any CLI command. For REST-to-CLI mapping, see tikoci/restraml `lookup.html`.

### Examples Philosophy

Three representations of each scenario, targeting different audiences:
- **Makefile** — recipe-driven, targets as documentation (tikoci tradition, see tikoci/netinstall). Agents read targets; humans run `make`.
- **bun:test** — library API, TypeScript. First-class integration tests. The "source of truth."
- **Python** — subprocess around CLI. The language agents and network engineers both reach for. Demonstrates quickchr is a real tool, not just a library.

Building examples early is a form of "anchor testing" for the CLI surface — it finds ergonomic issues before we commit to new commands.

### Document Maintenance

DESIGN.md and BACKLOG.md are living documents. At the end of any significant work session, agents should review whether new implementation details, design decisions, or discovered constraints belong in DESIGN.md, and whether completed/new work should update BACKLOG.md. Treat this as a lightweight checklist, not a gate.
