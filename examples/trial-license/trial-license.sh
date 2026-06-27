#!/bin/sh
# trial-license (CLI) — apply a CHR trial license, read it back. MANUAL-ONLY.
# MikroTik rate-limits trial requests, so this is excluded from CI. Without
# MIKROTIK_WEB_ACCOUNT / MIKROTIK_WEB_PASSWORD it just prints the current level.
set -eu

. "$(dirname "$0")/../common.sh"

name="$(example_name trial-license)"
register_cleanup "$name"

qc start "$name" --channel stable --no-secure-login --mem 256

echo "→ current license:"
qc get "$name" license

if [ -n "${MIKROTIK_WEB_ACCOUNT:-}" ] && [ -n "${MIKROTIK_WEB_PASSWORD:-}" ]; then
	echo "→ applying p1 trial license…"
	qc set "$name" --license --level p1
	qc get "$name" license
else
	echo "→ set MIKROTIK_WEB_ACCOUNT / MIKROTIK_WEB_PASSWORD to apply a p1 trial (manual-only)."
fi
