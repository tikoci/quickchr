#!/bin/sh
# service-forward (CLI) — pin a guest service to a chosen host port with --forward.
set -eu

. "$(dirname "$0")/../common.sh"

name="$(example_name service-forward)"
register_cleanup "$name"
port="$(free_port)"   # allocate a free host port; never hard-code one

echo "→ forwarding guest WinBox (8291) to host port $port"
qc start "$name" --channel stable --no-secure-login --mem 256 --forward "winbox:$port"

echo "→ inspect shows the mapping:"
qc inspect "$name"

# Optional reachability probe if nc is available:
if command -v nc >/dev/null 2>&1; then
	if nc -z -w 5 127.0.0.1 "$port"; then
		echo "→ TCP connect to 127.0.0.1:$port OK"
	else
		echo "→ TCP connect to 127.0.0.1:$port failed"
	fi
fi
