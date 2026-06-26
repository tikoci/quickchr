#!/bin/sh
# Shared helpers for quickchr CLI examples (POSIX sh).
#
# Source this at the top of an example's <name>.sh:
#   . "$(dirname "$0")/../common.sh"
#
# Provides:
#   $QUICKCHR              how to invoke quickchr (override via the env var)
#   qc ...                 run quickchr
#   example_name <slug>    print  examples-<slug>-<unique>  (parallel-safe)
#   free_port              print a free TCP port (never hard-code a host port)
#   register_cleanup <name>  reap that machine on EXIT/INT/TERM (Ctrl-C + errors)
#
# Resolution rule: prefer an explicit $QUICKCHR override, else the repo source
# CLI (so CI and local runs exercise THIS checkout, not a stale global install),
# else a globally installed `quickchr`.

# Resolve the quickchr invocation once.
if [ -z "${QUICKCHR:-}" ]; then
	_qc_repo_cli="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)/src/cli/index.ts"
	if [ -f "$_qc_repo_cli" ] && command -v bun >/dev/null 2>&1; then
		QUICKCHR="bun run $_qc_repo_cli"
	else
		QUICKCHR="quickchr"
	fi
fi

qc() {
	# Word-splitting $QUICKCHR is intentional (it may be "bun run …/index.ts").
	# shellcheck disable=SC2086
	$QUICKCHR "$@"
}

example_name() {
	printf 'examples-%s-%s%s\n' "$1" "$$" \
		"$(awk 'BEGIN { srand(); printf "%x", int(rand() * 65536) }')"
}

free_port() {
	if command -v bun >/dev/null 2>&1; then
		bun -e 'const s=Bun.listen({hostname:"127.0.0.1",port:0,socket:{data(){}}});console.log(s.port);s.stop()'
	else
		# Fallback: pick from the ephemeral range (small race, fine for examples).
		awk 'BEGIN { srand(); print int(20000 + rand() * 20000) }'
	fi
}

_QC_CLEANUP=""
register_cleanup() {
	_QC_CLEANUP="$_QC_CLEANUP $1"
}

_qc_cleanup() {
	# shellcheck disable=SC2086  # intentional word-split over the name list
	for _qc_name in $_QC_CLEANUP; do
		qc remove "$_qc_name" >/dev/null 2>&1 || true
	done
}

trap _qc_cleanup EXIT INT TERM
