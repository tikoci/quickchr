#!/bin/sh
# cspell:ignore pxeni QCHRPXE varstore
# shellcheck disable=SC2034  # OVMF_*, AAVMF_*, X86_ACCEL are used by the scripts that source this file
# Shared settings for the PXE / netinstall lab (quickchr#329).
# Source it: `. test/lab/pxe-netinstall/lib.sh`. Nothing here needs root.
#
# WORK holds run state: disks, pcaps, serial logs and the unix sockets for
# the dgram links. Keep it short: a socket path over 104 bytes (macOS) makes
# QEMU refuse to start.

VER=${VER:-7.25.2}
WORK=${WORK:-/tmp/pxeni}
CACHE=${CACHE:-$HOME/.local/share/quickchr/cache}
# Downloads (netinstk boot images, routeros-*.npk, netinstall-cli) live here.
DL=${DL:-$WORK/dl}
QEMU_SHARE=${QEMU_SHARE:-/usr/local/share/qemu}

# Firmware: the first pair whose code and vars files both exist. QEMU's own
# names (Homebrew, `make install`) under QEMU_SHARE first, then distro
# packages: Arch edk2-ovmf / edk2-aarch64, Debian/Ubuntu ovmf /
# qemu-efi-aarch64, Fedora edk2-ovmf / edk2-aarch64. Set OVMF_CODE+OVMF_VARS
# or AAVMF_CODE+AAVMF_VARS to pick another build.
# (No `set --` here: this file is sourced, and would clobber the caller's $@.)
first_pair() {
	while [ $# -ge 2 ]; do
		[ -f "$1" ] && [ -f "$2" ] && { echo "$1 $2"; return; }
		shift 2
	done
}
if [ -z "${OVMF_CODE:-}" ]; then
	read -r OVMF_CODE OVMF_VARS <<EOF2
$(first_pair \
		"$QEMU_SHARE/edk2-x86_64-code.fd" "$QEMU_SHARE/edk2-i386-vars.fd" \
		/usr/share/edk2/x64/OVMF_CODE.4m.fd /usr/share/edk2/x64/OVMF_VARS.4m.fd \
		/usr/share/OVMF/OVMF_CODE_4M.fd /usr/share/OVMF/OVMF_VARS_4M.fd \
		/usr/share/edk2/ovmf/OVMF_CODE.fd /usr/share/edk2/ovmf/OVMF_VARS.fd)
EOF2
fi
if [ -z "${AAVMF_CODE:-}" ]; then
	read -r AAVMF_CODE AAVMF_VARS <<EOF2
$(first_pair \
		"$QEMU_SHARE/edk2-aarch64-code.fd" "$QEMU_SHARE/edk2-arm-vars.fd" \
		/usr/share/AAVMF/AAVMF_CODE.fd /usr/share/AAVMF/AAVMF_VARS.fd \
		/usr/share/edk2/aarch64/QEMU_EFI.fd /usr/share/edk2/aarch64/QEMU_VARS.fd)
EOF2
fi

# x86 acceleration: KVM when /dev/kvm is usable, HVF on an Intel Mac, else
# TCG. X86_ACCEL is the -accel/-cpu pair every x86 QEMU line uses. arm64
# guests stay on TCG (this lab ran them on x86 hosts).
if [ -z "${X86_ACCEL:-}" ]; then
	if [ "$(uname -m)" = x86_64 ] && [ -r /dev/kvm ] && [ -w /dev/kvm ]; then
		X86_ACCEL="-accel kvm -cpu host"
	elif [ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = x86_64 ]; then
		X86_ACCEL="-accel hvf -cpu host"
	else
		X86_ACCEL="-accel tcg -cpu max"
	fi
fi
# Alpine linux-virt kernel + initramfs built by tikoci/netinstall (`make` on
# macOS builds them into downloads/). Its /init mounts a 9p share at /host and
# runs /host/.vm-cmd.sh, then powers off.
NI_VMLINUZ=${NI_VMLINUZ:-$HOME/GitHub/netinstall/downloads/vmlinuz-virt}
NI_INITRD=${NI_INITRD:-$HOME/GitHub/netinstall/downloads/initramfs-netinstall.gz}

mkdir -p "$WORK" "$DL"

ts() { date +%H:%M:%S; }
log() { echo "[$(ts)] $*" >&2; }

# Public MikroTik downloads used by the lab. Idempotent.
fetch_downloads() {
	mkdir -p "$DL/netinstk" "$DL/npk" "$DL/cli"
	for a in x86_64 arm64 arm64-uefi; do
		[ -s "$DL/netinstk/linux.$a" ] ||
			curl -sf -o "$DL/netinstk/linux.$a" "https://upgrade.mikrotik.com/routeros/$VER/netinstk/linux.$a"
	done
	[ -s "$DL/npk/routeros-$VER.npk" ] ||
		curl -sf -o "$DL/npk/routeros-$VER.npk" "https://download.mikrotik.com/routeros/$VER/routeros-$VER.npk"
	[ -s "$DL/npk/routeros-$VER-arm64.npk" ] ||
		curl -sf -o "$DL/npk/routeros-$VER-arm64.npk" "https://download.mikrotik.com/routeros/$VER/routeros-$VER-arm64.npk"
	if [ ! -x "$DL/cli/netinstall-cli" ]; then
		curl -sf -o "$DL/cli/netinstall-$VER.tar.gz" "https://download.mikrotik.com/routeros/$VER/netinstall-$VER.tar.gz"
		tar xzf "$DL/cli/netinstall-$VER.tar.gz" -C "$DL/cli"
	fi
}

# `dgram_pair <name> <side>` prints a -netdev value for one end of a unix
# datagram pair (side a or b), like quickchr's `socket::<name>` default.
dgram_pair() {
	name=$1 side=$2 id=${3:-n0}
	if [ "$side" = a ]; then l=$WORK/$name-a.sock r=$WORK/$name-b.sock; else l=$WORK/$name-b.sock r=$WORK/$name-a.sock; fi
	rm -f "$l"
	echo "dgram,id=$id,local.type=unix,local.path=$l,remote.type=unix,remote.path=$r"
}

# A private copy of a UEFI vars template. On arm64 `virt` both pflash units
# must be the same size, so the copy is padded to the code ROM's size there.
# x86 OVMF is split code + vars, and the vars must keep their own size: a
# padded unit 1 moves the varstore away from the address OVMF expects.
uefi_vars() {
	code=$1 vars=$2 out=$3
	cp "$vars" "$out"
	chmod u+w "$out"
	case $code in *aarch64* | *AAVMF* | *QEMU_EFI*) truncate -s "$(wc -c <"$code")" "$out" ;; esac
}

# Send one command to a QEMU HMP monitor socket (nc -U on macOS; socat or
# python3 where nc is missing or lacks -U).
hmp() {
	if command -v socat >/dev/null; then
		{ printf '%s\n' "$2"; sleep 1; } | socat - "UNIX-CONNECT:$1" >/dev/null 2>&1 || true
	elif command -v nc >/dev/null; then
		printf '%s\n' "$2" | nc -U -w 2 "$1" >/dev/null 2>&1 || true
	else
		python3 -I -c 'import socket,sys,time;s=socket.socket(socket.AF_UNIX);s.connect(sys.argv[1]);s.send(sys.argv[2].encode()+b"\n");time.sleep(1)' "$1" "$2" || true
	fi
}

kill_pidfile() {
	[ -f "$1" ] && kill "$(cat "$1")" 2>/dev/null
	rm -f "$1"
}
