---
name: quickchr-maintainer
description: "Maintain the quickchr Bun/TypeScript CLI and library. Use when changing src, tests, examples, CI, docs, QEMU/CHR behavior, RouterOS REST/provisioning logic, or release/package metadata in this repo."
---

# quickchr Maintainer Workflow

## Start

1. Read `AGENTS.md` and `.github/copilot-instructions.md`.
2. Read only the matching `.github/instructions/*.md` files for the files or
   behavior being changed.
3. For QEMU, CHR, RouterOS REST, provisioning, networking, or test behavior,
   prefer repo evidence over external memory. This project is the reference
   implementation for quickchr behavior.

## Source Routing

- Source/library code: `.github/instructions/general.instructions.md`.
- QEMU launch, channels, platform detection: `qemu.instructions.md`.
- Provisioning and first boot: `provisioning.instructions.md`.
- RouterOS REST and blocking endpoints: `routeros-rest.instructions.md`.
- Bun HTTP/fetch behavior: `bun-http.instructions.md`.
- Tests and live CHR requirements: `testing.instructions.md`.
- Examples: `examples.instructions.md`.
- GitHub Actions and CI diagnosis: `ci.instructions.md`.

Use rosetta MCP for RouterOS documentation search and command/property lookup
when available. Use live quickchr/CHR experiments for behavior that must be
grounded in RouterOS runtime behavior.

## Verification

Choose the narrowest checks that cover the change:

```sh
bun run check
bun test test/unit/
QUICKCHR_INTEGRATION=1 bun test test/integration/<file>.test.ts
```

Run integration tests for any change that interacts with RouterOS, QEMU monitor,
serial, QGA, provisioning, packages, device-mode, license, networking, or
machine lifecycle. Always clean up CHR instances in `finally` blocks.

## Done Criteria

- Code follows Bun/ESM/library-layer rules.
- Relevant unit, integration, smoke, or lint checks have been run or explicitly
  reported as not run.
- Significant behavior changes are reflected in `DESIGN.md`, `BACKLOG.md`,
  `MANUAL.md`, examples, and/or shared RouterOS skills as appropriate.
- Failing tests are investigated before changing timeouts, skips, or platform
  gates.
