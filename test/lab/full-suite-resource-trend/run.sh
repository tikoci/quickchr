#!/bin/bash
# B7 (#76) — local full-suite run under the CI-matching HVF baseline, sampled.
#
# This is NOT `bun test test/integration/`. It reproduces the shape of the CI
# leg, because the shape is part of what is being measured:
#
#   * one `bun test` PROCESS PER FILE, sequentially, in glob order — the same
#     loop as `.github/workflows/integration.yml` "Run integration tests
#     (sequential per-file)". Running the suite as a single process would rule
#     out per-process heap growth by construction and answer a question CI is
#     not asking. What can still accumulate across files is OS-level: QEMU
#     orphans, disk, compressed memory, port/socket state.
#   * the same env knobs CI exports on every leg (integration.yml:351-362).
#   * the same `<file> <seconds>s <status>` timing format, so the output feeds
#     `parseTimingFile()` in scripts/ci-metrics.ts unchanged.
#
# Usage:  test/lab/full-suite-resource-trend/run.sh [outdir]
# Exits non-zero if any file failed, like the CI step.

set -eo pipefail

OUT="${1:-$HOME/.local/share/quickchr/b7-run-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$OUT"

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
cd "$REPO"

MARKER="$OUT/current-file"
: > "$OUT/output.txt"
: > "$OUT/timing.txt"
echo "(startup)" > "$MARKER"

# CI-matching leg environment (integration.yml:351-362). PRESERVE_ON_FAILURE is
# deliberately left unset, exactly as CI leaves it.
export QUICKCHR_INTEGRATION=1
export QUICKCHR_SERIAL_LOG=1
export QUICKCHR_DEEP_BOOT_DIAGNOSTICS=1

{
	echo "host:      $(uname -srm)"
	echo "qemu:      $(qemu-system-x86_64 --version | head -1)"
	echo "accel:     hvf (x86_64 guest on x86_64 host)"
	echo "cpus:      $(sysctl -n hw.physicalcpu) physical / $(sysctl -n hw.ncpu) logical"
	echo "memory:    $(( $(sysctl -n hw.memsize) / 1073741824 )) GiB"
	echo "target:    ${QUICKCHR_TEST_TARGET:-stable (default)}"
	echo "sha:       $(git rev-parse HEAD)"
	echo "started:   $(date -u +%FT%TZ)"
} | tee "$OUT/host.txt"

"$HERE/sample.sh" 5 "$MARKER" > "$OUT/samples.ndjson" &
SAMPLER=$!
# The sampler must outlive a failing file but never the script — an orphan would
# keep appending to a report that is already being read.
trap 'kill "$SAMPLER" 2>/dev/null || true' EXIT

fail=0
for f in test/integration/*.test.ts; do
	base=$(basename "$f")
	echo "$base" > "$MARKER"
	echo "=== $base  $(date -u +%FT%TZ)" | tee -a "$OUT/output.txt"
	t0=$(date +%s)
	status=pass
	if ! bun test "./$f" 2>&1 | tee -a "$OUT/output.txt"; then
		fail=1
		status=fail
	fi
	t1=$(date +%s)
	echo "$base $((t1 - t0))s $status" >> "$OUT/timing.txt"

	# Park the marker in an explicit gap and hold long enough for at least one
	# sampler tick to land there. Without this the last sample attributed to a
	# file is taken while that file's own QEMU is still up, so a per-file "QEMU
	# at exit" reading cannot distinguish a healthy teardown from a leak.
	echo "(after $base)" > "$MARKER"
	sleep 6
done

echo "(done)" > "$MARKER"
# One last tick so the report has a post-suite sample to compare against the
# pre-suite one — the settled figure, not the mid-teardown figure.
sleep 6

echo "finished:  $(date -u +%FT%TZ)  fail=$fail" | tee -a "$OUT/host.txt"
echo "artifacts: $OUT"
exit "$fail"
