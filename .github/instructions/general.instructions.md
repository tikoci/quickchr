---
applyTo: "src/**"
---

# General Code Instructions

## Runtime

- **Bun** — not Node.js. Always use Bun APIs: `Bun.spawn()`, `Bun.write()`, `Bun.sleep()`.
- All code is ESM. Use `.ts` extensions in relative imports.
- No CommonJS (`require`, `module.exports`).

## Layer Rules

- `src/lib/` — Pure library. NEVER import from `src/cli/`. No `process.exit()`.
- `src/cli/` — CLI wrapper. May import from `src/lib/`. Owns terminal output and `process.exit()`.
- `src/index.ts` — Public barrel export. Only re-exports from `src/lib/`.

## Error Handling

- Throw `QuickCHRError(code, message, installHint?)` from library code.
- CLI layer catches errors and prints user-friendly messages.
- Error codes: `MISSING_QEMU`, `MISSING_FIRMWARE`, `PORT_CONFLICT`, `DOWNLOAD_FAILED`, `TIMEOUT`, `STATE_ERROR`, `INVALID_VERSION`, `SPAWN_FAILED`.

## Key API Patterns

- `QuickCHR.start(opts)` returns `ChrInstance` — the runtime handle.
- `ChrInstance` has: `.stop()`, `.remove()`, `.rest()`, `.monitor()`, `.serial()`, `.qga()`, `.ports`, `.state`.
- Port blocks: 10 ports per instance, base 9100. Offsets: +0=HTTP, +1=HTTPS, +2=SSH, +3=API, +4=API-SSL, +5=WinBox.

## Style

- Biome 2.x lint only (no formatting). Run: `bun run lint:biome`.
- Tabs for indentation.
- No unnecessary comments on obvious code.

## End-of-Session Review

After completing significant work (new features, design changes, bug fixes with architectural impact), check:

1. **DESIGN.md** — Do new implementation details, design decisions, or discovered constraints need documenting? Review git diff and memory for "added but undocumented" behavior.
2. **BACKLOG.md** — Has any tracked item been completed? Did new work reveal items to add? Update status and priority as needed.

This is a lightweight habit, not a gate. Skip for trivial changes.
