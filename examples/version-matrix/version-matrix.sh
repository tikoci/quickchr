#!/bin/sh
# version-matrix (CLI) — boot one CHR per channel in parallel, then list them.
# The pure-CLI slice: parallel `quickchr start` + `quickchr list`. The version /
# package / export-drift comparison lives in version-matrix.ts and .py (it needs
# response parsing); this script shows the parallel-start pattern.
#
# Usage: sh version-matrix.sh [--lite]
set -eu

. "$(dirname "$0")/../common.sh"

channels="long-term stable testing development"
[ "${1:-}" = "--lite" ] && channels="long-term stable"

i=0
for ch in $channels; do
	name="examples-vm-$(echo "$ch" | tr -d -)-$$"
	register_cleanup "$name"
	base=$((9200 + i * 10))
	echo "→ starting $name (channel=$ch, port-base=$base)…"
	# Distinct port-base per channel; --add-package is repeatable.
	qc start "$name" --channel "$ch" --no-secure-login \
		--port-base "$base" --add-package container --mem 256 &
	i=$((i + 1))
done

wait
echo ""
qc list
