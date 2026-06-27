#!/bin/sh
# device-mode (CLI) — enable a device-mode feature on first boot, read it back.
set -eu

. "$(dirname "$0")/../common.sh"

name="$(example_name device-mode)"
register_cleanup "$name"

echo "→ starting $name with device-mode container enabled"
qc start "$name" --channel long-term --no-secure-login --mem 256 --device-mode-enable container

echo "→ read it back:"
qc get "$name" device-mode
