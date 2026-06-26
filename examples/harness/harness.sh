#!/bin/sh
# harness (CLI) — hand a CHR's connection env to an external tool, no machine.json.
# `quickchr env <name>` prints shell-quoted KEY=value lines; `set -a` exports them
# so the child process inherits URLBASE / BASICAUTH.
set -eu

. "$(dirname "$0")/../common.sh"

name="$(example_name harness)"
register_cleanup "$name"

# secureLogin (the default) → a managed user with a real password.
qc start "$name" --channel stable --mem 256

echo "→ connection env for $name:"
qc env "$name"

echo "→ running the external tool (tool/child.ts) with that env:"
set -a
eval "$(qc env "$name")"
set +a
bun run "$(dirname "$0")/tool/child.ts"
