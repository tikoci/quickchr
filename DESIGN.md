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

| Platform        | Accel | x86 CHR | arm64 CHR |
|-----------------|-------|---------|-----------|
| macOS arm64     | HVF   | TCG     | HVF       |
| macOS x86_64    | HVF   | HVF     | TCG       |
| Linux x86_64    | KVM   | KVM     | TCG       |
| Linux aarch64   | KVM   | TCG*    | KVM       |
| Windows x86_64  | TCG   | TCG     | TCG       |

*x86→arm64 TCG works (~20s boot). arm64→x86 TCG is not viable.
