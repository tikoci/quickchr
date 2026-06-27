#!/usr/bin/env python3
"""version-matrix — parallel RouterOS version matrix (Python / quickchr CLI driver).

Boots one CHR per RouterOS channel in parallel, installs an extra package on each,
prints a version matrix, and diffs each router's `:export` to surface config drift
across versions.

Uses ONLY the quickchr CLI (no raw scp/ssh/urllib) — quickchr's `exec` carries
`:export` and `:put`, so the old SSH/SCP path is gone. (The library sibling
version-matrix.ts additionally uploads the sample config via `upload()`; the CLI
has no file-transfer command yet — see the README's "friction found".)

Run:  uv run version-matrix.py [--lite] [--no-cleanup]
      (uv is preferred over a venv; this script is stdlib-only.)
"""

import argparse
import os
import subprocess
import sys
import threading

CHANNELS = ["long-term", "stable", "testing", "development"]
LITE_CHANNELS = ["long-term", "stable"]

# quickchr resolution: $QUICKCHR (e.g. "bun run ../../src/cli/index.ts --") else installed.
QC = os.environ["QUICKCHR"].split() if os.environ.get("QUICKCHR") else ["quickchr"]
PID = os.getpid()


def name_for(channel: str) -> str:
    # Parallel-safe, prefix-scoped (examples-<slug>-<unique>).
    return f"examples-vm-{channel.replace('-', '')}-{PID:x}"


def run(*args: str, check: bool = True) -> str:
    r = subprocess.run([*QC, *args], capture_output=True, text=True)
    if check and r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or f"quickchr {args[0]} exit {r.returncode}")
    return r.stdout


def start(channel: str, port_base: int, pkg: str, errors: dict) -> None:
    try:
        run("start", name_for(channel),
            "--channel", channel, "--no-secure-login",
            "--port-base", str(port_base), "--add-package", pkg, "--mem", "256")
        print(f"  [ready] {name_for(channel)}")
    except Exception as e:  # noqa: BLE001
        errors[channel] = str(e)
        print(f"  [error] {channel}: {e}", file=sys.stderr)


def export_of(channel: str) -> str:
    # `:export` over /rest/execute — no SSH needed.
    return run("exec", name_for(channel), ":export", check=False)


def version_of(channel: str) -> str:
    return run("exec", name_for(channel), ":put [/system/resource/get version]", check=False).strip()


def main() -> int:
    ap = argparse.ArgumentParser(description="parallel RouterOS version matrix")
    ap.add_argument("--lite", action="store_true", help="only long-term + stable (CI-friendly)")
    ap.add_argument("--no-cleanup", action="store_true", help="leave instances running")
    args = ap.parse_args()

    channels = LITE_CHANNELS if args.lite else CHANNELS
    # container is available on both arches; a portable, always-present extra.
    pkg = "container"
    print(f"\nversion-matrix: starting {len(channels)} CHRs in parallel ({', '.join(channels)})\n")

    # Distinct port bases keep parallel starts from racing for the same block.
    bases = {ch: 9200 + i * 10 for i, ch in enumerate(channels)}
    errors: dict[str, str] = {}
    threads = [threading.Thread(target=start, args=(ch, bases[ch], pkg, errors)) for ch in channels]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    started = [ch for ch in channels if ch not in errors]
    if not started:
        print("No instances started.", file=sys.stderr)
        return 1

    try:
        print("\nRouterOS version matrix:")
        for ch in started:
            print(f"  {ch:<14} → {version_of(ch)}")

        print("\nConfig drift (default :export across versions)…")
        exports = {ch: export_of(ch) for ch in started}
        baseline = started[0]
        base_lines = {
            ln.strip() for ln in exports[baseline].splitlines()
            if ln.strip() and not ln.strip().startswith("#")
        }
        for ch in started[1:]:
            cur = {
                ln.strip() for ln in exports[ch].splitlines()
                if ln.strip() and not ln.strip().startswith("#")
            }
            added, removed = cur - base_lines, base_lines - cur
            if added or removed:
                print(f"  {baseline} → {ch}:  +{len(added)} / -{len(removed)} lines")
            else:
                print(f"  {baseline} → {ch}:  identical")
    finally:
        if args.no_cleanup:
            print("\n--no-cleanup: instances left running:")
            for ch in started:
                print(f"  {name_for(ch)}  (port-base {bases[ch]})")
        else:
            for ch in started:
                run("remove", name_for(ch), check=False)
            print("\nremoved all instances")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
