# quickchr

Project instructions live in Copilot's scheme, not here. Claude Code: read these at the start of a task — this file is only a pointer.

## Read these (do not duplicate their content here)

- `.github/copilot-instructions.md` — project overview, runtime, architecture, key types, QEMU rules.
- `.github/instructions/*.md` — scoped rules with `applyTo` globs:
  - `general.instructions.md` (`src/**`) — layer rules, error codes, port layout, RouterOS "expired admin" caveat.
  - `qemu.instructions.md` — QEMU/channels/platform specifics.
  - `provisioning.instructions.md` — first-boot provisioning.
  - `routeros-rest.instructions.md` — REST client behavior.
  - `bun-http.instructions.md` — Bun HTTP usage.
  - `testing.instructions.md` — `bun:test`, unit vs integration (`QUICKCHR_INTEGRATION=1`).
  - `ci.instructions.md` — CI workflows.
- `DESIGN.md` — design decisions and discovered constraints.
- `CONTRIBUTING.md` "Tracking work" — how work is tracked (Issues, not a flat log).
- `BACKLOG.md` — a thin **map** of that scheme plus items not yet filed; not a work log. Open work lives in GitHub Issues; record durable facts in the scoped doc that governs the area, not in agent memory (Copilot can't see Claude memory).
- `MANUAL.md`, `README.md` — user-facing usage.

## Paired skills

Paired-skill routing lives in `.github/copilot-instructions.md`. Keep this file
as a pointer; do not duplicate skill ownership rules here.

## End-of-session review

After significant work, run the issue-centric checklist in `general.instructions.md` (End-of-Session Review): close/open the GitHub issue, record durable knowledge in `DESIGN.md` or the scoped doc, and add a `CHANGELOG.md` entry if user-facing.
