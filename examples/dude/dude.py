#!/usr/bin/env python3
"""dude (CLI driver) — install the dude package on first boot, enable it, read it back.

The Python/CLI sibling of dude.ts. Drives the `quickchr` CLI via subprocess: the
library shows `installPackage()` (post-boot); the CLI installs at first boot via
`--add-package` (there is no post-boot "install on a running machine" CLI command
yet — see the example README's "friction found"). Works on x86 and arm64.

Run:  uv run examples/dude/dude.py [--channel stable] [--no-cleanup]
      (uv is preferred over a venv; this script is stdlib-only.)
"""

import argparse
import os
import random
import subprocess
import sys


def example_name(slug: str) -> str:
    return f"examples-{slug}-{os.getpid():x}{random.randint(0, 0xFFFF):x}"


def main() -> int:
    ap = argparse.ArgumentParser(description="install + enable the dude package on a CHR")
    ap.add_argument("--channel", default="stable")
    ap.add_argument("--no-cleanup", action="store_true", help="leave the CHR running")
    ap.add_argument(
        "--quickchr",
        help='override the quickchr command, e.g. "bun run ../../src/cli/index.ts --"',
    )
    args = ap.parse_args()

    # Resolve quickchr: explicit override, else env, else the installed binary.
    if args.quickchr:
        qc = args.quickchr.split()
    elif os.environ.get("QUICKCHR"):
        qc = os.environ["QUICKCHR"].split()
    else:
        qc = ["quickchr"]

    name = example_name("dude")

    def run(*cli: str) -> str:
        out = subprocess.run([*qc, *cli], capture_output=True, text=True)
        if out.returncode != 0:
            sys.stderr.write(out.stderr)
            raise SystemExit(f"quickchr {cli[0]} failed (exit {out.returncode})")
        return out.stdout

    print(f"→ starting {name} with --add-package dude (downloads + reboots once)…")
    run("start", name, "--channel", args.channel, "--no-secure-login",
        "--add-package", "dude", "--mem", "256")
    try:
        run("exec", name, "/dude/set enabled=yes")
        print(run("exec", name, "/dude/print"))
    finally:
        if not args.no_cleanup:
            run("remove", name)
        else:
            print(f"--no-cleanup: '{name}' left running")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
