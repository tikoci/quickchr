#!/bin/sh
# cspell:ignore tapbridge
# Linux netinstall-cli as the server, inside an Alpine QEMU VM (no root, no vmnet).
# Without that VM (NI_VMLINUZ missing) on a Linux host, or with NI_MODE=native,
# netinstall-cli runs on the host instead, inside an unprivileged user + network
# namespace (`unshare -rn`) whose TAP device tapbridge.py joins to the link.
# Still no root and no host network changes.
#
#   ni-server.sh <link-name> [netinstall-cli options...] -- [packages...]
#
# The VM's only NIC is side "a" of a unix dgram pair named <link-name>; the
# target VM takes side "b". The VM gets 192.168.88.1/24 and runs, as root
# inside the guest:  netinstall-cli -v <options> -a 192.168.88.2 <packages>
# Packages default to routeros-$VER.npk; NI_FILES lists extra files to copy
# into the share (e.g. the .rsc for -s / -sm). Output: $WORK/ni-<link>.serial.log,
# $WORK/ni-<link>.pcap. Runs in the foreground; the VM powers off when
# netinstall-cli exits.
set -eu
. "$(dirname "$0")/lib.sh"

link=$1; shift
opts=""
while [ $# -gt 0 ] && [ "$1" != "--" ]; do opts="$opts $1"; shift; done
[ "${1:-}" = "--" ] && shift
pkgs=${*:-routeros-$VER.npk}

fetch_downloads
share=$WORK/share-$link
mkdir -p "$share"
cp "$DL/cli/netinstall-cli" "$share/"
cp "$DL"/npk/*.npk "$share/"
# Extra files (scripts for -s / -sm) named in NI_FILES land next to the packages.
for f in ${NI_FILES:-}; do cp "$f" "$share/"; done

mode=${NI_MODE:-}
if [ -z "$mode" ]; then
	if [ -r "$NI_VMLINUZ" ] && [ -r "$NI_INITRD" ]; then mode=vm; else mode=native; fi
fi
# The Alpine VM sees the share at /host and its NIC as eth0; native mode
# runs in the share directory with the TAP named ni0.
if [ "$mode" = native ]; then dev=ni0 dir=$share; else dev=eth0 dir=/host; fi
cat >"$share/.vm-cmd.sh" <<EOF
ip addr flush dev $dev
ip addr add 192.168.88.1/24 dev $dev
cd $dir
echo "netinstall-cli start \$(date)"
# exec: netinstall-cli replaces this shell, so in native mode it is a direct
# child of the namespace shell, which stops it.
exec ./netinstall-cli -v $opts -a 192.168.88.2 $pkgs 2>&1
EOF

if [ "$mode" = native ]; then
	log "netinstall-cli native (unshare -rn) on link '$link': opts=[$opts] pkgs=[$pkgs]"
	rm -f "$WORK/ni-$link.serial.log"
	# The script runs as namespace root. The serial.log name matches the VM
	# mode so the experiments can grep either.
	# shellcheck disable=SC2016  # expanded by the inner shell
	exec unshare -rn sh -c '
		here=$1 share=$2 work=$3 link=$4
		# This shell owns cleanup of everything below, and everything below is
		# its direct child (.vm-cmd.sh execs netinstall-cli), so stop() finds
		# them all with pgrep -P, including one started a moment ago. The trap
		# is set before anything starts.
		ni="" dump="" bridge=""
		stop() {
			kids=$(pgrep -P $$ 2>/dev/null)
			kill $kids 2>/dev/null
			sleep 1
			kill -9 $kids 2>/dev/null
		}
		trap "stop; exit 143" TERM INT
		python3 -I "$here/tapbridge.py" ni0 "$work/$link-a.sock" "$work/$link-b.sock" &
		bridge=$!
		# tapbridge.py creates ni0; give up if it exits first (no /dev/net/tun,
		# say) or ni0 is not there after 10 s.
		n=0
		while ! ip link show ni0 >/dev/null 2>&1; do
			kill -0 $bridge 2>/dev/null || { echo "tapbridge.py exited before ni0 appeared" >&2; exit 1; }
			n=$((n + 1))
			[ $n -le 100 ] || { echo "ni0 not up after 10 s" >&2; stop; exit 1; }
			sleep 0.1
		done
		ip link set lo up
		ip link set ni0 address 02:00:00:00:00:01 up
		tcpdump -q -i ni0 -U -w "$work/ni-$link.pcap" 2>/dev/null &
		dump=$!
		sh "$share/.vm-cmd.sh" >"$work/ni-$link.serial.log" 2>&1 &
		ni=$!
		rc=0
		wait $ni || rc=$?
		echo "netinstall-cli exit $rc $(date)" >>"$work/ni-$link.serial.log"
		kill $dump $bridge 2>/dev/null
		exit $rc
	' sh "$(cd "$(dirname "$0")" && pwd)" "$share" "$WORK" "$link"
fi
log "netinstall-cli VM on link '$link': opts=[$opts] pkgs=[$pkgs]"
# shellcheck disable=SC2086  # X86_ACCEL is "-accel <a> -cpu <c>"
exec qemu-system-x86_64 -M q35 $X86_ACCEL -m 512 -smp 2 \
	-kernel "$NI_VMLINUZ" -initrd "$NI_INITRD" -append "console=ttyS0 quiet" \
	-virtfs "local,path=$share,mount_tag=hostfs,security_model=none" \
	-netdev "$(dgram_pair "$link" a)" \
	-device virtio-net-pci,netdev=n0,mac=02:00:00:00:00:01,romfile= \
	-object "filter-dump,id=f0,netdev=n0,file=$WORK/ni-$link.pcap" \
	-display none -serial "file:$WORK/ni-$link.serial.log" -no-reboot
