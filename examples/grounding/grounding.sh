#!/bin/sh
# grounding (CLI) — apply RouterOS config, read it back, prove it took.
# The CLI mirror of the apply→read-back loop that grounding.test.ts asserts.
set -eu

. "$(dirname "$0")/../common.sh"

name="$(example_name grounding)"
register_cleanup "$name"
nonce="g$$"

qc start "$name" --channel stable --no-secure-login --mem 256

echo "→ apply: tag a firewall address-list entry"
qc exec "$name" \
	"/ip/firewall/address-list/add list=quickchr-grounding address=10.99.99.99 comment=grounded-$nonce"

echo "→ read it back (should show grounded-$nonce):"
qc exec "$name" "/ip/firewall/address-list/print where comment=grounded-$nonce"

echo "→ apply: set identity, then read it back"
qc exec "$name" "/system/identity/set name=chr-$nonce"
qc exec "$name" "/system/identity/print"
