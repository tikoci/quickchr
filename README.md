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

Schema owner: `scripts/ci-metrics.ts` on `main` — keep this README in sync.

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

# Local analysis: clone just this branch and import into SQLite
git clone --branch ci-data --single-branch https://github.com/tikoci/quickchr /tmp/ci-data
cat /tmp/ci-data/runs/*.ndjson | bun -e '…'   # or sqlite-utils insert
```
