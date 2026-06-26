# `file-transfer` — copy a file to a CHR and back

**Status:** ✓ CI-verified · ✓ cross-platform · maintainer-supported

**Validated against:** RouterOS 7.x (any). Needs `scp` on the host.

`ChrInstance.upload()` / `download()` move files over SCP using the instance's
resolved credentials — so you don't hand-roll `scp` + auth. This example writes a
local file, uploads it, confirms it landed in `/file`, downloads it back, and
asserts the bytes match.

## Run it

```sh
# Library API — the upload/download round-trip:
bun run file-transfer.ts

# CLI — boots a CHR and shows the ssh port (no quickchr cp yet — see below):
sh file-transfer.sh
```

No `.ps1`: the CLI has no file-transfer command, so the PowerShell story would be
identical to the `.sh` gap note — not worth a separate file. Expected time: ~40–60 s.

## If you copied only this directory

- Replace `../../src/index.ts` → `@tikoci/quickchr`; copy `../lib.ts` or inline.
- `upload()`/`download()` need `scp` on the host and a machine started with
  `secureLogin: true` (a real password to authenticate).

## Friction found

**No `quickchr cp` CLI.** File transfer is library-only — there's no
`quickchr cp <name> <src> <dst>` command, so the CLI/Python drivers can't do a
clean round-trip (they'd fall back to raw `scp`, which we won't normalize). Tracked
as a CLI-surface gap in [`../../BACKLOG.md`](../../BACKLOG.md) ("`quickchr cp`").
The same gap shows up in [`../version-matrix/`](../version-matrix/), whose CLI
driver can't upload the sample config.

## See also

- [`../COVERAGE.md`](../COVERAGE.md) — capability coverage.
- [`../dude/`](../dude/) — `installPackage()` also uses upload under the hood.
