#!/bin/sh
# cspell:ignore pxeni QCHRPXE varstore netcat
# shellcheck disable=SC2034  # OVMF_*, AAVMF_*, X86_ACCEL are used by the scripts that source this file
# Shared settings for the PXE / netinstall lab (quickchr#329).
# Source it: `. test/lab/pxe-netinstall/lib.sh`. Nothing here needs root.
#
# WORK holds run state: disks, pcaps, serial logs and the unix sockets for
# the dgram links. Keep it short: a socket path over 104 bytes (macOS) makes
# QEMU refuse to start. Runs are not isolated from each other: two runs with
# the same WORK and run name share files, so run one experiment at a time per
# WORK. Each script's cleanup stops only the processes it started itself.

VER=${VER:-7.25.2}
WORK=${WORK:-/tmp/pxeni}
CACHE=${CACHE:-$HOME/.local/share/quickchr/cache}
# Downloads (netinstk boot images, routeros-*.npk, netinstall-cli) live here,
# one directory per VER so a run never mixes components from two versions.
DL=${DL:-$WORK/dl/$VER}
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

# `fetch <url> <file>`: download once. curl writes to a temporary name unique
# to this shell (<file>.part.<pid>), renamed only after a complete transfer, so
# a failed or concurrent download never leaves or clobbers a cached file.
fetch() {
	[ -s "$2" ] && return 0
	if curl -sf -o "$2.part.$$" "$1"; then
		mv "$2.part.$$" "$2"
	else
		rm -f "$2.part.$$"
		return 1
	fi
}

# Public MikroTik downloads used by the lab. Idempotent.
fetch_downloads() {
	mkdir -p "$DL/netinstk" "$DL/npk" "$DL/cli"
	for a in x86_64 arm64 arm64-uefi; do
		fetch "https://upgrade.mikrotik.com/routeros/$VER/netinstk/linux.$a" "$DL/netinstk/linux.$a"
	done
	fetch "https://download.mikrotik.com/routeros/$VER/routeros-$VER.npk" "$DL/npk/routeros-$VER.npk"
	fetch "https://download.mikrotik.com/routeros/$VER/routeros-$VER-arm64.npk" "$DL/npk/routeros-$VER-arm64.npk"
	if [ ! -x "$DL/cli/netinstall-cli" ]; then
		fetch "https://download.mikrotik.com/routeros/$VER/netinstall-$VER.tar.gz" "$DL/cli/netinstall-$VER.tar.gz"
		# Unpack into a private directory, then rename the binary into place,
		# so a concurrent run never sees a half-written netinstall-cli.
		unpack_dir=$(mktemp -d "$DL/cli/.unpack.XXXXXX")
		tar xzf "$DL/cli/netinstall-$VER.tar.gz" -C "$unpack_dir"
		mv "$unpack_dir/netinstall-cli" "$DL/cli/netinstall-cli"
		rm -rf "${unpack_dir:?}"
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

# Send one command to a QEMU HMP monitor socket: socat, else an nc that
# supports -U (macOS, OpenBSD nc; GNU netcat does not), else python3.
hmp() {
	if command -v socat >/dev/null; then
		{ printf '%s\n' "$2"; sleep 1; } | socat - "UNIX-CONNECT:$1" >/dev/null 2>&1 || true
	elif command -v nc >/dev/null && nc -h 2>&1 | grep -q -- '-U'; then
		printf '%s\n' "$2" | nc -U -w 2 "$1" >/dev/null 2>&1 || true
	else
		python3 -I -c 'import socket,sys,time;s=socket.socket(socket.AF_UNIX);s.connect(sys.argv[1]);s.send(sys.argv[2].encode()+b"\n");time.sleep(1)' "$1" "$2" || true
	fi
}

# Stop the process named in a pidfile. The process may already be gone (QEMU
# with -no-reboot exits on its own), so a failed kill is expected, not an error.
kill_pidfile() {
	if [ -f "$1" ]; then kill "$(cat "$1" 2>/dev/null)" 2>/dev/null || true; fi
	rm -f "$1" || true
}

# The pid files this invocation started: `own <pidfile>` right before launching the
# process that writes it, `stop_owned` in the EXIT trap. A pidfile that another
# run wrote is never touched.
owned=""
own() { owned="$owned $1"; }
stop_owned() {
	for f in $owned; do kill_pidfile "$f"; done
	owned=""
}

# Stop a background process and its direct children (a `sh script.sh &` whose
# script runs QEMU or netinstall-cli in the foreground). The children are
# listed first, because once the parent exits they move to a new parent and
# `pkill -P` would miss them. The parent is signalled before the children, so
# a parent with its own TERM trap (ni-server.sh native mode) gets to run it.
# With KILL as $2, sends SIGKILL instead. Empty pid: no-op.
kill_tree() {
	[ -n "${1:-}" ] || return 0
	kt_sig=${2:-TERM}
	kt_kids=$(pgrep -P "$1" 2>/dev/null || true)
	kill -s "$kt_sig" "$1" 2>/dev/null || true
	for kt_k in $kt_kids; do kill -s "$kt_sig" "$kt_k" 2>/dev/null || true; done
}

# `run_bounded <seconds> <command...>`: run a command in the background and
# wait for it, but stop it (and its children) after <seconds>: TERM, then KILL
# after 5 s more. Returns the command's status, or 124 on timeout, like GNU
# timeout, which macOS does not ship. While it runs, rb_pid holds its pid, so
# an EXIT trap can `kill_tree "$rb_pid"`; rb_pid is cleared once reaped.
rb_pid=""
run_bounded() {
	rb_limit=$1; shift
	"$@" &
	rb_pid=$!
	rb_end=$(( $(date +%s) + rb_limit ))
	while kill -0 "$rb_pid" 2>/dev/null; do
		if [ "$(date +%s)" -ge "$rb_end" ]; then
			log "timeout after ${rb_limit}s: $*"
			kill_tree "$rb_pid"
			rb_grace=$(( $(date +%s) + 5 ))
			while kill -0 "$rb_pid" 2>/dev/null && [ "$(date +%s)" -lt "$rb_grace" ]; do sleep 1; done
			kill_tree "$rb_pid" KILL
			wait "$rb_pid" 2>/dev/null || true
			rb_pid=""
			return 124
		fi
		sleep 1
	done
	rb_rc=0
	wait "$rb_pid" || rb_rc=$?
	rb_pid=""
	return "$rb_rc"
}
