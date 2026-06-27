#!/bin/sh
# file-transfer (CLI) — there is NO `quickchr cp` command yet (a known gap; see the
# README "friction found"). The LIBRARY does upload()/download() over SCP with the
# instance's resolved credentials; the CLI can't. This script just boots a CHR and
# surfaces the SSH port from `inspect` so you could scp manually if you must.
#
# For a clean, authenticated round-trip use:  bun run file-transfer.ts
set -eu

. "$(dirname "$0")/../common.sh"

name="$(example_name file-transfer)"
register_cleanup "$name"

qc start "$name" --channel stable --mem 256

echo "No 'quickchr cp' yet — use the library for a clean upload/download round-trip."
echo "The ssh port (for a manual scp) is in the descriptor below:"
qc inspect "$name"
