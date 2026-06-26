#!/bin/sh
# udp-gateway (CLI) — set up guest→host UDP via the SLIRP gateway (10.0.2.2).
#
# NOTE: the RECEIVE side needs an *unconnected* host UDP socket, which can't be
# expressed in portable shell — run udp-gateway.ts (or your own listener) for that.
# This script shows only the RouterOS-side CLI: point remote syslog at the gateway.
#
# Usage: sh udp-gateway.sh [host-port]   (default 15140; must match your listener)
set -eu

. "$(dirname "$0")/../common.sh"

name="$(example_name udp-gateway)"
register_cleanup "$name"
port="${1:-15140}"

qc start "$name" --channel stable --no-secure-login --mem 256

# Logging action names must be alphanumeric (no hyphens).
qc exec "$name" \
	"/system/logging/action/add name=qchrgw target=remote remote=10.0.2.2 remote-port=$port"
qc exec "$name" "/system/logging/add action=qchrgw topics=info"
qc exec "$name" ':log info "hello-from-guest"'

echo "Sent syslog to 10.0.2.2:$port."
echo "Receive it with an UNCONNECTED UDP socket bound to $port (see udp-gateway.ts)."
