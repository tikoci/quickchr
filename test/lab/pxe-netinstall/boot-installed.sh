#!/bin/sh
# Boot a netinstalled x86 disk the way quickchr would: virtio-net on user-mode
# networking with REST forwarded, firmware network boot off. Waits for REST.
#
#   boot-installed.sh <disk.qcow2> <run-name> [uefi|bios] [http-port]
#
# DISK_DEV (default virtio-blk-pci) picks the disk device.
set -eu
. "$(dirname "$0")/lib.sh"
disk=$1 run=$2 fw=${3:-uefi} port=${4:-19180}
firmware="" machine="-M pc"
if [ "$fw" = uefi ]; then
	machine="-M q35"
	uefi_vars "$OVMF_CODE" "$OVMF_VARS" "$WORK/$run.vars.fd"
	firmware="-drive if=pflash,format=raw,unit=0,readonly=on,file=$OVMF_CODE -drive if=pflash,format=raw,unit=1,file=$WORK/$run.vars.fd"
	firmware="$firmware -fw_cfg name=opt/org.tianocore/IPv4PXESupport,string=no -fw_cfg name=opt/org.tianocore/IPv6PXESupport,string=no"
fi
t0=$(date +%s)
# shellcheck disable=SC2086
qemu-system-x86_64 $machine $X86_ACCEL -m 1024 -smp 2 $firmware \
	-drive "file=$disk,format=qcow2,if=none,id=d0" -device "${DISK_DEV:-virtio-blk-pci},drive=d0,bootindex=1" \
	-netdev "user,id=n0,hostfwd=tcp:127.0.0.1:$port-:80" -device virtio-net-pci,netdev=n0,romfile= \
	-display none -vga std -serial "file:$WORK/$run.serial.log" \
	-monitor "unix:$WORK/$run.mon,server,nowait" -pidfile "$WORK/$run.pid" -daemonize
for _ in $(seq 1 90); do
	code=$(curl -s -m 3 -u admin: -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/rest/system/resource" || true)
	[ "$code" = 200 ] && { log "$run: REST 200 after $(( $(date +%s) - t0 ))s"; exit 0; }
	sleep 2
done
log "$run: no REST after $(( $(date +%s) - t0 ))s"
exit 1
