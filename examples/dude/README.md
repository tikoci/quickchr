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

None open. The **library** installs a package on a *running* machine
(`ChrInstance.installPackage("dude")`), and the **CLI** now matches it with
`quickchr set <name> --package dude` (reboots to activate) — the gap this
section used to record closed with
[tikoci/quickchr#24](https://github.com/tikoci/quickchr/issues/24).
`dude.sh` and `dude.ps1` still install at first boot via `--add-package`, which
remains the cheaper path when the machine does not exist yet.

## See also

- [`../grounding/`](../grounding/) — the base apply→read-back loop.
- [`../COVERAGE.md`](../COVERAGE.md) — capability coverage.
