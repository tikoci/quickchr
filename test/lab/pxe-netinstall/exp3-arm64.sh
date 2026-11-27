#!/bin/sh
# cspell:ignore depex
# Experiment 3: arm64.
#
#   exp3-arm64.sh probe   # which network drivers does the firmware load? (ARM_CPU)
#   exp3-arm64.sh install # netinstall-cli serves an arm64 VM booted with -kernel
#   exp3-arm64.sh pxe     # netinstall-cli serves an arm64 VM that PXE-boots
#
# probe boots EDK2 to its shell with a virtio-net NIC (bootindex=1) and asks
# the shell for boot options, network interfaces and drivers. It needs a build
# with an EFI shell on the boot menu (Homebrew, Debian); Arch's and Ubuntu's
# QEMU_EFI.fd offer none and it then waits out its 300 s.
#
# EDK2's network drivers carry a depex on EFI_RNG_PROTOCOL. ARM_CPU picks the
# -cpu model; with cortex-a710 (quickchr's TCG default) nothing produces that
# protocol and no network driver loads. ARM_CPU=max (FEAT_RNG) loads them.
#
# pxe: target-arm64.sh with IGB=1 (virtio-net for the firmware, igb for the
# netinstall kernel, on one hub) and ARM_CPU=max. WAIT bounds the wait (900 s).
set -eu
here=$(dirname "$0")
. "$here/lib.sh"

case ${1:-install} in
probe)
	uefi_vars "$AAVMF_CODE" "$AAVMF_VARS" "$WORK/probe.vars.fd"
	rm -f "$WORK/probe.ser"
	qemu-system-aarch64 -M virt -accel tcg,tb-size=256 -m 1024 \
		-drive "if=pflash,format=raw,unit=0,readonly=on,file=$AAVMF_CODE" \
		-drive "if=pflash,format=raw,unit=1,file=$WORK/probe.vars.fd" \
		-netdev user,id=n0 -device virtio-net-pci,netdev=n0,romfile=,bootindex=1 \
		-cpu "${ARM_CPU:-cortex-a710}" \
		-display none -chardev "socket,id=s0,path=$WORK/probe.ser,server=on,wait=off" \
		-serial chardev:s0 -pidfile "$WORK/probe.pid" -daemonize
	python3 -I - "$WORK/probe.ser" <<'EOF'
import re, socket, sys, time
s = socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); s.settimeout(1)
def until(mark, limit):
    buf = b""; t = time.time()
    while time.time() - t < limit:
        try: buf += s.recv(65536)
        except socket.timeout: pass
        if mark in buf: break
    return re.sub(rb"\x1b\[[0-9;?=]*[a-zA-Z]", b"", buf).decode(errors="replace")
until(b"Shell>", 300)
for cmd in ["bcfg boot dump", "ifconfig -l", "drivers"]:
    s.send(cmd.encode() + b"\r")
    print("==", cmd); print(until(b"Shell>", 60))
EOF
	kill_pidfile "$WORK/probe.pid"
	;;
install)
	export NI_FILES="$here/scripts/configure.rsc $here/scripts/mode.rsc"
	rm -f "$WORK/ni-e3.serial.log"
	sh "$here/ni-server.sh" e3 -r -s configure.rsc -sm mode.rsc -- \
		"routeros-$VER.npk" "routeros-$VER-arm64.npk" >"$WORK/ni-e3.out" 2>&1 &
	ni=$!
	for _ in $(seq 1 60); do
		grep -q "Waiting for RouterBOARD" "$WORK/ni-e3.serial.log" 2>/dev/null && break
		sleep 1
	done
	sh "$here/direct-install.sh" e3-arm64 "$(dgram_pair e3 b)" arm64 || true
	kill "$ni" 2>/dev/null || true # still running if the install failed
	grep -vE '^\[' "$WORK/ni-e3.serial.log"
	;;
pxe)
	export NI_FILES="$here/scripts/configure.rsc $here/scripts/mode.rsc"
	run=e3-pxe
	rm -f "$WORK/ni-$run".* "$WORK/$run".*
	sh "$here/ni-server.sh" "$run" -r -s configure.rsc -sm mode.rsc -- \
		"routeros-$VER.npk" "routeros-$VER-arm64.npk" >"$WORK/ni-$run.log" 2>&1 &
	ni=$!
	for _ in $(seq 1 60); do
		grep -q "Waiting for RouterBOARD" "$WORK/ni-$run.serial.log" 2>/dev/null && break
		sleep 1
	done
	t0=$(date +%s)
	IGB=1 MAC=02:00:00:00:00:33 sh "$here/target-arm64.sh" "$run" "$(dgram_pair "$run" b)"
	result=timeout
	for _ in $(seq 1 $(( ${WAIT:-900} / 3 ))); do
		grep -q "Successfully finished" "$WORK/ni-$run.serial.log" 2>/dev/null && { result=installed; break; }
		sleep 3
	done
	log "$run: $result after $(( $(date +%s) - t0 ))s"
	kill_pidfile "$WORK/$run.pid"
	kill "$ni" 2>/dev/null || true
	grep -vE '^\[' "$WORK/ni-$run.serial.log"
	;;
esac
