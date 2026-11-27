#!/bin/sh
# cspell:ignore QCHRPXE
# A blank arm64 VM (virt + EDK2, TCG) that network-boots first: the arm64 PXE client.
#
#   target-arm64.sh <run-name> <netdev-spec>
#
# Same conventions as target-x86.sh (netdev id n0, NIC bootindex=1, disk
# bootindex=2, $WORK/<run>.{qcow2,pcap,serial.log,mon,pid}). DISK_DEV defaults
# to nvme (needs serial=, which this script adds); NIC_DEV to virtio-net-pci,
# the only NIC EDK2 on virt can PXE-boot from (QEMU's efi-*.rom option ROMs are
# x86 EFI drivers).
set -eu
. "$(dirname "$0")/lib.sh"

run=$1 netdev=$2
disk=$WORK/$run.qcow2
[ -f "$disk" ] || qemu-img create -q -f qcow2 "$disk" 1G
uefi_vars "$QEMU_SHARE/edk2-aarch64-code.fd" "$QEMU_SHARE/edk2-arm-vars.fd" "$WORK/$run.vars.fd"
dev=${DISK_DEV:-nvme}
case $dev in nvme) dev="nvme,serial=${DISK_SERIAL:-QCHRPXE0001}" ;; esac

qemu-system-aarch64 -M virt -accel tcg,tb-size=256 -cpu cortex-a710 -m 1024 -smp 2 \
	-drive "if=pflash,format=raw,unit=0,readonly=on,file=$QEMU_SHARE/edk2-aarch64-code.fd" \
	-drive "if=pflash,format=raw,unit=1,file=$WORK/$run.vars.fd" \
	-drive "file=$disk,format=qcow2,if=none,id=d0" -device "$dev,drive=d0,bootindex=2" \
	-netdev "$netdev" -device "${NIC_DEV:-virtio-net-pci},netdev=n0,mac=${MAC:-02:00:00:00:00:03},bootindex=1" \
	-object "filter-dump,id=f0,netdev=n0,file=$WORK/$run.pcap" \
	-display none -serial "file:$WORK/$run.serial.log" \
	-monitor "unix:$WORK/$run.mon,server,nowait" \
	-pidfile "$WORK/$run.pid" -daemonize
log "target $run (arm64) started, pid $(cat "$WORK/$run.pid")"
