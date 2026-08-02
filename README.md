# ci-data — quickchr CI metrics (orphan branch)

Append-only CHR timing and test-outcome data collected by CI (issue #30).
Written exclusively by the `aggregate` job in `.github/workflows/integration.yml`
when a caller passes `collect-metrics: true` (main.yml pushes, sweep.yml,
ros-versions dispatches). Never edited by hand; history is never rewritten.

## Layout

- `runs/<run_id>-<platform>-<target>.ndjson` — one file per integration job
  (per-run filenames avoid push conflicts; files from before 2026-07-05 lack
  the `-<target>` suffix). Records:
  - `{"kind":"boot", ts, run_id, sha, platform, host, name, version, arch, accel, boot_ms}`
    — one per successful CHR boot (from the library's boot-history log)
  - `{"kind":"test-file", ts, run_id, sha, platform, host, file, duration_s, status}`
    — one per integration test file (from the workflow's sequential loop)
  - `{"kind":"suite", ts, run_id, sha, platform, host, scope, conclusion, target, files, failed}`
    — one per job; `scope` is `full` (no test-filter, no `tcg-smoke`)
    or `filtered`
- `tested-versions.json` — rollup consumed by the ros-versions scheduler:
  `{ "<routeros-version>": { "<platform>": { run_id, date, conclusion } } }`.
  Only `scope=full` suite runs fold in, and each run marks exactly ONE
  version: its target's resolution — a version-shaped target is itself; a
  channel alias (stable/testing/…) resolves to the run's modal boot version.
  Versions booted incidentally (upgrade / pinned-channel tests) are never
  credited — a phantom credit would suppress the scheduler for a version no
  full suite ever targeted. A `fail` conclusion is recorded (so the scheduler
  re-flags the version) and is superseded by any newer run. The per-run files
  are the source of truth; rebuild this rollup any time with
  `bun scripts/ci-metrics.ts refold --data <ci-data-checkout>`.
- `attempted-legs.json` — planned-vs-completed ledger, keyed by run id
  (issue #77). `runs/` only ever contains legs that *finished*; before this
  file, a leg whose runner vanished left no marker anywhere and a reader
  comparing platforms could not tell "never attempted" from "attempted and
  died". The 2026-07-31 sweep [30665449265](https://github.com/tikoci/quickchr/actions/runs/30665449265)
  planned 15 legs and wrote 12 ndjson files; the three missing `macos-x86`
  legs are the case this exists for.

  ```json
  { "<run_id>": {
      "ts": "…", "sha": "…", "event": "push", "attempt": "1",
      "planned": 15, "complete": 12,
      "incomplete": { "<platform>|<target>": { "terminal": …, … } } } }
  ```

  `incomplete` is **absent entirely** when every planned leg completed — so
  its presence is itself the signal. Each entry carries a `terminal`:

  - `complete` — reached `runs/`. Never appears in `incomplete`.
  - `runner-lost` — the job reached a terminal state with its test step still
    `in_progress`. The runner stopped reporting; no artifact, no log.
  - `attempted-incomplete` — the leg ran and died without leaving a record,
    but not by runner loss.
  - `not-started` — died before the test step (setup, install, checkout).
    Kept distinct so a setup failure cannot masquerade as a lost runner and
    send #76 chasing a mechanism that was never involved.

  **The artifact outranks the instrument.** A leg is `complete` because it
  produced a metrics record in `runs/`, never because a check run says so.
  The per-leg checkpoint is best-effort (it warns and exits 0 on any API
  failure, so a fork PR's read-only token cannot red a leg), so trusting it
  first would let instrument failure fabricate a `runner-lost` for a leg that
  finished cleanly.

  **Read `last_checkpoint_ts`, not `job_elapsed_s`.** GitHub takes tens of
  minutes to decide a runner is gone — measured at **~44.6 min** on
  [30750979859](https://github.com/tikoci/quickchr/actions/runs/30750979859),
  a deliberate `halt -f` on `ubuntu-latest`. So `job_elapsed_s` (derived from
  `completed_at`) is an *upper bound* that overstated the wedge by ~16× in
  that run, while `last_checkpoint_ts` landed within two seconds of it. Do
  not carry the 44.6 min figure across platforms or loss modes — one clean
  halt on one runner OS. What it establishes is the order of magnitude:
  reading `completed_at` as the wedge time is wrong by a lot.

  `job_matched: false` means the ledger could not join the leg to its job.
  The jobs API exposes no matrix values, so the join goes through the display
  name; if `integration.yml`'s `name:` is edited without `integrationJobName()`,
  every entry degrades to `false` and the step/timing fields go missing.

  Incomplete legs are **deliberately not** written to `tested-versions.json`:
  the version scheduler reads that file as a presence test, so an aborted run
  recorded there would look tested and silently stop being rescheduled.

Schema owners on `main` — keep this README in sync: `scripts/ci-metrics.ts`
(`runs/`, `tested-versions.json`), `scripts/ci-leg-ledger.ts`
(`attempted-legs.json`).

## Query recipes

```bash
# Boot timing across all runs, as TSV: version arch accel boot_ms
gh api repos/tikoci/quickchr/contents/runs --ref ci-data --jq '.[].name' \
  | while read -r f; do gh api "repos/tikoci/quickchr/contents/runs/$f" --ref ci-data \
      -H "Accept: application/vnd.github.raw"; done \
  | jq -r 'select(.kind=="boot") | [.version,.arch,.accel,.boot_ms] | @tsv'

# Which RouterOS versions have a full-suite pass?
gh api repos/tikoci/quickchr/contents/tested-versions.json --ref ci-data \
  -H "Accept: application/vnd.github.raw" | jq .

# Every leg that died without leaving a record, newest run first
gh api repos/tikoci/quickchr/contents/attempted-legs.json --ref ci-data \
  -H "Accept: application/vnd.github.raw" \
  | jq -r 'to_entries | sort_by(.key) | reverse | .[]
           | .key as $run | (.value.incomplete // {}) | to_entries[]
           | [$run, .key, .value.terminal, .value.last_file // "-",
              .value.last_checkpoint_ts // "-"] | @tsv'

# Local analysis: clone just this branch and import into SQLite
git clone --branch ci-data --single-branch https://github.com/tikoci/quickchr /tmp/ci-data
cat /tmp/ci-data/runs/*.ndjson | bun -e '…'   # or sqlite-utils insert
```
