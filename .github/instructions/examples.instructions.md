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
