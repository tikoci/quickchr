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
| `<name>.ps1` | PowerShell CLI mirror, dot-sources `../common.ps1`. | **all new** examples; existing where the CLI flow is simple |
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
  long sleeps, or fragile parsing, log it in the README's "friction found" + BACKLOG
  — decide whether quickchr should grow a better surface (don't paper over it).
- **CI:** `bun run check` runs biome, `tsc --noEmit`, markdownlint, cspell,
  `scripts/validate-examples.ts`, and shellcheck (`-s sh`). The smoke harness
  (`test/integration/examples-smoke.test.ts`) + PowerShell `Invoke-ScriptAnalyzer`
  run in extended verification, across the supported-OS matrix. `trial-license`
  is manual-only (rate limits).

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
  limitation does not go into `DESIGN.md`, API docs, `BACKLOG.md`, an issue stated as
  fact, or — worst of all — a shared `routeros-*` SKILL. A plausible mechanism recorded
  as truth is how one bad guess contaminates every project downstream.
