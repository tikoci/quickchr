#!/bin/sh
# rollback (CLI) — snapshot a CHR, change it, restore the snapshot.
set -eu

. "$(dirname "$0")/../common.sh"

name="$(example_name rollback)"
register_cleanup "$name"

# qcow2 boot disk (the default) is required for snapshots.
qc start "$name" --channel stable --no-secure-login --mem 256 --boot-disk-format qcow2

qc exec "$name" "/system/identity/set name=before-snapshot"
echo "→ save snapshot 'baseline'"
qc snapshot "$name" save baseline

echo "→ make a change (rename + firewall entry)"
qc exec "$name" "/system/identity/set name=after-change"
qc exec "$name" "/ip/firewall/address-list/add list=temp address=10.1.1.1"
qc exec "$name" "/system/identity/print"

echo "→ roll back to 'baseline'"
qc snapshot "$name" load baseline
qc exec "$name" "/system/identity/print"   # should read before-snapshot again

echo "→ snapshots on disk:"
qc snapshot "$name" list
