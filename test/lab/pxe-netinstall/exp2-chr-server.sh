#!/bin/sh
# Experiment 2: a quickchr CHR with the netinstall package is the server; a
# blank VM on the other end of a quickchr named socket is installed. No host
# tools beyond QEMU + quickchr, no root.
#
#   exp2-chr-server.sh <server-version> pxe          # x86 target, OVMF PXE
#   exp2-chr-server.sh <server-version> direct-x86   # x86 target, -kernel, SeaBIOS
#   exp2-chr-server.sh <server-version> direct-arm64 # arm64 target, -kernel, EDK2
#
# The CHR needs internet through its user NIC: it downloads netinstk/ boot
# images and routeros-*.npk from upgrade.mikrotik.com on demand.
# QC overrides the quickchr command (default: this checkout's CLI).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh"
srv_ver=$1 mode=$2
repo=$(cd "$here/../../.." && pwd)
QC=${QC:-bun run $repo/src/cli/index.ts}
srv=pxe-srv link=pxe-link run=e2-$mode
# shellcheck disable=SC2086
qc() { $QC "$@"; }

qc networks sockets create "$link"
qc add --name "$srv" --version "$srv_ver" --arch x86 \
	--add-network user --add-network "socket::$link" --add-package netinstall
qc start "$srv"
R=$(qc inspect "$srv" --json | python3 -c 'import json,sys;print(json.load(sys.stdin)["services"]["rest-api"]["url"])')
c() { curl -s -m 60 -u admin: -H 'content-type: application/json' "$@"; echo; }

c -X PUT "$R/ip/address" -d '{"address":"192.168.88.1/24","interface":"ether2"}'
# 7.26 refuses cache/add until an update check has succeeded ("Default version
# not fetched"); the first check right after boot can fail on DNS, so retry.
for _ in 1 2 3; do
	c -X POST "$R/system/package/update/check-for-updates" -d '{"duration":"15s"}' | grep -q '"latest-version"' && break
	sleep 5
done
# No ip-range: with one set, 7.25.2 answers with siaddr 0.0.0.0 and mask
# 0.0.0.0, and OVMF discards the offer (PXE-E16; 7.26 not tried). Without it
# the server leases 169.254.x.x/16 and names itself 169.254.1.1.
c -X PUT "$R/tool/netinstall" -d "{\"interface\":\"ether2\",\"version\":\"$srv_ver\",\"keep-old-configuration\":\"no\",\"install-once\":\"yes\"}"
c -X POST "$R/tool/netinstall/devices/clear" -d '{}'

# The raw-QEMU target takes slot 1 of the named socket (quickchr's
# socketEndpointPath: <data-dir>/networks/<name>.<slot>.sock).
N=${QUICKCHR_DATA_DIR:-$HOME/.local/share/quickchr}/networks
netdev="dgram,id=n0,local.type=unix,local.path=$N/$link.1.sock,remote.type=unix,remote.path=$N/$link.0.sock"

watch_states() {
	prev=""
	while :; do
		s=$(curl -s -u admin: "$R/tool/netinstall/devices" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d[0]["state"]+" arch="+d[0].get("arch","") if d else "-")' 2>/dev/null || true)
		[ "$s" != "$prev" ] && log "server: $s" && prev=$s
		sleep 3
	done
}
watch_states & W=$!
case $mode in
pxe)
	rm -f "$WORK/$run.qcow2"
	DISK_DEV=ide-hd NIC_DEV=e1000 sh "$here/target-x86.sh" "$run" "$netdev" uefi
	for _ in $(seq 1 200); do
		curl -s -u admin: "$R/tool/netinstall/devices" | grep -q '"done' && break
		sleep 3
	done
	# The target writes its boot loader after the server reports done; give
	# it time to reboot before stopping it.
	sleep 20
	kill_pidfile "$WORK/$run.pid"
	;;
direct-x86) sh "$here/direct-install.sh" "$run" "$netdev" x86 bios ;;
direct-arm64) sh "$here/direct-install.sh" "$run" "$netdev" arm64 ;;
esac
kill $W
c "$R/tool/netinstall/devices"
c "$R/tool/netinstall/cache"
qc remove "$srv"
qc networks sockets remove "$link"
