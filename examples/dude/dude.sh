#!/bin/sh
# dude (CLI) — install the dude package on first boot, enable it, read it back.
# Works on x86 and arm64 (arch defaults to host-native).
set -eu

. "$(dirname "$0")/../common.sh"

name="$(example_name dude)"
register_cleanup "$name"

echo "→ starting $name with --add-package dude (downloads the .npk, reboots once)…"
qc start "$name" --channel stable --no-secure-login --add-package dude --mem 256

echo "→ enable the Dude server"
qc exec "$name" "/dude/set enabled=yes"

echo "→ read it back (expect enabled: yes):"
qc exec "$name" "/dude/print"
