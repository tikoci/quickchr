# doctor-timing — where `quickchr doctor --json` spends its time (#269)

**Question:** `test/unit/cli-version-doctor.test.ts` spawns `quickchr doctor --json`
under bun:test's 5 s default, and Windows unit runs sometimes reached 4–5 s. Which part
is slow?

**Probe:** `probe.ts`, run by the `doctor-timing` job in `lab.yml` on windows-latest and
ubuntu-latest, set up like `ci.yml`'s unit-test jobs (no QEMU installed). 20 runs each of
the CLI spawn the test makes, `bun -e 0`, and `quickchr --help`, plus in-process
`QuickCHR.doctor()` with every `Bun.spawnSync` timed by command line.

## Before: `where.exe` per PATH lookup (run 45221318767, f8777f7)

| ms, p50 (max) | windows-latest | ubuntu-latest |
|---|---|---|
| CLI `doctor --json` | 765 (1500 cold) | 83 (97) |
| `bun -e 0` | 15 | 4 |
| CLI `--help` | 36 | 30 |
| in-process `doctor()` | 689 (700) | 17 (23) |
| spawn time per `doctor()` | ~688 | ~20 |

On Windows the time was almost all `where.exe`: ~75 ms per call (qemu-system-aarch64
70–88 ms, qemu-system-x86_64, qemu-img, socat), nine calls per `doctor()` (four of them
for `qemu-system-aarch64`, from `requireQemu`, `findEfiFirmware` and the platform probe).
The same lookups with `which` on Linux cost ~1 ms each.

## After: `Bun.which` in process (run 45225288560, 96d66cd)

| ms, p50 (max) | windows-latest |
|---|---|
| CLI `doctor --json` | 80 (189 cold) |
| `bun -e 0` | 14 |
| CLI `--help` | 31 |
| in-process `doctor()` | 20 (25) |

## Reading it

- The test's 5 s budget now has ~25× headroom on an idle runner (p50 80 ms, cold
  189 ms), against ~6× before (765 ms; the observed 4–5 s tail was ~6× the idle
  cost). The budget stays bun's default; no per-test timeout is needed.
- The tail itself (4–5 s) is not reproduced on an idle runner: 20 runs never exceeded
  1.5 s. Inferred: load from the rest of the unit suite multiplied a cost that was
  ~0.7 s to begin with. With nine spawns gone, the same multiplier lands far below 5 s.
- `findCommandOnPath()` serves every PATH lookup (`requireQemu`, `findQemuImg`,
  package-manager detection, `socat`), so every command that resolves a binary gets the
  same saving on Windows, not only `doctor`.
