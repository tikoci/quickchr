#!/bin/sh
# CLI boot/configuration; shared Bun assertions keep both drivers equivalent.
set -eu
. "$(dirname "$0")/../common.sh"
export QUICKCHR
bun run "$(dirname "$0")/cmr.ts" --cli "$@"
