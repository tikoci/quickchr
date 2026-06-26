#!/bin/sh
# Lint example shell scripts as POSIX sh. Skips gracefully when shellcheck is
# absent (local dev); CI installs it. SC1091 (can't follow sourced common.sh) is
# info-level and excluded by --severity=warning.
set -eu

if ! command -v shellcheck >/dev/null 2>&1; then
	echo "shellcheck not installed — skipping (CI installs it)"
	exit 0
fi

find examples -name '*.sh' -print0 | xargs -0 shellcheck -s sh --severity=warning
echo "✓ shellcheck: example .sh scripts are clean POSIX sh"
