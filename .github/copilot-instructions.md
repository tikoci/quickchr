# quickchr — Copilot Instructions

## Project

quickchr is a TypeScript/Bun CLI + library to manage MikroTik CHR virtual machines via QEMU.
Published as `@tikoci/quickchr` on npm.

## Runtime

- **Bun** — not Node.js. Use `Bun.spawn()`, `Bun.write()`, `Bun.sleep()`, `bun test`, `bun:test`.
- No CommonJS. All code is ESM with `.ts` extensions in imports.
- Test framework: `bun:test` (`describe`, `test`, `expect`).

## Architecture

- `src/lib/` — Pure library modules. No CLI dependencies, no `process.exit()`.
- `src/cli/` — CLI layer. Thin wrapper over library.
- `src/index.ts` — Barrel export for consumers.
- `test/unit/` — Fast tests, no QEMU needed.
- `test/integration/` — Needs QEMU, guarded by `QUICKCHR_INTEGRATION=1`.

## Key Types

- `QuickCHR` — Main class. `QuickCHR.start(opts)` returns `ChrInstance`.
- `ChrInstance` — Runtime handle: `stop()`, `remove()`, `rest()`, `monitor()`, `serial()`, `qga()`.
- `StartOptions` — All options for starting a CHR.
- `MachineState` — Persisted state in machine.json.

## QEMU Rules

- ARM64 (`virt` machine): NEVER use `if=virtio` for drives. Always explicit `-device virtio-blk-pci,drive=drive0`.
- HVF acceleration: use `-cpu host` (not cortex-a710).
- pflash units (UEFI code + vars) must be identical size.
- QGA is x86 only (arm64 CHR doesn't start the guest agent).

## Code Style

- Linter: Biome 2.x (no formatter, lint only). Run: `bun run lint:biome`.
- Tabs for indentation.
- No unnecessary comments on obvious code.
- Errors: throw `QuickCHRError(code, message, installHint?)`.

## Commands

```bash
bun install                  # Install deps
bun test test/unit/          # Run unit tests
bun run check                # Run all linters
bun run dev -- doctor        # Run CLI in dev mode
```
