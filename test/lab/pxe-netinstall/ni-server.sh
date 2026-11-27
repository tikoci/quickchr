#!/bin/sh
# Linux netinstall-cli as the server, inside an Alpine QEMU VM (no root, no vmnet).
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

cat >"$share/.vm-cmd.sh" <<EOF
ip addr flush dev eth0
ip addr add 192.168.88.1/24 dev eth0
cd /host
echo "netinstall-cli start \$(date)"
./netinstall-cli -v $opts -a 192.168.88.2 $pkgs 2>&1
echo "netinstall-cli exit \$? \$(date)"
EOF

log "netinstall-cli VM on link '$link': opts=[$opts] pkgs=[$pkgs]"
exec qemu-system-x86_64 -M q35 -accel hvf -cpu host -m 512 -smp 2 \
	-kernel "$NI_VMLINUZ" -initrd "$NI_INITRD" -append "console=ttyS0 quiet" \
	-virtfs "local,path=$share,mount_tag=hostfs,security_model=none" \
	-netdev "$(dgram_pair "$link" a)" \
	-device virtio-net-pci,netdev=n0,mac=02:00:00:00:00:01,romfile= \
	-object "filter-dump,id=f0,netdev=n0,file=$WORK/ni-$link.pcap" \
	-display none -serial "file:$WORK/ni-$link.serial.log" -no-reboot
