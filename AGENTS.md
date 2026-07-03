# quickchr Agent Guide

This file is a router for Codex and other agents. Keep detailed project rules in
the existing Copilot instruction files; do not duplicate them here.

## Read First

- `.github/copilot-instructions.md` - project overview, runtime, architecture,
  key types, QEMU rules, and common commands.
- `.github/instructions/*.md` - scoped rules. Apply each file when its
  `applyTo` glob matches the files you are changing.
- `DESIGN.md` - design decisions and discovered constraints.
- `MANUAL.md` and `README.md` - user-facing behavior and examples.

## Where work is tracked

Open work lives in **GitHub Issues**, not in a flat file. See CONTRIBUTING.md
"Tracking work" for the full scheme: work -> Issues, decisions -> DESIGN.md,
grounded RouterOS/QEMU facts -> the narrowest `.github/instructions/*.md` (or
`docs/`, `test/lab/<topic>/REPORT.md`), shipped changes -> CHANGELOG.md, history
-> git. `BACKLOG.md` is a thin map of that scheme plus a short list of items not
yet filed as issues - it is not a work log. When you finish work, close/open the
issue and record any durable fact in the scoped doc that governs it; do not
re-grow BACKLOG.md.

## Project Defaults

- Bun is the runtime. Use `Bun.spawn()`, `Bun.write()`, `Bun.sleep()`,
  `bun:test`, and ESM imports with `.ts` extensions.
- `src/lib/` is pure library code. Do not import from `src/cli/` or call
  `process.exit()` there.
- Keep QEMU/CHR behavior grounded in this repo first. quickchr is the reference
  implementation for RouterOS CHR automation; skills and docs can lag.
- For RouterOS documentation lookup, use the project rosetta MCP server when it
  is available. Treat it as read-only grounding, not as a substitute for live CHR
  integration tests.
- Do not symlink shared RouterOS skills into this repository. User-level skill
  setup belongs outside the project.

## Codex Notes

- A repo-local Codex config lives at `.codex/config.toml`; keep it limited to
  project-safe settings and read-only tooling.
- Use the `quickchr-maintainer` skill for non-trivial changes to source, tests,
  examples, CI, or docs.
- Prefer focused local verification: `bun run check`, `bun test test/unit/`,
  and the smallest relevant `QUICKCHR_INTEGRATION=1 bun test ...` target.

## Review Guidelines

- Prioritize real behavioral bugs, leaked QEMU/CHR instances, missing cleanup,
  unsafe skips, and RouterOS/QEMU assumptions not backed by evidence.
- Treat CHR-interacting features as incomplete until covered by a passing live
  integration test.
- Do not turn a red integration test green by broadening timeouts, skipping,
  or platform-gating before reproducing and root-causing the failure.
- Check whether significant behavior changes need updates in `DESIGN.md`,
  `CHANGELOG.md`, `MANUAL.md`, examples, or the shared RouterOS skills — and
  whether a GitHub issue should be opened or closed.
