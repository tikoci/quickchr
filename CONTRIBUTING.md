# Contributing to quickchr

> User-facing reference: **[MANUAL.md](./MANUAL.md)**.
> Architecture: **[DESIGN.md](./DESIGN.md)**.
> Agent-facing rules: **`.github/instructions/*.md`**.

## Tracking work

Work is tracked in **[GitHub Issues](https://github.com/tikoci/quickchr/issues)**, not in a
flat log. Each kind of content has exactly one home:

| Content | Home |
|---------|------|
| Open, actionable work | [GitHub Issues](https://github.com/tikoci/quickchr/issues) |
| Design decisions & rationale | [DESIGN.md](./DESIGN.md) |
| Grounded RouterOS/QEMU behaviour facts | the narrowest `.github/instructions/*.md` (by `applyTo`), else `docs/`, else `test/lab/<topic>/REPORT.md` |
| Shipped, user-facing changes | [CHANGELOG.md](./CHANGELOG.md) |
| Narrative history | git history |

The rule is **one home per thing** — do not mirror an open issue inside a doc, or a doc's fact
inside an issue. [BACKLOG.md](./BACKLOG.md) is a thin **map** of this scheme — browse-by-label
links to the live issues plus a few named grounding anchors — not a per-issue mirror and not a
work log.

New non-trivial work becomes an issue (templates: **Task**, **Research**, **Needs-decision**).
Every issue states a **Done-when** so the finish line is explicit. Label each with:

- an **area** — `area:qemu`, `area:networking`, `area:cli`, `area:wizard`, `area:provisioning`,
  `area:rest`, `area:library-api`, `area:examples`, `area:ci`, `area:docs`;
- a **priority** — `P1` (take next) … `P4` (polish);
- a **type** — `bug` / `enhancement` / `documentation`, plus `research` (produces a
  repro/`REPORT.md`, not shipped code) or `needs-decision` (changes a persisted-state / port /
  public-API contract — the maintainer decides direction before work starts).

Open a Pull Request against a filed issue for review (PRs are wired to automated review).

## Development Setup

### Prerequisites

- [Bun](https://bun.sh) >= 1.1
- [QEMU](https://www.qemu.org) (for integration tests)
- [Biome](https://biomejs.dev) (installed as a dev dependency)

```bash
git clone https://github.com/tikoci/quickchr
cd quickchr
bun install
```

### Running the CLI from Source

```bash
bun run dev -- <command>      # e.g. bun run dev -- doctor
bun run dev -- start --dry-run --channel stable
```

### Tests

```bash
# Fast unit tests — no QEMU needed
bun test test/unit/

# All tests with coverage
bun test test/unit/ --coverage

# Integration tests — requires QEMU installed
QUICKCHR_INTEGRATION=1 bun test test/integration/
```

**Run integration tests before every commit or PR.** Unit tests cannot catch boot-sequence issues, REST timing races, or port mapping problems. See `.github/instructions/testing.instructions.md` for the full policy.

### Linting and Type Checking

```bash
bun run check           # Biome + tsc --noEmit + markdownlint
bun run lint:biome      # Biome only
bun run lint:typecheck  # tsc --noEmit only
```

### Project Structure

```text
src/lib/    Pure library — no CLI deps, no process.exit()
src/cli/    CLI layer — thin wrapper over src/lib/
src/index.ts  Public barrel export for npm consumers
test/unit/  Fast, pure tests — no network, no QEMU
test/integration/  Needs QEMU, guarded by QUICKCHR_INTEGRATION=1
examples/   Self-contained runnable usage examples (scripts; grounding/ is a bun:test)
```

### Key Rules

- **Bun, not Node.js** — use `Bun.spawn()`, `Bun.write()`, `Bun.sleep()`, not Node equivalents.
- **CHR REST calls** must go through `src/lib/rest.ts` (node:http + agent:false). Do not use `fetch()` for CHR REST.
- **External URLs** (download servers, version checks) use `fetch()` directly.
- **Errors** — throw `QuickCHRError(code, message)` from library code. CLI layer catches and formats.
- Tabs for indentation. Biome 2.x lint only (no auto-formatter).
- See `.github/instructions/` for domain-specific rules (QEMU, RouterOS REST, provisioning, Bun HTTP bugs).

### Architecture Notes

See [DESIGN.md](DESIGN.md) for the full architectural description, design decisions, and implementation notes.
