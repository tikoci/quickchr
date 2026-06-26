# `grounding` — apply config, read it back (the `bun:test` reference)

**Status:** ✓ CI-verified · ✓ cross-platform · maintainer-supported

**Validated against:** RouterOS 7.x (any).

The canonical quickchr loop: boot a disposable CHR, **apply** a config snippet
with `exec()`, **read it back** with `rest()`, and assert it took. This is how you
ground generated RouterOS config against real RouterOS instead of guessing —
exactly what an agent should do before trusting its own output.

## This is the one `bun:test` example — on purpose

Every other example is a runnable script you `bun run`, because the real-world
thing a consumer writes is a script that *does something*. This one is a
`bun:test` because here **the assertions are the documentation** — a regression
suite proving the apply→read-back contract holds. Reach for `bun:test` when
that's the point; otherwise write a runnable script. (An agent can wrap any
script in `test()` in seconds.)

It also doubles as the reference for the bun:test patterns other projects reuse
against a CHR: `beforeAll`/`afterAll` to share one booted instance, several
focused `test()` blocks, `test.skipIf(...)` for runtime-gated cases, and a spread
of `expect` matchers (`toContain`, `toBeArray`, `toMatchObject`, `toMatch`).

## Run it

```sh
# This example IS a test — run it with bun test (not bun run):
QUICKCHR_INTEGRATION=1 bun test examples/grounding/grounding.test.ts

# CLI mirror of the same apply→read-back loop:
sh grounding.sh
# Windows:
pwsh grounding.ps1
```

Expected time: ~25–40 s with KVM/HVF.

## If you copied only this directory

- Replace `../../src/index.ts` → `@tikoci/quickchr`.
- Copy `../lib.ts` (only `exampleMachineName` is used) or inline it.
- CLI scripts resolve quickchr via `$QUICKCHR`; set `QUICKCHR=quickchr` for an
  installed binary.

## Friction found

None. (`exec()` runs one statement per call — to read JSON back from RouterOS,
wrap with `:serialize to=json`, shown in the last test.)

## See also

- [`../quickstart/`](../quickstart/) — the read-only version (boot + query).
- [`../dude/`](../dude/) — grounding a package-gated subsystem.
- [`../COVERAGE.md`](../COVERAGE.md) — capability coverage.
