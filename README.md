# ci-data — quickchr CI metrics (orphan branch)

Append-only CHR timing and test-outcome data collected by CI (issue #30).
Written exclusively by the `aggregate` job in `.github/workflows/integration.yml`
when a caller passes `collect-metrics: true` (main.yml pushes, sweep.yml,
ros-versions dispatches). Never edited by hand; history is never rewritten.

## Layout

- `runs/<run_id>-<platform>.ndjson` — one file per integration job (per-run
  filenames avoid push conflicts). Records:
  - `{"kind":"boot", ts, run_id, sha, platform, host, name, version, arch, accel, boot_ms}`
    — one per successful CHR boot (from the library's boot-history log)
  - `{"kind":"test-file", ts, run_id, sha, platform, host, file, duration_s, status}`
    — one per integration test file (from the workflow's sequential loop)
  - `{"kind":"suite", ts, run_id, sha, platform, host, scope, conclusion, target, files, failed}`
    — one per job; `scope` is `full` (no test-filter, no TCG smoke default)
    or `filtered`
- `tested-versions.json` — rollup consumed by the ros-versions scheduler:
  `{ "<routeros-version>": { "<platform>": { run_id, date, conclusion } } }`.
  Only `scope=full` suite runs fold in; version keys come from the actually
  booted RouterOS version (boot records), not the requested channel alias.
  A `fail` conclusion is recorded (so the scheduler re-flags the version) and
  is superseded by any newer run.

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
