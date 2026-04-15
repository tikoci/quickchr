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

## CHR-Interacting Features Must Be Integration-Tested Before "Done"

**A feature is NOT done until its integration test passes against a real running CHR.**

Unit tests and mock tests are insufficient for any feature that:
- Sends commands to or reads from RouterOS (REST calls, provisioning steps)
- Interacts with the QEMU monitor, serial, or QGA channels
- Performs a hard reboot / power-cycle sequence
- Reads or writes RouterOS state (device-mode, license, users, packages)

**Do NOT mark a feature `[x]` in BACKLOG.md until `QUICKCHR_INTEGRATION=1 bun test test/integration/` passes with a test that exercises that feature end-to-end.**

Rationale: the RouterOS REST API has non-obvious blocking behavior (e.g. `/system/device-mode/update`
holds the HTTP connection open until power-cycle confirmation). These behaviors cannot be caught
by unit tests and have caused previously "done" features to be broken in practice.

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

## Debugging Test Failures — Diagnosis Flowchart

**Never increase a timeout as a first fix.** It masks the root cause. Follow this flowchart:

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Passes alone, fails in suite | Stale CHR machine on same port (beforeAll cleanup incomplete) | Add machine name to `beforeAll` cleanup list |
| Hangs forever | Promise never resolves — missing timeout or Bun.secrets Keychain dialog | Check timeout patterns, check `MIKROTIK_WEB_*` env vars |
| Wrong/stale response data | Post-boot REST race (field not yet populated) | Add field-presence polling loop with deadline |
| Times out at full timeout | CHR not booting (QEMU issue, firmware issue) | Check `qemu.log` and `machine.json` in machine dir |
| HTTP 401 on unit test | Unit test mocks `globalThis.fetch` but code uses `rest.ts` (node:http) | Use `createServer` mock pattern (see `license.test.ts`) |
| ECONNRESET noise in output | Expected on fire-and-forget calls (device-mode power-cycle) | Ensure `.catch(() => {})` attached immediately to pending promise |

### Prove Before Refactoring

When a test fails, **understand the actual behavior before changing code**:
1. Add `console.log` to see actual values at the failure point
2. Use `curl -v http://127.0.0.1:{port}/rest/...` against the running CHR
3. Enable RouterOS logging: `/system/logging/add topics=debug,!packet,!raw action=memory`
4. Check `qemu.log` in the machine directory for QEMU-level issues
5. Only after understanding the root cause should you modify the code

### Unit Test Mock Pattern

- **CHR REST code** (uses `rest.ts` → `node:http`): Mock with `createServer` from `node:http`.
  Listen on port 0 (auto-assign), pass port to function under test, clean up in `afterEach`.
- **External URL code** (uses `fetch()` directly): Mock with `globalThis.fetch = ...`.
  Only valid for `versions.ts`, `images.ts`, `packages.ts`.

## Lab Tests (test/lab/)

For longer single-test explorations that don't belong in CI:
- Semi-durable scripts to collect data, validate assumptions, make decisions
- May be re-run to recheck assumptions after code changes
- NOT part of CI — `bun test` doesn't run them unless explicitly pointed at `test/lab/`
- Use for RouterOS behavioral investigation (async commands, timing, REST semantics)
