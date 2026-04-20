# Contributing to quickchr

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
examples/   Self-contained usage examples with their own tests
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
