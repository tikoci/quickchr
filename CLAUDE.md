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
- `BACKLOG.md` — tracked work. Record actionable items here, not in agent memory (Copilot can't see Claude memory).
- `MANUAL.md`, `README.md` — user-facing usage.

## Paired skill

General CHR/QEMU knowledge is consolidated in the `routeros-qemu-chr` skill
(`tikoci/routeros-skills`). quickchr is its reference implementation — keep them aligned when QEMU behavior changes.

## End-of-session review

After significant work, check whether `DESIGN.md` and `BACKLOG.md` need updates (see `general.instructions.md` for the checklist).
