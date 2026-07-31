#!/bin/sh
# Resource sampler for the B7 (#76) full-suite trend measurement — macOS only.
#
# Emits one NDJSON record per tick to stdout. Runs until killed. It reads the
# currently-executing test file from a marker file that run.sh rewrites before
# each `bun test`, so every sample is attributable to a file rather than to a
# wall-clock guess.
#
# Deliberately shell + sysctl/vm_stat rather than a Bun helper: the sampler must
# stay alive and cheap while the thing it measures is the machine's resource
# state. A Bun process would add its own heap to the quantity under measurement.

set -eu

INTERVAL="${1:-5}"
MARKER="${2:?usage: sample.sh <interval_s> <current-file-marker>}"

PAGE=$(sysctl -n hw.pagesize)
DATA_VOL=/System/Volumes/Data

while :; do
	NOW=$(date +%s)

	# vm.loadavg prints "{ 7.60 5.65 5.02 }" — field 2 is the 1-minute average.
	LOAD1=$(sysctl -n vm.loadavg | awk '{print $2}')

	# 1 = normal, 2 = warn, 4 = critical. The kernel's own verdict, which is what
	# a hosted runner's supervisor would react to before the runner disappears.
	PRESSURE=$(sysctl -n kern.memorystatus_vm_pressure_level 2>/dev/null || echo 0)

	# free + inactive is the honest "reclaimable" figure on macOS; compressor
	# pages are tracked separately because a steady climb there is the signature
	# of accumulation that free-page counts alone hide.
	# awk emits four plain numbers and `read` consumes them, rather than awk
	# emitting shell assignments for `eval`. vm_stat's output is not attacker-
	# controlled, so the eval form was not exploitable — but it is a pattern that
	# becomes an injection point the moment someone copies it onto a source that
	# is, and static analysis flags it as CWE-78 either way.
	VM_LINE=$(vm_stat | awk -v p="$PAGE" '
		/Pages free/             {gsub(/\./,"",$3); f=$3*p/1048576}
		/Pages inactive/         {gsub(/\./,"",$3); ia=$3*p/1048576}
		/Pages wired down/       {gsub(/\./,"",$4); w=$4*p/1048576}
		/occupied by compressor/ {gsub(/\./,"",$5); c=$5*p/1048576}
		END                      {printf "%d %d %d %d", f, ia, w, c}
	')
	read -r VM_FREE VM_INACTIVE VM_WIRED VM_COMPRESSED <<-EOF
		$VM_LINE
	EOF

	# "total = 3072.00M  used = 1671.00M  free = 1401.00M  (encrypted)"
	#   $1=total $2== $3=3072.00M $4=used $5== $6=1671.00M — used is $6, not $7.
	SWAP_USED=$(sysctl -n vm.swapusage | awk '{gsub(/M/,"",$6); print $6+0}')

	QEMU_N=$(pgrep -f 'qemu-system' 2>/dev/null | wc -l | tr -d ' ')
	QEMU_RSS=$(ps -Ao rss,command 2>/dev/null | awk '/[q]emu-system/ {s+=$1} END {printf "%d", s/1024}')

	DISK_FREE=$(df -k "$DATA_VOL" | awk 'NR==2 {printf "%d", $4/1024}')

	# Escape for a JSON string literal. Today the marker only ever holds a test
	# filename or a "(…)" sentinel, but a torn line would be dropped SILENTLY by
	# analyze.ts's parser — an invalid sample is indistinguishable from a missing
	# one, which is the failure mode this whole lab exists to avoid.
	FILE=$(cat "$MARKER" 2>/dev/null || echo "")
	FILE=$(printf '%s' "$FILE" | tr -d '\n\r\t' | sed 's/\\/\\\\/g; s/"/\\"/g')

	printf '{"ts":%s,"file":"%s","load1":%s,"pressure":%s,"free_mb":%s,"inactive_mb":%s,"wired_mb":%s,"compressed_mb":%s,"swap_used_mb":%s,"qemu_procs":%s,"qemu_rss_mb":%s,"disk_free_mb":%s}\n' \
		"$NOW" "$FILE" "$LOAD1" "$PRESSURE" "$VM_FREE" "$VM_INACTIVE" "$VM_WIRED" \
		"$VM_COMPRESSED" "$SWAP_USED" "$QEMU_N" "$QEMU_RSS" "$DISK_FREE"

	sleep "$INTERVAL"
done
