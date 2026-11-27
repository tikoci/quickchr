#!/bin/sh
# cspell:ignore QCHRPXE harddrives
# A blank x86 VM that network-boots first: the PXE client for every x86 experiment.
#
#   target-x86.sh <run-name> <netdev-spec> [bios|uefi]
#
# <netdev-spec> is a full -netdev value whose id is n0, e.g. from
# `dgram_pair <link> b`, or `user,id=n0,tftp=...,bootfile=...`.
# bios (default): -M pc + SeaBIOS + iPXE option ROM (quickchr's x86 machine).
# uefi: -M q35 + OVMF; the virtio-net iPXE EFI driver is kept unless ROM= is set.
#
# Disk: $WORK/<run>.qcow2, 1 GiB, created blank if missing. The NIC has
# bootindex=1, the disk bootindex=2, so once the disk holds RouterOS a reboot
# still tries the network first (that is the point: a netinstall server that
# answers again reinstalls again).
# Output: $WORK/<run>.pcap, <run>.serial.log, monitor at <run>.mon,
# pid in <run>.pid. Runs in the background.
set -eu
. "$(dirname "$0")/lib.sh"

run=$1 netdev=$2 fw=${3:-bios}
disk=$WORK/$run.qcow2
[ -f "$disk" ] || qemu-img create -q -f qcow2 "$disk" 1G
rom=${ROM-}

case $fw in
bios)
	machine="-M pc"
	firmware=""
	;;
uefi)
	machine="-M q35"
	uefi_vars "$QEMU_SHARE/edk2-x86_64-code.fd" "$QEMU_SHARE/edk2-i386-vars.fd" "$WORK/$run.vars.fd"
	firmware="-drive if=pflash,format=raw,unit=0,readonly=on,file=$QEMU_SHARE/edk2-x86_64-code.fd -drive if=pflash,format=raw,unit=1,file=$WORK/$run.vars.fd"
	;;
esac
nic_rom=""
# The netinstall kernel derives the x86 Hardware-ID from the disk; a virtio-blk
# disk without serial= is skipped ("no valid harddrives found"). DISK_SERIAL=
# (empty) reproduces that. DISK_DEV picks the disk device: virtio-blk-pci
# (default, what quickchr uses), ide-hd (PIIX IDE on pc, AHCI on q35), nvme.
# NIC_DEV picks the NIC model: virtio-net-pci (default), e1000, e1000e, ...
disk_serial=",serial=${DISK_SERIAL-QCHRPXE0001}"
[ -z "${DISK_SERIAL-x}" ] && disk_serial=""
[ -n "${ROM+x}" ] && nic_rom=",romfile=$rom"

# shellcheck disable=SC2086
qemu-system-x86_64 $machine -accel hvf -cpu host -m 1024 -smp 2 $firmware \
	-drive "file=$disk,format=qcow2,if=none,id=d0" -device "${DISK_DEV:-virtio-blk-pci},drive=d0,bootindex=2$disk_serial" \
	-netdev "$netdev" -device "${NIC_DEV:-virtio-net-pci},netdev=n0,mac=${MAC:-02:00:00:00:00:02},bootindex=1$nic_rom" \
	-object "filter-dump,id=f0,netdev=n0,file=$WORK/$run.pcap" \
	-display none ${VGA:--vga std} \
	-serial "file:$WORK/$run.serial.log" \
	-monitor "unix:$WORK/$run.mon,server,nowait" \
	-pidfile "$WORK/$run.pid" -daemonize
log "target $run ($fw) started, pid $(cat "$WORK/$run.pid")"
