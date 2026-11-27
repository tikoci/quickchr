#!/bin/sh
# Experiment 3: arm64.
#
#   exp3-arm64.sh probe   # does Homebrew's edk2-aarch64-code.fd have a network stack?
#   exp3-arm64.sh install # netinstall-cli serves an arm64 VM booted with -kernel
#
# probe boots EDK2 to its shell with a virtio-net NIC (bootindex=1) and asks
# the shell for boot options, network interfaces and drivers.
set -eu
here=$(dirname "$0")
. "$here/lib.sh"

case ${1:-install} in
probe)
	uefi_vars "$QEMU_SHARE/edk2-aarch64-code.fd" "$QEMU_SHARE/edk2-arm-vars.fd" "$WORK/probe.vars.fd"
	rm -f "$WORK/probe.ser"
	qemu-system-aarch64 -M virt -accel tcg,tb-size=256 -cpu cortex-a710 -m 1024 \
		-drive "if=pflash,format=raw,unit=0,readonly=on,file=$QEMU_SHARE/edk2-aarch64-code.fd" \
		-drive "if=pflash,format=raw,unit=1,file=$WORK/probe.vars.fd" \
		-netdev user,id=n0 -device virtio-net-pci,netdev=n0,romfile=,bootindex=1 \
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
	for _ in $(seq 1 60); do
		grep -q "Waiting for RouterBOARD" "$WORK/ni-e3.serial.log" 2>/dev/null && break
		sleep 1
	done
	sh "$here/direct-install.sh" e3-arm64 "$(dgram_pair e3 b)" arm64
	grep -vE '^\[' "$WORK/ni-e3.serial.log"
	;;
esac
