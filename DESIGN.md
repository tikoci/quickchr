# quickchr Design

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
- **Library** — `QuickCHR` class with static methods: `start()`, `list()`, `get()`, `doctor()`. Returns `ChrInstance` handles with `stop()`, `remove()`, `rest()`, `monitor()`, etc.
- **Modules** — Pure functions for QEMU arg building, image download, port allocation, state persistence.

### Key Design Decisions

1. **JSON state, not SQLite** — Portable to Windows without native deps. Each machine gets a `machine.json` file in `~/.local/share/quickchr/machines/<name>/`.

2. **Port block allocation** — 10 ports per instance (base + 0-9). Default starts at 9100. Avoids conflicts by scanning existing machines and probe-binding.

3. **No shell scripts** — QEMU args built entirely in TypeScript. Enables Windows support and testability.

4. **No qcow2** — Uses raw `.img` directly (MikroTik provides them). Simpler, no `qemu-img` dependency.

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

**Workflow**: `.github/workflows/ci.yml`

Three jobs — lint and unit-tests run in parallel; integration is gated on both:

```
lint                    unit-tests
Biome + tsc --noEmit    bun test test/unit/ --coverage
        ↘               ↙
        integration (matrix)
          linux/x86_64  (always)
          linux/aarch64 (always)
          macos/arm64   (workflow_dispatch: macos=true)
          macos/x86_64  (workflow_dispatch: macos=true)
```

**Integration matrix**: Each runner boots a CHR matching its native arch.  `detectAccel()`
selects KVM/HVF/TCG automatically — no per-runner overrides needed.

**Coverage**: `bun test test/unit/ --coverage` output is parsed and compared against
thresholds (default 75% functions, 60% lines).  Failures emit `::warning::` annotations
but do NOT block merges (`continue-on-error: true`).  Thresholds are overridable via
dispatch inputs `min-funcs` / `min-lines`.

**Artifacts** (details in `.github/instructions/ci.instructions.md`):
- `coverage-report` — full per-file coverage table (14 days)
- `integration-logs-{platform}` — bun test output + machine.json + qemu.log (7 days)

**Publish workflow** (`.github/workflows/publish.yml`): triggers on `v*` tags;
runs lint + typecheck + unit tests before npm publish.
