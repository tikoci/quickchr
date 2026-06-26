#!/bin/sh
# quickstart (CLI) — boot a CHR, read its resource + connection descriptor, tear down.
# The CLI mirror of quickstart.ts. Teardown runs on EXIT via common.sh's trap.
set -eu

. "$(dirname "$0")/../common.sh"

name="$(example_name quickstart)"
register_cleanup "$name"

echo "→ starting $name (stable channel, host-native arch)…"
qc start "$name" --channel stable --no-secure-login --mem 256

echo "→ RouterOS resource:"
qc exec "$name" "/system/resource/print"

echo "→ connection descriptor (ports / URLs / auth):"
qc inspect "$name"
