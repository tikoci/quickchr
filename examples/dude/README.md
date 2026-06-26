# `dude` — install a RouterOS package and ground its config

**Status:** ✓ CI-verified · ✓ cross-platform (x86 **and** arm64) · maintainer-supported

**Validated against:** RouterOS 7.21.1–7.23.1 (dude package present on both arches).

A richer grounding loop than [`grounding`](../grounding/): install the optional
`dude` server package, enable The Dude, and read the setting back. Demonstrates
that a package-gated subsystem (`/dude`) only exists once its package is present —
and how quickchr downloads, uploads, and activates a package for you.

## x86 *and* arm64 (corrected)

Earlier docs claimed dude was x86-only. That's wrong: MikroTik ships
`dude-<ver>-arm64.npk` alongside the x86 build (verified 7.21.1–7.23.1), and
quickchr's package resolver (`src/lib/packages.ts` `findPackageFile`) picks the
arch-correct file. `arch` is omitted here, so it follows the host.

## Run it

```sh
# Library API — uses ChrInstance.installPackage() (post-boot install + reboot):
bun run dude.ts

# CLI — installs at first boot via --add-package:
sh dude.sh
# Windows:
pwsh dude.ps1

# Python CLI driver (stdlib only; uv preferred over a venv):
uv run dude.py
```

Expected time: ~50–90 s (the install downloads the package and reboots once).

## If you copied only this directory

- Replace `../../src/index.ts` → `@tikoci/quickchr`; copy `../lib.ts` or inline
  `runExample`/`exampleMachineName`/`check`.
- CLI/Python scripts resolve quickchr via `$QUICKCHR` (default: repo source CLI).

## Friction found

The **library** can install a package on a *running* machine
(`ChrInstance.installPackage("dude")`), but the **CLI** can only install at first
boot (`--add-package`) — there's no `quickchr install <name> <pkg>` for a running
instance. That's why `dude.ts` and `dude.sh` take slightly different paths to the
same end state. Tracked as a CLI-surface gap (`quickchr install`/`pkg add`) — see
[`../../BACKLOG.md`](../../BACKLOG.md).

## See also

- [`../grounding/`](../grounding/) — the base apply→read-back loop.
- [`../COVERAGE.md`](../COVERAGE.md) — capability coverage.
