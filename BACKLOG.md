# quickchr — work map

This file is a **map**, not a work log. Open work is tracked in
**[GitHub Issues](https://github.com/tikoci/quickchr/issues)**; see
[CONTRIBUTING.md "Tracking work"](./CONTRIBUTING.md#tracking-work) for the full scheme
and the label legend (`area:*`, `P1`–`P4`, `research`, `needs-decision`).

## Where things live

| Content | Home |
|---------|------|
| Open, actionable work | GitHub Issues |
| Design decisions & rationale | [DESIGN.md](./DESIGN.md) |
| Grounded RouterOS/QEMU behaviour facts | narrowest `.github/instructions/*.md`, else `docs/`, else `test/lab/<topic>/REPORT.md` |
| Shipped, user-facing changes | [CHANGELOG.md](./CHANGELOG.md) |
| Narrative history (incl. the old 674-line backlog) | git history — `git log -p -- BACKLOG.md` |

**One home per thing.** Don't mirror an open issue in a doc, or a doc's fact in an issue.
This file names no per-issue list to maintain — browse the live one below so nothing rots.

## Browse open work

The 674-line backlog was triaged into GitHub Issues (#37). Browse by facet — these links
stay correct as issues open and close:

- **By area** —
  [cli](https://github.com/tikoci/quickchr/labels/area%3Acli) ·
  [networking](https://github.com/tikoci/quickchr/labels/area%3Anetworking) ·
  [qemu](https://github.com/tikoci/quickchr/labels/area%3Aqemu) ·
  [rest](https://github.com/tikoci/quickchr/labels/area%3Arest) ·
  [wizard](https://github.com/tikoci/quickchr/labels/area%3Awizard) ·
  [provisioning](https://github.com/tikoci/quickchr/labels/area%3Aprovisioning) ·
  [library-api](https://github.com/tikoci/quickchr/labels/area%3Alibrary-api) ·
  [examples](https://github.com/tikoci/quickchr/labels/area%3Aexamples) ·
  [ci](https://github.com/tikoci/quickchr/labels/area%3Aci) ·
  [docs](https://github.com/tikoci/quickchr/labels/area%3Adocs)
- **By priority** —
  [P1](https://github.com/tikoci/quickchr/labels/P1) ·
  [P2](https://github.com/tikoci/quickchr/labels/P2) ·
  [P3](https://github.com/tikoci/quickchr/labels/P3) ·
  [P4](https://github.com/tikoci/quickchr/labels/P4)
- **By type** —
  [research](https://github.com/tikoci/quickchr/labels/research) (produces a `REPORT.md`) ·
  [needs-decision](https://github.com/tikoci/quickchr/labels/needs-decision) (maintainer call first)

## Anchors worth naming

A few issues are referenced from code, docs, or instructions as **grounding anchors** —
an agent hitting the symptom should fetch the issue before concluding anything:

- **[#39](https://github.com/tikoci/quickchr/issues/39) — optional centrs passthrough for
  `exec`** (`needs-decision`). Anchors the "centrs already owns this" cluster: `exec()`
  soft-error detection, protocol-adapter reuse, and bidirectional MAC-Telnet are tracked
  as checklist items **there**, not as separate quickchr issues, because they're more
  involved than QEMU-focused quickchr and drove centrs' design.
- **[#40](https://github.com/tikoci/quickchr/issues/40) — Windows support (umbrella)**.
  Carries the grounded findings (TCG suite green; `scp` without `sshpass`) + the open
  gaps. Read it before claiming "X doesn't work on Windows".
- **Decisions owed** (direction is the maintainer's; rationale in
  [DESIGN.md](./DESIGN.md)): [#56](https://github.com/tikoci/quickchr/issues/56)
  port-base randomness · [#57](https://github.com/tikoci/quickchr/issues/57) fixed
  service-block redesign · [#58](https://github.com/tikoci/quickchr/issues/58) config
  schema split.

## Deferred

Not rejected — revisit when prerequisites land or the need sharpens (rejected items are in
DESIGN.md "Out of Scope"): MCP server · TUI mode · `.rsc`/`.backup` config import ·
auto-update check · saved credential profiles · wizard snapshot/machine search (lists > 16).
