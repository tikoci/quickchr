# `version-matrix` — boot every RouterOS channel in parallel and compare

**Status:** ✓ CI-verified (LITE) · ✓ cross-platform · maintainer-supported

**Validated against:** RouterOS 7.20.8+ (package provisioning). Native arch + HVF/KVM
recommended; TCG is slow — use `--lite`/`VERSION_MATRIX_LITE=1` on x86 CI.

Boots one CHR per RouterOS channel (long-term / stable / testing / development)
**in parallel**, installs an extra package on each, prints a version + package
matrix, and diffs each router's `:export` to surface config drift across versions.
The shape `tikoci/restraml` uses to extract a full per-version schema.
*(Formerly `matrica`.)*

## Run it

```sh
# Library API — parallel boot + version/package matrix + export diff + upload():
bun run version-matrix.ts
VERSION_MATRIX_LITE=1 bun run version-matrix.ts      # 2-channel CI variant

# Python CLI driver (uv preferred) — versions + export diff via the CLI:
uv run version-matrix.py [--lite] [--no-cleanup]

# CLI — the parallel-start slice (start per channel + list):
sh version-matrix.sh [--lite]
# Windows:
pwsh version-matrix.ps1 [-Lite]
```

`config/rb5009-arm64.rsc` is the sample config the library version uploads.
Expected time: ~90 s wall (HVF/KVM, parallel); minutes under TCG.

## If you copied only this directory

- Replace `../../src/index.ts` → `@tikoci/quickchr`; copy `../lib.ts` or inline.
- Keep `config/` alongside. CLI/Python resolve quickchr via `$QUICKCHR`.

## Friction found

- **No CLI file-transfer.** The library applies the sample config with
  `ChrInstance.upload()`, but the CLI/Python driver can't — there's no
  `quickchr cp` command. So `version-matrix.py` compares *default* exports only.
  Tracked as a CLI-surface gap (shared with [`../file-transfer/`](../file-transfer/)).
- **Old CLI package flag was wrong.** The previous Makefile/Python used
  `--packages a,b` (no such flag) so packages never installed via the CLI path;
  fixed here to repeated `--add-package`.

## See also

- [`../COVERAGE.md`](../COVERAGE.md) — capability coverage.
- [`../quickstart/`](../quickstart/) — the single-CHR version.
