# B7 (#76) — local HVF full-suite resource trend

**Run:** `b7-hvf-baseline`, 2026-07-31T04:05:52Z → 04:36:16Z, SHA `21ac47f`.
**Host:** Darwin 25.5.0 x86_64, 8 physical / 16 logical cores, 64 GiB, QEMU 11.0.3,
x86_64 guest under **HVF** (the CI-matching accelerator for `macos-x86`).
**Target:** `stable` (default). **Result: 12/12 files pass, 1818 s test time (30.3 min), 30.4 min wall.**

## The question

Issue #110's Grounding section estimated a `macos-x86` full suite at 27–32 minutes by
naive scaling from a single filtered file, against an observed death boundary of
59–65 minutes. That left roughly 30 minutes unaccounted for, and two candidate
explanations:

1. per-file cost **inflates as the suite progresses** (cumulative leakage), or
2. per-file cost is flat and something else consumes the time.

B7's job is to distinguish these on the one machine that can run the CI-matching
HVF baseline locally.

## Answer: cost is flat — there is no cumulative inflation

Raw local durations cannot show this directly — the 12 files differ intrinsically
(`provisioning` ~500 s vs `license` ~38 s in CI). The comparable quantity is each
file's local duration as a **ratio** against the same file on `windows-x86`, the
slowest CI platform that actually *completes* its job (run `30507484030`, `stable`).

Against windows-x86, over the 10 files carrying timing signal:

| | median | range | slope vs position |
|---|--:|--:|--:|
| raw | 0.78× | 0.68×–1.98× | **+0.026× per file** |
| VM-only (download excluded) | 0.72× | 0.66×–0.94× | **+0.002× per file** |

A slope of +0.002× per file is zero for practical purposes: the twelfth file is no
more expensive, relative to its own CI cost, than the first. **Hypothesis 1 is not
supported.** The entire raw slope comes from one file, and that file's excess is
not compute — see below.

## Answer: no resource accumulates across files either

343 samples at 5 s. On macOS, `free` alone is misleading, because pages move
free → inactive as file cache grows without being consumed; `free+inactive` is the
honest reclaimable figure, and `wired+compressed` is what actually grows on a leak.

| metric | first | last | net over 30 min |
|---|--:|--:|--:|
| free | 16778 MB | 14839 MB | −1939 MB |
| **free + inactive (reclaimable)** | 32992 MB | 32798 MB | **−194 MB** |
| **wired + compressed (held)** | 8642 MB | 8558 MB | **−84 MB** |
| swap used | 1671 MB | 1639 MB | −32 MB |

- **Memory pressure stayed at level 1 (normal) for all 343 samples.** Never warn, never critical.
- **Swap went down**, not up.
- **Zero QEMU orphans.** Peak concurrency never exceeded 1 for any file, and the
  settled post-suite sample shows 0 `qemu-system` processes. Peak QEMU RSS 691 MB.

The only metric with a real downward slope is bare `free` (−77 MB/min), and
`free+inactive` shows that is reclassification, not consumption.

## The one file that looked like inflation was a cold download

`provisioning.test.ts` took **992 s locally against 502 s on windows-x86 (1.98×)** —
the single outlier in an otherwise 0.66×–0.94× field, and it sits at position 10 of
12, exactly where a cumulative-leakage story would want it.

It is not leakage. Of its 992 s, **619 s (62%) elapsed with zero QEMU processes
running** — the file was waiting on the network, not exercising a VM:

```text
Downloading CHR 7.20.7 (x86)...
  Download failed (attempt 1/3), retrying in 2s...
  Download failed (attempt 2/3), retrying in 4s...
Downloading CHR 7.20.8 (x86)...
  Download failed (attempt 1/3), retrying in 2s...
  Download failed (attempt 2/3), retrying in 4s...
```

The version-pinned tests (7.20.7 / 7.20.8) were not in the local image cache. Both
images needed two retries before succeeding; the backoff itself is only 6 s, so the
bulk is transfer plus abandoned partial attempts. Subtracting the no-VM time leaves
**373 s of actual VM work — 0.74× windows-x86**, back in line with every other file.

This is a **locally measured demonstration of the #104/B3 confound**: an
uncontrolled cold download inflated one file by 2.7× and was, by itself, the whole
of the apparent position-vs-cost trend. It is direct support for B3 landing before
B11 collects timing samples — with cold download uncontrolled, B11's data set would
carry variance of this size and attribute it to whatever varied on purpose.

## What this rules out, and what it does not

Stated deliberately narrowly, per B7's own instructions.

**Ruled out:** a *deterministic local Intel/HVF full-suite defect*. The suite runs
to completion in 30.4 minutes with flat per-file cost, no memory accumulation, no
process leak, and normal memory pressure throughout.

**Not ruled out:**

- a hosted-runner-specific limit, or a resource interaction only the runner
  environment produces. That distinction is B8's job and this run does not touch it.
- **hardware asymmetry.** This laptop has 8 physical cores and 64 GiB. The hosted
  `macos-15-intel` runner does not, and the gap is not characterized here. A
  measurement showing "no pressure at 64 GiB" says nothing about pressure at the
  runner's memory size — do not carry the pressure result across.
- the ~30-minute gap on the runner itself. This run *confirms the 27–32 min
  estimate* (30.4 measured) for the suite's cost, which sharpens the gap rather
  than closing it: on CI the same work still has ~30 minutes unaccounted for.

## Measurement caveats

- **`disk_free_mb` rose ~45 GB during the run.** That is APFS purgeable-space
  reclamation settling after pre-run cleanup, not something the suite did. Disk
  free is not a usable signal in this run; the per-file deltas are noise around it.
- **Per-file "QEMU at exit" is unreliable in this run.** The sampler's marker only
  advanced when the *next* file started, so a file's last attributed sample was
  taken while its own QEMU was legitimately still up. Orphan detection therefore
  uses **peak concurrency > 1** instead, which has no such blind spot because the
  suite boots one CHR at a time. `run.sh` has since been fixed to park the marker
  in an explicit `(after <file>)` gap and hold for a tick, so future runs get a
  true post-file reading; this run predates that fix.
- **Background load was not zero.** Two MCP server processes were spinning at ~90%
  CPU each and were killed before the run; the desktop session (WindowServer, VS
  Code) remained. Median per-file load ranged 3.4–12.9. This is a level offset, not
  a trend confound.
- **One host, one run, one target.** Everything here is `stable` on one machine.

## Bearing on #76

The suite's own cost is not the explanation for the `macos-x86` runner loss. It
completes in 30.4 minutes of flat, non-accumulating work on Intel/HVF, which is
consistent with the naive 27–32 minute estimate and inconsistent with a story where
later files get progressively more expensive. Whatever consumes the runner's
additional 30 minutes before it stops answering is still unaccounted for, and B8's
bounded file-group experiment — plus B4/B5's watchdog and ledger, so an incomplete
leg leaves a record — remains the path to it.
