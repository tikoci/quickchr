---
applyTo: "test/**"
---

# Testing Instructions

## Test Structure

- `test/unit/` — Fast, pure tests. No network, no QEMU, no disk IO beyond temp dirs.
- `test/integration/` — Requires QEMU. Gated by `QUICKCHR_INTEGRATION=1`.

## Framework

Use `bun:test` exclusively:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
```

## Conventions

- Test files: `*.test.ts`
- Use `describe`/`test` (not `it`)
- Integration tests: use `describe.skipIf(!process.env.QUICKCHR_INTEGRATION)`
- Long-running tests: set timeout as second arg to `test("...", async () => {...}, 120_000)`
- Temp directories: create in `import.meta.dir`, clean up in `afterEach`

## Running

```bash
bun test test/unit/                    # Fast unit tests
QUICKCHR_INTEGRATION=1 bun test test/integration/  # Integration (needs QEMU)
bun test                               # All tests
```

## What to Test

- **versions.ts**: URL generation, version validation, machine name generation
- **network.ts**: Port allocation, mapping generation, hostfwd strings
- **state.ts**: Save/load/list/remove machines (use temp HOME)
- **platform.ts**: Package manager detection, binary finding
- **qemu.ts**: Arg builder output (skip if QEMU not installed — catch MISSING_QEMU)
- **quickchr.ts**: Dry-run start, list, get, doctor
