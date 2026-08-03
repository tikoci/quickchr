---
applyTo: "examples/**"
---

# Examples Instructions

`examples/` is load-bearing **agent-onboarding surface** — agents open it before
`src/lib/`. Every example is a copy-and-run artifact that *does something real*
against a CHR, showing both the **CLI and the library API**.

## The shape (one per `examples/<name>/`)

| File | Role | When |
|---|---|---|
| `<name>.ts` | **Primary** — runnable Bun script, library API. `#!/usr/bin/env bun`; `if (import.meta.main) main()`; `try…finally` teardown; `process.exitCode = 1` on failure. | always (except `grounding`) |
| `<name>.sh` | CLI version — POSIX `sh`, sources `../common.sh`. | most |
| `<name>.ps1` | PowerShell CLI mirror. Sets `$ErrorActionPreference = 'Stop'` **before** dot-sourcing `../common.ps1` (see "Exit 0 is not evidence"). | **all new** examples; existing where the CLI flow is simple |
| `<name>.py` | Python CLI driver, run with `uv run` (stdlib only). | where a non-TS audience adds value |
| `<name>.test.ts` | `bun:test` — only when assertions ARE the documentation. | `grounding` only |
| `README.md` | from `_template/README.md`. | always |
| `<subdir>/` | supporting files (configs, tools). | as needed |

Start from [`_template/`](../../examples/_template/). New capability coverage goes
in [`COVERAGE.md`](../../examples/COVERAGE.md) (mark docs/test-only with a reason).

## Rules

- **Runnable scripts, not tests.** The default is a `bun run`-able `.ts`. Reach for
  `bun:test` only when the assertions are the point (`grounding` is the sole one).
  An agent can wrap any script in `test()` trivially.
- **Guaranteed teardown.** Use `runExample()` from `../lib.ts` (success OR failure
  removes the machine). **Never `process.exit()` before teardown** — quickchr spawns
  QEMU detached, so an abrupt exit strands a running machine.
- **Deterministic naming.** Machines are `examples-<name>-<unique>`
  (`exampleMachineName()` / `example_name`) — parallel-safe and prefix-reapable.
- **Parallel-safe ports.** Never hard-code a host port. Let quickchr auto-allocate,
  or use `freePort()` / `free_port`. The one exception (`version-matrix`) pins
  distinct port-bases for parallel starts and says so.
- **POSIX `.sh`.** `#!/bin/sh`, `set -eu`, quoted vars, `trap` cleanup; no
  arrays / process-substitution / `[[ ]]`. Verify with `sh`, not bash.
- **`uv` over venv** for Python; resolve quickchr via `$QUICKCHR` / `--quickchr`.
- **`$QUICKCHR` resolution** (CLI scripts) defaults to the repo source CLI so CI and
  local runs exercise *this* checkout, not a global install.
- **Friction found.** If an example needs raw curl/scp/ssh, `machine.json` reads,
  long sleeps, or fragile parsing, log it in the README's "friction found" and open a
  GitHub issue — decide whether quickchr should grow a better surface (don't paper over it).
- **CI:** `bun run check` runs biome, `tsc --noEmit`, markdownlint, cspell,
  `scripts/validate-examples.ts`, and shellcheck (`-s sh`). The smoke harness
  (`test/integration/examples-smoke.test.ts`) + PowerShell `Invoke-ScriptAnalyzer`
  run in extended verification, across the supported-OS matrix. `trial-license`
  is manual-only (rate limits).

## Exit 0 is not evidence ([#102](https://github.com/tikoci/quickchr/issues/102))

An example that exits 0 and prints *something* is not a passing example. Two
instances shipped green for months:

- A `ParserError` in `common.ps1` took out the whole file, so every helper in
  `quickstart.ps1` was undefined. No quickchr command ran; the script printed one
  line and exited 0.
- `mndp.py`'s "no announcement received" branch used a bare `return`, which leaves
  `main()` through the `finally` and never reaches its `sys.exit(rc)` — so the
  failure path exited 0.

Three rules, each holding one end of that:

- **The smoke harness asserts output markers**, not just `code === 0` and
  `out.length > 0`. Each entry in `examples-smoke.test.ts`'s `RUNNABLE` names
  substrings only a working run produces — including one from the END of the script
  and one the CLI/library emitted rather than the example's own `echo`.
- **`.ps1` sets `$ErrorActionPreference = 'Stop'` before dot-sourcing `common.ps1`**,
  duplicating what `common.ps1` sets. Load-bearing, not stylistic: if `common.ps1`
  fails to load, its own preference never takes effect and each undefined helper is
  a non-terminating `CommandNotFound`. Reproduced 2026-08-03 (pwsh 7.4.6, Intel
  macOS) against the real files with #102's defect reinstated: rc=0 without the
  guard, rc=1 with it. Enforced by `scripts/validate-examples.ts`.
- **A failure path must exit non-zero.** In Python `raise SystemExit(msg)`, never a
  bare `return` past a trailing `sys.exit(rc)`. Same run: rc=0 before, rc=1 after.

`lint-powershell.yml` parses every `.ps1` with PowerShell's own parser before
PSScriptAnalyzer, because a `Severity = @('Error','Warning')` filter does not
surface `ParserError` — a file that cannot be parsed at all passed that gate.

## A failing example is a quickchr bug until proven otherwise

Examples are **canaries**, not chores. The reason each one boots a real CHR is to catch
what focused unit/integration tests miss — runtime behavior, platform quirks, the whole
stack. So when one fails, the working assumption is **quickchr has a bug**, not "the
example is wrong for this platform."

- **Never `skip`, `os`-gate, or `arch`-gate a failing example as the first move.** A gate
  deletes the signal *permanently and silently* — worse than the timeout-bump
  `testing.instructions.md` already forbids, because a skipped canary never sings again.
  Gating is a *last* resort, applied only AFTER the behavior is reproduced locally and
  root-caused, and the gate must cite that grounding (a repro, not a guess).
- **Reproduce locally before concluding anything.** One red CI job is a signal, not a
  fact. We build this tool and run QEMU locally — including arm64 CHR under TCG on Intel
  (slow, but real). A claim like "snapshots don't work on arm64" must be *demonstrated*
  with a local run, never inferred from a CI matrix plus remembered "known QEMU behavior."
- **Don't write an unproven cause anywhere durable.** Until reproduced, a suspected
  limitation does not go into `DESIGN.md`, API docs, a scoped instruction/doc, an issue
  stated as fact, or — worst of all — a shared `routeros-*` SKILL. A plausible mechanism recorded
  as truth is how one bad guess contaminates every project downstream.
