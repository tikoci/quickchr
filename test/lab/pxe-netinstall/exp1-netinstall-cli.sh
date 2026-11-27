#!/bin/sh
# Experiment 1: Linux netinstall-cli (in an Alpine VM) installs RouterOS x86
# onto a blank VM that PXE-boots, all over a unix dgram link. No root.
#
#   exp1-netinstall-cli.sh [bios|uefi|direct-bios|direct-uefi]
#
# bios/uefi: the target PXE-boots (target-x86.sh). direct-*: the target loads
# the netinstall image with -kernel instead (direct-install.sh, no firmware
# network boot). WAIT (seconds, default 900) bounds the wait for the install;
# a short WAIT suits bios, which the server rejects at BOOTP.
#
# Target hardware defaults to what the netinstall kernel accepts (see REPORT.md):
# DISK_DEV=ide-hd, NIC_DEV=e1000. Override them to reproduce the failures.
# After "Successfully finished", the target is stopped and its disk booted
# again by boot-installed.sh (UEFI, virtio, user networking) to read REST.
set -eu
here=$(dirname "$0")
. "$here/lib.sh"
mode=${1:-uefi}
run=e1-$mode
export DISK_DEV="${DISK_DEV:-ide-hd}" NIC_DEV="${NIC_DEV:-e1000}"
export NI_FILES="$here/scripts/configure.rsc $here/scripts/mode.rsc"

rm -f "$WORK/$run".* "$WORK/ni-$run".*
sh "$here/ni-server.sh" "$run" -r -s configure.rsc -sm mode.rsc >"$WORK/ni-$run.out" 2>&1 &
ni=$!
# OVMF PXE gives up after ~31 s (4 DISCOVERs, PXE-E18) and netinstall-cli
# needs ~20 s after launch before it answers, so wait for it first.
for _ in $(seq 1 60); do
	grep -q "Waiting for RouterBOARD" "$WORK/ni-$run.serial.log" 2>/dev/null && break
	sleep 1
done
sleep 5
t0=$(date +%s)
case $mode in
direct-*)
	# Foreground: returns when the installer reboots (-no-reboot).
	fw=${mode#direct-}
	sh "$here/direct-install.sh" "$run" "$(dgram_pair "$run" b)" x86 "$fw"
	;;
*)
	fw=$mode
	sh "$here/target-x86.sh" "$run" "$(dgram_pair "$run" b)" "$fw"
	;;
esac

result=timeout
for _ in $(seq 1 $(( ${WAIT:-900} / 2 ))); do
	if grep -q "Successfully finished" "$WORK/ni-$run.serial.log" 2>/dev/null; then result=installed; break; fi
	sleep 2
done
log "$run: $result after $(( $(date +%s) - t0 ))s"
grep -E "BOOTP|architecture|Assigned|setup mode|Formatting|Sending|sent|Rebooting|finished" "$WORK/ni-$run.serial.log" | uniq -c >&2 || true
kill_pidfile "$WORK/$run.pid"
kill "$ni" 2>/dev/null || true # still waiting when the install failed
[ "$result" = installed ] || exit 1

cp "$WORK/$run.qcow2" "$WORK/$run-installed.qcow2"
sh "$here/boot-installed.sh" "$WORK/$run-installed.qcow2" "$run-post" "$fw" 19180
for p in system/resource system/license system/identity system/package ip/dhcp-client system/note; do
	echo "== /$p"
	curl -s -m 10 -u admin: "http://127.0.0.1:19180/rest/$p"
	echo
done
kill_pidfile "$WORK/$run-post.pid"
