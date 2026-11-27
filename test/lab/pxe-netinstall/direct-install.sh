#!/bin/sh
# cspell:ignore QCHRPXE
# Netinstall without firmware network boot: QEMU loads MikroTik's netinstall
# boot image itself (-kernel), and the image finds the server on the L2 link.
#
#   direct-install.sh <run-name> <netdev-spec> <x86|arm64> [bios|uefi]
#
# x86 bios (default): -M pc + SeaBIOS, -kernel linux.x86_64 (a bzImage).
# x86 uefi: -M q35 + OVMF; OVMF runs the same bzImage through its EFI stub.
# arm64: -M virt + EDK2 (TCG), -kernel linux.arm64-uefi (a PE32+ EFI app).
#
# Hardware is what the netinstall kernels accept (REPORT.md): x86 ide-hd +
# e1000, arm64 nvme + igb; DISK_DEV/NIC_DEV override. The disk needs a serial.
# -no-reboot makes QEMU exit when the installer reboots the target, which is
# the "install finished" signal. Runs in the foreground; prints the time.
set -eu
. "$(dirname "$0")/lib.sh"

run=$1 netdev=$2 arch=$3 fw=${4:-bios}
fetch_downloads
disk=$WORK/$run.qcow2
rm -f "$disk" "$WORK/$run.pcap" "$WORK/$run.serial.log"
qemu-img create -q -f qcow2 "$disk" 1G
serial=${DISK_SERIAL:-QCHRPXE0001}

if [ "$arch" = arm64 ]; then
	uefi_vars "$QEMU_SHARE/edk2-aarch64-code.fd" "$QEMU_SHARE/edk2-arm-vars.fd" "$WORK/$run.vars.fd"
	set -- qemu-system-aarch64 -M virt -accel tcg,tb-size=256 -cpu cortex-a710 \
		-drive "if=pflash,format=raw,unit=0,readonly=on,file=$QEMU_SHARE/edk2-aarch64-code.fd" \
		-drive "if=pflash,format=raw,unit=1,file=$WORK/$run.vars.fd" \
		-kernel "$DL/netinstk/linux.arm64-uefi"
	disk_dev=${DISK_DEV:-nvme} nic_dev=${NIC_DEV:-igb}
else
	set -- qemu-system-x86_64 -accel hvf -cpu host -kernel "$DL/netinstk/linux.x86_64"
	if [ "$fw" = uefi ]; then
		uefi_vars "$QEMU_SHARE/edk2-x86_64-code.fd" "$QEMU_SHARE/edk2-i386-vars.fd" "$WORK/$run.vars.fd"
		set -- "$@" -M q35 \
			-drive "if=pflash,format=raw,unit=0,readonly=on,file=$QEMU_SHARE/edk2-x86_64-code.fd" \
			-drive "if=pflash,format=raw,unit=1,file=$WORK/$run.vars.fd"
	else
		set -- "$@" -M pc
	fi
	disk_dev=${DISK_DEV:-ide-hd} nic_dev=${NIC_DEV:-e1000}
fi

t0=$(date +%s)
"$@" -m 1024 -smp 2 \
	-drive "file=$disk,format=qcow2,if=none,id=d0" -device "$disk_dev,drive=d0,serial=$serial" \
	-netdev "$netdev" -device "$nic_dev,netdev=n0,mac=${MAC:-02:00:00:00:00:07},romfile=" \
	-object "filter-dump,id=f0,netdev=n0,file=$WORK/$run.pcap" \
	-display none -serial "file:$WORK/$run.serial.log" -no-reboot
log "$run: QEMU exited (installer rebooted or powered off) after $(( $(date +%s) - t0 ))s"
