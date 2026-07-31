# Full-suite resource trend (#76, B7 of #110)

Measures a **complete local integration suite** while sampling host resources, to
answer the question #110's Grounding section poses about `macos-x86`:

> does per-file cost **inflate as the suite progresses** (cumulative leakage), or
> stay flat?

This is not `bun test test/integration/`. `run.sh` reproduces the *shape* of the
CI leg — one `bun test` process per file, sequentially, in glob order, with the
same env knobs — because the shape is part of what is being measured. Running
the suite as a single process would rule out per-process growth by construction
and answer a question CI is not asking.

## Running

```sh
test/lab/full-suite-resource-trend/run.sh [outdir]
bun test/lab/full-suite-resource-trend/analyze.ts <outdir>
```

Default `outdir` is `~/.local/share/quickchr/b7-run-<timestamp>`. The run takes
roughly as long as a CI full-suite leg (tens of minutes) and boots real CHRs, so
give it a quiet machine — see "Baseline hygiene" below.

Artifacts in `outdir`:

| File | Contents |
|---|---|
| `host.txt` | host/QEMU/accel/CPU/memory, target, SHA, start+finish stamps |
| `timing.txt` | `<file> <seconds>s <status>` — same format `parseTimingFile()` reads |
| `output.txt` | concatenated `bun test` output, one `=== <file>` banner per file |
| `samples.ndjson` | one resource sample every 5 s, attributed to the running file |
| `current-file` | marker the sampler reads; `(startup)` → file → `(done)` |

## Baseline hygiene

The measurement is only worth what the baseline is worth. Before running, check
and record:

- **No unrelated CPU spinners.** A runaway process is a constant offset that a
  trend survives but an absolute comparison does not.
- **No stray `qemu-system` processes** (`pgrep -f qemu-system`) — an orphan from
  an earlier run is indistinguishable from a leak this run caused.
- **Disk headroom.** quickchr's preflight needs 10 GiB free
  (`QUICKCHR_MIN_FREE_BYTES`); the suite wants meaningfully more.
- **Keep the image cache.** Purging it forces cold downloads mid-run, which is
  the exact confound #104/B3 exists to remove.

## Reading the output

`analyze.ts` answers the two questions separately:

- **Question 2 (resource climb)** is answered by the monotonic-climb table
  directly — `compressed_mb`, `swap_used_mb`, and `qemu_procs` slopes across the
  whole run, plus per-file deltas. The orphaned-QEMU section is the sharpest
  single mechanism: a file that exits with QEMU still running has leaked a
  process into every subsequent file's environment.
- **Question 1 (position vs cost)** cannot be read off local durations, because
  the files differ intrinsically (`provisioning` ~500 s vs `license` ~38 s in
  CI). It is answered by the **ratio** of each local file to the same file on a
  CI platform that completes the suite. Flat ratio down the column ⇒ cost is
  position-independent. Rising ratio ⇒ real inflation.

The CI reference is run `30507484030` (`stable`), embedded in `analyze.ts` with
the `git show origin/ci-data:...` command that produced it. `examples-smoke` and
`library-api` self-skip in the integration job (0 s and 1 s on every platform),
so they carry no timing signal and are excluded from the ratio statistics.

## What a clean result does and does not prove

Stated in #110's B7 block, and worth repeating because it is the easiest thing
to overstate: a clean local completion rules out a **deterministic local
Intel/HVF full-suite defect**. It does *not* rule out a hosted-runner-specific
limit or a resource interaction that only the runner environment produces.
Report it as the former. Distinguishing the latter is B8's job.
