#!/bin/sh
# cspell:ignore QCHRPXE BDS depex hubid hubport nics
# A blank arm64 VM (virt + EDK2, TCG) that network-boots first: the arm64 PXE client.
#
#   target-arm64.sh <run-name> <netdev-spec>
#
# Same conventions as target-x86.sh (netdev id n0, NIC bootindex=1, disk
# bootindex=2, $WORK/<run>.{qcow2,pcap,serial.log,mon,pid}). DISK_DEV defaults
# to nvme (needs serial=, which this script adds); NIC_DEV to virtio-net-pci,
# the only NIC EDK2 on virt can PXE-boot from (QEMU's efi-*.rom option ROMs are
# x86 EFI drivers).
# EDK2's network stack (MnpDxe and up) has a depex on EFI_RNG_PROTOCOL.
# ARM_CPU picks the -cpu model: max (default here; neoverse-n2/-v1 too) has
# FEAT_RNG and PXE-boots. cortex-a710, quickchr's TCG model, has no RNDR, no
# network driver loads, and there is no network boot. RNG=virtio adds
# -device virtio-rng-pci: the stack then loads, but too late for BDS to
# create a PXE boot option (seen on Arch and Ubuntu firmware).
set -eu
. "$(dirname "$0")/lib.sh"

run=$1 netdev=$2
disk=$WORK/$run.qcow2
[ -f "$disk" ] || qemu-img create -q -f qcow2 "$disk" 1G
uefi_vars "$AAVMF_CODE" "$AAVMF_VARS" "$WORK/$run.vars.fd"
dev=${DISK_DEV:-nvme}
case $dev in nvme) dev="nvme,serial=${DISK_SERIAL:-QCHRPXE0001}" ;; esac

rng=""
[ "${RNG:-}" = virtio ] && rng="-device virtio-rng-pci"
# IGB=1: the firmware PXE-boots from virtio-net, but the arm64 netinstall
# kernel only takes igb. Both NICs, with one MAC, then sit on a QEMU hub whose
# uplink is <netdev-spec>, so each finds its own NIC on the same L2.
mac=${MAC:-02:00:00:00:00:03}
if [ "${IGB:-}" = 1 ]; then
	up=$(printf '%s' "$netdev" | sed 's/id=n0/id=up/')
	nics="-netdev $up -netdev hubport,id=hup,hubid=0,netdev=up
		-netdev hubport,id=n0,hubid=0 -device virtio-net-pci,netdev=n0,mac=$mac,romfile=,bootindex=1
		-netdev hubport,id=n1,hubid=0 -device igb,netdev=n1,mac=$mac,romfile="
	dump_id=up
else
	nics="-netdev $netdev -device ${NIC_DEV:-virtio-net-pci},netdev=n0,mac=$mac,bootindex=1"
	dump_id=n0
fi

# shellcheck disable=SC2086
qemu-system-aarch64 -M virt -accel tcg,tb-size=256 -cpu "${ARM_CPU:-max}" -m 1024 -smp 2 $rng \
	-drive "if=pflash,format=raw,unit=0,readonly=on,file=$AAVMF_CODE" \
	-drive "if=pflash,format=raw,unit=1,file=$WORK/$run.vars.fd" \
	-drive "file=$disk,format=qcow2,if=none,id=d0" -device "$dev,drive=d0,bootindex=2" \
	$nics \
	-object "filter-dump,id=f0,netdev=$dump_id,file=$WORK/$run.pcap" \
	-display none -serial "file:$WORK/$run.serial.log" \
	-monitor "unix:$WORK/$run.mon,server,nowait" \
	-pidfile "$WORK/$run.pid" -daemonize
log "target $run (arm64) started, pid $(cat "$WORK/$run.pid")"
