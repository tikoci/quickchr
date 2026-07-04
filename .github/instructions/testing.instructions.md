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
- Unix socket tests: use `join(tmpdir(), "quickchr-tmp-<name>")` from `node:os` — FUSE mounts (e.g. Multipass) don't support Unix domain sockets
- Always clean up CHR instances in a `finally` block so failures don't leak machines

## Running

```bash
bun test test/unit/                              # Fast unit tests (always)
QUICKCHR_INTEGRATION=1 bun test test/integration/  # Integration (needs QEMU)
bun test                                         # All tests
```

### Targeting a RouterOS release

Integration tests boot `stable` by default. Set `QUICKCHR_TEST_TARGET` to point CHR boots
at another release — a channel (`stable`/`long-term`/`testing`/`development`) or a pinned
version (`7.22.1`, `7.24beta2`). This is the same knob the `integration.yml`
`routeros-target` dispatch input exports; tests read it via `test/integration/image-target.ts`.

```bash
QUICKCHR_TEST_TARGET=long-term QUICKCHR_INTEGRATION=1 bun test test/integration/
QUICKCHR_TEST_TARGET=7.24beta2 QUICKCHR_INTEGRATION=1 bun test test/integration/start-stop.test.ts
```

Unset/empty → `stable` (unchanged behavior). Version-pinned tests (provisioning's
`7.20.7`/`7.20.8`, library-api's `7.22.1`) ignore the override. An *old* pinned target will
fail version-gated provisioning/device-mode tests by design.

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

**Do NOT treat a feature as done — closing its GitHub issue or adding it to CHANGELOG.md — until `QUICKCHR_INTEGRATION=1 bun test test/integration/` passes with a test that exercises that feature end-to-end.**

Rationale: the RouterOS REST API has non-obvious blocking behavior (e.g. `/system/device-mode/update`
holds the HTTP connection open until power-cycle confirmation). These behaviors cannot be caught
by unit tests and have caused previously "done" features to be broken in practice.

## CI Integration

Integration tests run in CI on every **push to `main`** (`main.yml`) across two runners:
- `linux/x86_64` (ubuntu-latest) → x86 CHR, KVM if available
- `linux/aarch64` (ubuntu-24.04-arm) → arm64 CHR, KVM if available

They do **not** run on PRs — PRs carry a required `Integration freshness` check instead
(latest completed `main.yml` run on `main` must be green; see `ci.instructions.md`). To get
integration signal for a branch before merging, dispatch the reusable unit directly:
`gh workflow run integration.yml --ref <branch> -f platforms=linux-x86 -f test-filter=<file>`.
The weekly `sweep.yml` covers macOS/Windows platforms and the examples smoke harness.

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
| Polls for 90s then fails | Error in response body misclassified as "pending" | Check classification function — RouterOS returns errors inside HTTP 200 |

### A failing test is a signal — masking it is forbidden

The flowchart above bans the timeout-bump. The same logic bans **every** move that turns
a red test green without understanding why it was red:

- **`skip` / `.skipIf` / `os`- or `arch`-gating a failing test is the worst of these.** A
  bumped timeout still runs the test; a skip removes it from the suite, so the bug it
  caught silently escapes tracking. Filing an issue alongside the skip does not make it
  safe — it just makes masking look responsible. Only gate AFTER a local reproduction
  proves a genuine, unfixable platform limit, and make the gate cite that repro.
- **"It's a platform limitation" is a hypothesis, not a conclusion, until reproduced
  locally.** We have QEMU here and can boot any CHR arch — x86 under HVF, arm64 under TCG
  (slow, but real). One CI run across a few runners is not a repro. Never substitute a
  remembered "known QEMU behavior" for an actual local experiment.
- **One CI failure must not cascade.** A single unverified red run is not license to edit
  `DESIGN.md`, API docs, a scoped instruction/doc, issues, or skills. Ground first; document second.

### Experiment First, Code Second

**MANDATORY for any REST/provisioning change**: Before writing or refactoring code, run a
live experiment against a real CHR to understand the actual behavior:

```bash
# Step 1: Use curl to see what the endpoint ACTUALLY returns
curl -v -u admin: http://127.0.0.1:9100/rest/system/license/renew \
  -X POST -H "Content-Type: application/json" \
  -d '{"account":"...","password":"...","level":"p1","duration":"10s"}'

# Step 2: Check RouterOS logs for the operation
curl -s -u admin: http://127.0.0.1:9100/rest/log?=detail

# Step 3: Use our own tool to probe the state
bun run dev -- exec <machine> ":put [/system/license/get level]"
```

**Evidence that must exist before any code change:**
- Actual curl output showing the exact response shape
- The specific field/value that is wrong or missing
- A concrete hypothesis ("field X is Y, should be Z, because...")

**Red flags that indicate guessing (do NOT proceed):**
- "RouterOS is flaky" — it's not; our logic is wrong
- "Increase the timeout" — something is failing silently
- "Switch HTTP library" — prove the library bug first with a minimal repro
- "Add retry logic" — retrying a broken command doesn't fix it

### Historical lesson (sessions 008-017)

The same Bun connection pool bug was discovered and fixed file-by-file 7 times because:
1. No instruction file documented the bug and fix pattern
2. Each session guessed independently instead of reading prior work
3. Timeouts were increased first (masking), then node:http applied (correct but narrow)

The fix was proven (checkpoint 011, 013, 017) via observable symptoms: POST returns in <2ms
with GET data, stale SSH key listings in exec response. But it took 10 sessions because
nobody ran `curl` first to see what RouterOS actually returned.

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
