#!/bin/sh
# Experiment 2: a quickchr CHR with the netinstall package is the server; a
# blank VM on the other end of a quickchr named socket is installed. No host
# tools beyond QEMU + quickchr, no root.
#
#   exp2-chr-server.sh <server-version> pxe          # x86 target, OVMF PXE
#   exp2-chr-server.sh <server-version> direct-x86   # x86 target, -kernel, SeaBIOS
#   exp2-chr-server.sh <server-version> direct-x86-uefi # x86 target, -kernel, OVMF
#   exp2-chr-server.sh <server-version> direct-arm64 # arm64 target, -kernel, EDK2
#   exp2-chr-server.sh <server-version> pxe-arm64    # arm64 target, EDK2 PXE (-cpu max, IGB=1)
#
# The CHR needs internet through its user NIC: it downloads netinstk/ boot
# images and routeros-*.npk from upgrade.mikrotik.com on demand.
# QC overrides the quickchr command (default: this checkout's CLI).
# IP_RANGE (e.g. 192.168.88.10-192.168.88.20) adds ip-range to the rule.
# WAIT (seconds, default 600 for pxe, 900 for direct-*) bounds the install.
# The server machine and the named socket are removed on exit, also on failure,
# but only when this run created them: a pre-existing pxe-srv or pxe-link
# (another run's) makes this run fail and is left alone.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh"
srv_ver=$1 mode=$2
repo=$(cd "$here/../../.." && pwd)
QC=${QC:-bun run $repo/src/cli/index.ts}
srv=pxe-srv link=pxe-link run=e2-$mode
# shellcheck disable=SC2086
qc() { $QC "$@"; }
W="" made_link="" made_srv=""
cleanup() {
	kill_tree "$W"
	kill_tree "$rb_pid" # a direct install still running
	stop_owned # the target, only if this run launched it
	[ -z "$made_srv" ] || qc remove "$srv" >/dev/null 2>&1 || true
	[ -z "$made_link" ] || qc networks sockets remove "$link" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 143' INT TERM # run the EXIT trap, then stop

qc networks sockets create "$link"
made_link=1
qc add --name "$srv" --version "$srv_ver" --arch x86 \
	--add-network user --add-network "socket::$link" --add-package netinstall
made_srv=1
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
# No ip-range unless IP_RANGE is set. Without one the server leases
# 169.254.x.x/16 and names itself 169.254.1.1, which still works on 7.26. With
# one, 7.25.2 answered with siaddr 0.0.0.0 and mask 0.0.0.0 on macOS (PXE-E16),
# but with a correct reply on Linux; 7.26beta7 installs with it (REPORT.md).
range=""
[ -n "${IP_RANGE:-}" ] && range=",\"ip-range\":\"$IP_RANGE\""
c -X PUT "$R/tool/netinstall" -d "{\"interface\":\"ether2\",\"version\":\"$srv_ver\",\"keep-old-configuration\":\"no\",\"install-once\":\"yes\"$range}"
c -X POST "$R/tool/netinstall/devices/clear" -d '{}'

# The raw-QEMU target takes slot 1 of the named socket (quickchr's
# socketEndpointPath: <data-dir>/networks/<name>.<slot>.sock).
N=${QUICKCHR_DATA_DIR:-$HOME/.local/share/quickchr}/networks
netdev="dgram,id=n0,local.type=unix,local.path=$N/$link.1.sock,remote.type=unix,remote.path=$N/$link.0.sock"

watch_states() {
	prev=""
	while :; do
		s=$(curl -s -m 10 -u admin: "$R/tool/netinstall/devices" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d[0]["state"]+" arch="+d[0].get("arch","") if d else "-")' 2>/dev/null || true)
		[ "$s" != "$prev" ] && log "server: $s" && prev=$s
		sleep 3
	done
}
watch_states & W=$!
case $mode in
pxe)
	rm -f "$WORK/$run.qcow2"
	own "$WORK/$run.pid"
	DISK_DEV=ide-hd NIC_DEV=e1000 sh "$here/target-x86.sh" "$run" "$netdev" uefi
	for _ in $(seq 1 $(( ${WAIT:-600} / 3 ))); do
		curl -s -m 10 -u admin: "$R/tool/netinstall/devices" | grep -q '"done' && break
		sleep 3
	done
	# The target writes its boot loader after the server reports done; give
	# it time to reboot before stopping it.
	sleep 20
	kill_pidfile "$WORK/$run.pid"
	;;
pxe-arm64)
	rm -f "$WORK/$run.qcow2"
	own "$WORK/$run.pid"
	IGB=1 sh "$here/target-arm64.sh" "$run" "$netdev"
	for _ in $(seq 1 $(( ${WAIT:-600} / 3 ))); do
		curl -s -m 10 -u admin: "$R/tool/netinstall/devices" | grep -q '"done' && break
		sleep 3
	done
	sleep 20
	kill_pidfile "$WORK/$run.pid"
	;;
direct-x86 | direct-x86-uefi | direct-arm64)
	case $mode in direct-x86) a=x86 f=bios ;; direct-x86-uefi) a=x86 f=uefi ;; *) a=arm64 f=uefi ;; esac
	own "$WORK/$run.pid"
	run_bounded "${WAIT:-900}" sh "$here/direct-install.sh" "$run" "$netdev" "$a" "$f" || true
	;;
esac
kill_tree "$W"
W=""
c "$R/tool/netinstall/devices"
c "$R/tool/netinstall/cache"
c "$R/tool/netinstall"
