#!/bin/sh
# cspell:ignore pxeni QCHRPXE
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

# Raw vars file padded to the code ROM's size (pflash units must match).
uefi_vars() {
	code=$1 vars=$2 out=$3
	cp "$vars" "$out"
	size=$(stat -f %z "$code" 2>/dev/null || stat -c %s "$code")
	truncate -s "$size" "$out"
}

# Send one command to a QEMU HMP monitor socket.
hmp() {
	printf '%s\n' "$2" | nc -U -w 2 "$1" >/dev/null 2>&1 || true
}

kill_pidfile() {
	[ -f "$1" ] && kill "$(cat "$1")" 2>/dev/null
	rm -f "$1"
}
