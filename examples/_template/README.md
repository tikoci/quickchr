# `<name>` — <one-line outcome, e.g. "do X against a real CHR">

**Status:** ✓ CI-verified · ✓ cross-platform · maintainer-supported
<!-- or, for special-purpose examples: -->
<!-- **Status:** Manual only · requires <prerequisite> · not run in CI -->

**Validated against:** RouterOS 7.22+ <!-- or "requires <feature> added in 7.xx" -->

<!--
This is the canonical example template. Copy this directory, rename the files to
your `<name>`, and fill in each section. Every example follows the same shape so
it reads as a copy-and-run artifact, not a test fixture. See
../README.md and ../../.github/instructions/examples.instructions.md for the rules.
-->

## What it does

<2–4 sentences. The real-world scenario, slightly contrived to stay clear. Name
the one quickchr capability it grounds.>

## Run it

```sh
# Library API (the source of truth) — runnable Bun script:
bun run <name>.ts

# CLI (the commands a human/agent types):
sh <name>.sh
# Windows:
pwsh <name>.ps1

# Python CLI driver (where present):
uv run <name>.py
```

Expected time: ~N s with KVM/HVF; minutes under TCG.

## If you copied only this directory

These examples import quickchr from the repo (`../../src/index.ts`) and shared
helpers from `../lib.ts`. As an external consumer:

- Replace `../../src/index.ts` → `@tikoci/quickchr` (`bun add @tikoci/quickchr`).
- Copy `../lib.ts` alongside, or inline the few helpers you use (`runExample`,
  `exampleMachineName`, `freePort`).
- CLI scripts resolve quickchr via `$QUICKCHR` (default: the repo source CLI);
  set `QUICKCHR=quickchr` to use an installed binary.

## Friction found

<During implementation, note anything that needed raw curl/scp/ssh, direct
`machine.json` reads, long sleeps, fragile parsing, or lots of glue — and whether
quickchr should grow a better API/CLI surface. Link the GitHub issue.
"None" is a valid answer.>

## See also

- `../COVERAGE.md` — which capability each example grounds.
- `<relevant docs/skill links>`
