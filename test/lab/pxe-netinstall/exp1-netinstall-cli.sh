#!/bin/sh
# Experiment 1: Linux netinstall-cli (in an Alpine VM) installs RouterOS x86
# onto a blank VM that PXE-boots, all over a unix dgram link. No root.
#
#   exp1-netinstall-cli.sh [bios|uefi|direct-bios|direct-uefi]
#
# bios/uefi: the target PXE-boots (target-x86.sh). direct-*: the target loads
# the netinstall image with -kernel instead (direct-install.sh, no firmware
# network boot). WAIT (seconds, default 900) bounds the install, counted from
# the target's launch, in every mode; a short WAIT suits bios, which the server
# rejects at BOOTP. The server and every QEMU started here are stopped on exit,
# also on failure or interrupt.
#
# Target hardware defaults to what the netinstall kernel accepts (see REPORT.md):
# DISK_DEV=ide-hd, NIC_DEV=e1000. Override them to reproduce the failures.
# After "Successfully finished", the target is stopped and a copy of its disk
# booted by boot-installed.sh (the install's firmware, virtio-net, user
# networking) to read REST. That boot's disk device is POST_DISK_DEV, default
# ide-hd. The installed system dies on virtio-blk (`Fatal error 0x853`), which
# POST_DISK_DEV=virtio-blk-pci reproduces, also on the copy's first boot.
set -eu
here=$(dirname "$0")
. "$here/lib.sh"
mode=${1:-uefi}
run=e1-$mode
export DISK_DEV="${DISK_DEV:-ide-hd}" NIC_DEV="${NIC_DEV:-e1000}"
export NI_FILES="$here/scripts/configure.rsc $here/scripts/mode.rsc"

ni=""
cleanup() {
	kill_tree "$rb_pid" # a direct install still running
	stop_owned
	kill_tree "$ni" # still waiting when the install failed
	lab_unlock
}
trap cleanup EXIT
trap 'exit 143' INT TERM # run the EXIT trap, then stop
lab_lock
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
wait_s=${WAIT:-900}
target_rc=0
case $mode in
direct-*)
	# Foreground: returns when the installer reboots (-no-reboot), or is
	# stopped when WAIT runs out.
	fw=${mode#direct-}
	own "$WORK/$run.pid"
	run_bounded "$wait_s" sh "$here/direct-install.sh" "$run" "$(dgram_pair "$run" b)" x86 "$fw" || target_rc=$?
	;;
*)
	fw=$mode
	own "$WORK/$run.pid"
	sh "$here/target-x86.sh" "$run" "$(dgram_pair "$run" b)" "$fw"
	;;
esac

result=timeout
# A direct target that timed out or failed fails the run even if the server
# logged success: the installer writes the boot loader after that.
[ "$target_rc" = 0 ] || result="target-exit-$target_rc"
while [ "$target_rc" = 0 ]; do
	if grep -q "Successfully finished" "$WORK/ni-$run.serial.log" 2>/dev/null; then result=installed; break; fi
	[ "$(date +%s)" -lt $(( t0 + wait_s )) ] || break
	sleep 2
done
log "$run: $result after $(( $(date +%s) - t0 ))s"
grep -E "BOOTP|architecture|Assigned|setup mode|Formatting|Sending|sent|Rebooting|finished" "$WORK/ni-$run.serial.log" | uniq -c >&2 || true
kill_pidfile "$WORK/$run.pid"
kill_tree "$ni"
ni=""
[ "$result" = installed ] || exit 1

cp "$WORK/$run.qcow2" "$WORK/$run-installed.qcow2"
own "$WORK/$run-post.pid"
DISK_DEV=${POST_DISK_DEV:-ide-hd} sh "$here/boot-installed.sh" "$WORK/$run-installed.qcow2" "$run-post" "$fw" 19180
for p in system/resource system/license system/identity system/package ip/dhcp-client system/note; do
	echo "== /$p"
	curl -s -m 10 -u admin: "http://127.0.0.1:19180/rest/$p"
	echo
done
kill_pidfile "$WORK/$run-post.pid"
