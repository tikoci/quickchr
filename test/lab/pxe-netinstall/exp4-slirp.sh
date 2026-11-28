#!/bin/sh
# Experiment 4: QEMU user-mode networking's built-in TFTP + bootfile as the
# PXE server. OVMF gets a lease and the boot image from slirp; the netinstall
# kernel then broadcasts for a server on UDP/5000, which slirp never delivers.
#
#   exp4-slirp.sh   # runs 60 s, then prints the capture summary
set -eu
here=$(dirname "$0")
. "$here/lib.sh"
trap 'stop_owned; lab_unlock' EXIT
trap 'exit 143' INT TERM # run the EXIT trap, then stop
lab_lock
fetch_downloads
rm -f "$WORK/e4-slirp".*
own "$WORK/e4-slirp.pid"
DISK_DEV=ide-hd NIC_DEV=e1000 sh "$here/target-x86.sh" e4-slirp \
	"user,id=n0,tftp=$DL/netinstk,bootfile=linux.x86_64" uefi
sleep 60
hmp "$WORK/e4-slirp.mon" "screendump $WORK/e4-slirp.ppm"
sleep 1
kill_pidfile "$WORK/e4-slirp.pid"
tr -d '\r' <"$WORK/e4-slirp.serial.log" | sed 's/\x1b\[[0-9;?=]*[a-zA-Z]//g' | grep -E 'PXE|Station|Server|NBP' || true
if command -v tshark >/dev/null; then
	tshark -r "$WORK/e4-slirp.pcap" -q -z conv,udp 2>/dev/null | sed -n '5,12p'
else
	# UDP flows by source > destination port, from tcpdump.
	tcpdump -nr "$WORK/e4-slirp.pcap" udp 2>/dev/null | awk '{print $3, $4, $5}' | sed 's/:$//' | sort | uniq -c | sort -rn | head -8
fi
