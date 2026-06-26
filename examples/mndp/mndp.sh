#!/bin/sh
# mndp (CLI) — show the quickchr command that gives a CHR an L2 socket-connect NIC.
#
# NOTE: MNDP capture needs a host TCP server running BEFORE the CHR connects, plus
# length-prefixed L2 frame parsing — neither is portable shell. So the full CLI
# driver is mndp.py (Python runs the listener AND drives quickchr); this script
# only prints the `quickchr start` invocation, so the `--add-network` flag is
# discoverable. Run mndp.ts or mndp.py for an actual capture.
set -eu

. "$(dirname "$0")/../common.sh"

port="${1:-5678}"   # the host TCP listener port your capture is bound to
name="$(example_name mndp)"

cat <<EOF
To boot a CHR with ether1=user (mgmt) + ether2=socket-connect to a host
listener on 127.0.0.1:$port, run (with your listener already up):

  ${QUICKCHR} start $name \\
      --channel stable --no-secure-login \\
      --add-network user \\
      --add-network socket:connect:$port

Then set a known identity and ensure discovery:

  ${QUICKCHR} exec $name "/system/identity/set name=mndp-example"
  ${QUICKCHR} exec $name "/ip/neighbor/discovery-settings/set discover-interface-list=all"

For a runnable end-to-end capture, use:  bun run mndp.ts   or   uv run mndp.py
EOF
