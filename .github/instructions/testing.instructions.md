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
- Always clean up CHR instances in a `finally` block so failures don't leak machines

## Running

```bash
bun test test/unit/                              # Fast unit tests (always)
QUICKCHR_INTEGRATION=1 bun test test/integration/  # Integration (needs QEMU)
bun test                                         # All tests
```

## Integration Test Requirements

**Run integration tests before every `git commit` or PR.** They exist specifically because
quickchr spins up real CHR instances — unit tests cannot catch runtime issues like package
SCP timing, boot sequence, or port mapping problems.

We have QEMU available locally. There is no excuse to skip integration tests. To run:

```bash
QUICKCHR_INTEGRATION=1 bun test test/integration/
```

## What to Test

- **versions.ts**: URL generation, version validation, machine name generation
- **network.ts**: Port allocation, mapping generation, hostfwd strings
- **state.ts**: Save/load/list/remove machines (use temp HOME)
- **platform.ts**: Package manager detection, binary finding
- **qemu.ts**: Arg builder output (skip if QEMU not installed — catch MISSING_QEMU)
- **quickchr.ts**: Dry-run start, list, get, doctor

## Every New Feature Needs a Test

New library functionality must include an integration test that:
1. Starts a real CHR instance with `background: true`
2. Exercises the feature (package install, API call, etc.)
3. Asserts the expected outcome via the REST API or state
4. Cleans up with `instance.remove()` in a `finally` block

Example: `packages` option → verify via `/rest/system/package` that the package appears
as active after `QuickCHR.start` returns.

## CI Integration

Integration tests run in CI on every push/PR to `main` across two runners:
- `linux/x86_64` (ubuntu-latest) → x86 CHR, KVM if available
- `linux/aarch64` (ubuntu-24.04-arm) → arm64 CHR, KVM if available

Each runner auto-selects the CHR arch from `process.arch` — no test changes needed.

If a CI integration run fails, check (in order):
1. **Step summary** — last 80 lines of test output per runner
2. **`integration-logs-{platform}` artifact** — `qemu.log` for boot errors, `integration-output.txt` for test errors, `machine.json` for state
3. **Annotations** — `::error::` lines appear inline on the commit

See `.github/instructions/ci.instructions.md` for the full artifact map and failure diagnosis guide.
