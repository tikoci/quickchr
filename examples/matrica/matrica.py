#!/usr/bin/env python3
"""
matrica — Parallel Version Matrix (Python / subprocess CLI)

Starts 4 ARM64 CHR instances in parallel using the quickchr CLI,
installs zerotier + container packages, and compares output across versions.

Usage:
    python3 matrica.py [--lite] [--no-cleanup]

Options:
    --lite        Run only long-term + stable (faster, CI-friendly on x86)
    --no-cleanup  Keep instances running after completion (for manual inspection)

Requirements:
    - quickchr installed (bun run dev -- or bun install -g @tikoci/quickchr)
    - ARM64 QEMU available (qemu-system-aarch64)
    - EFI firmware for arm64 (see: quickchr doctor)
    - ssh / scp in PATH (for config upload + export steps)

ikoci/restraml use case:
    Run with --no-cleanup, then connect to each instance's port base + 0
    (HTTP) to run /console/inspect tree extraction for full ARM64 package schema.

    Port map (default):
      long-term   → http://127.0.0.1:9200  ssh port 9202
      stable      → http://127.0.0.1:9210  ssh port 9212
      testing     → http://127.0.0.1:9220  ssh port 9222
      development → http://127.0.0.1:9230  ssh port 9232
"""

import argparse
import json
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Optional

SCRIPT_DIR = Path(__file__).parent
CONFIG_RSC = SCRIPT_DIR / "rb5009-arm64.rsc"

CHANNELS = ["long-term", "stable", "testing", "development"]
LITE_CHANNELS = ["long-term", "stable"]

PORT_BASES = {
    "long-term": 9200,
    "stable": 9210,
    "testing": 9220,
    "development": 9230,
}

ARM64_PACKAGES = ["zerotier", "container"]

SSH_OPTS = [
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "LogLevel=ERROR",
    "-o", "ConnectTimeout=10",
]


def machine_name(channel: str) -> str:
    return f"matrica-{channel.replace('-', '')}"


def run_quickchr(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    """Run a quickchr CLI command and return the result."""
    cmd = ["quickchr", *args]
    return subprocess.run(cmd, capture_output=True, text=True, check=check)


def start_instance(channel: str, results: dict, errors: dict) -> None:
    """Start a single CHR instance (runs in a thread)."""
    name = machine_name(channel)
    port_base = PORT_BASES[channel]
    pkgs = ",".join(ARM64_PACKAGES)

    print(f"  [start] {name} (channel={channel}, port-base={port_base})")

    try:
        run_quickchr(
            "start", name,
            "--channel", channel,
            "--arch", "arm64",
            "--port-base", str(port_base),
            "--packages", pkgs,
        )
        results[channel] = {"name": name, "port_base": port_base}
        print(f"  [ready] {name}")
    except subprocess.CalledProcessError as e:
        errors[channel] = e.stderr.strip()
        print(f"  [error] {name}: {e.stderr.strip()}", file=sys.stderr)


def stop_instance(channel: str) -> None:
    """Stop and remove a CHR instance."""
    name = machine_name(channel)
    run_quickchr("stop", name, check=False)
    run_quickchr("remove", "--force", name, check=False)


def rest_get(http_port: int, path: str, timeout: int = 10) -> Optional[list | dict]:
    """Call the RouterOS REST API and return parsed JSON."""
    import urllib.request
    import urllib.error
    import base64

    url = f"http://127.0.0.1:{http_port}/rest{path}"
    creds = base64.b64encode(b"admin:").decode()
    req = urllib.request.Request(url, headers={"Authorization": f"Basic {creds}"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except (urllib.error.URLError, OSError):
        return None


def wait_for_boot(http_port: int, timeout_s: int = 180) -> bool:
    """Poll HTTP until RouterOS responds."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        result = rest_get(http_port, "/system/resource", timeout=3)
        if result is not None:
            return True
        time.sleep(2)
    return False


def scp_upload(ssh_port: int, local_path: Path, remote_name: str) -> None:
    """Upload a local file to RouterOS flash via SCP."""
    subprocess.run(
        [
            "scp", *SSH_OPTS,
            "-P", str(ssh_port),
            str(local_path),
            f"admin@127.0.0.1:/{remote_name}",
        ],
        check=True,
        capture_output=True,
    )


def ssh_exec(ssh_port: int, command: str) -> str:
    """Run a RouterOS CLI command via SSH and return stdout."""
    result = subprocess.run(
        ["ssh", *SSH_OPTS, "-p", str(ssh_port), "admin@127.0.0.1", command],
        capture_output=True,
        text=True,
        check=False,
    )
    return result.stdout


def rest_post(http_port: int, path: str, body: dict) -> None:
    """POST to RouterOS REST API (fire and forget — reset-configuration closes connection)."""
    import urllib.request
    import urllib.error
    import base64

    url = f"http://127.0.0.1:{http_port}/rest{path}"
    creds = base64.b64encode(b"admin:").decode()
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        url, data=data, method="POST",
        headers={"Authorization": f"Basic {creds}", "Content-Type": "application/json"},
    )
    try:
        urllib.request.urlopen(req, timeout=5)
    except OSError:
        pass  # reset-configuration closes the connection mid-request — that's expected


def main() -> None:
    parser = argparse.ArgumentParser(description="matrica — parallel RouterOS version matrix")
    parser.add_argument("--lite", action="store_true", help="Run only long-term + stable")
    parser.add_argument("--no-cleanup", action="store_true", help="Keep instances running after completion")
    args = parser.parse_args()

    channels = LITE_CHANNELS if args.lite else CHANNELS
    print(f"\nmatrica: starting {len(channels)} ARM64 CHR instances in parallel")
    print(f"  channels: {', '.join(channels)}")
    print(f"  packages: {', '.join(ARM64_PACKAGES)}\n")

    # --- Step 1: Pre-cleanup stale instances ---
    print("Cleaning up any stale instances...")
    for ch in channels:
        stop_instance(ch)

    # --- Step 2: Start all instances in parallel ---
    print(f"\nStarting {len(channels)} CHRs in parallel...")
    results: dict[str, dict] = {}
    errors: dict[str, str] = {}
    threads = [
        threading.Thread(target=start_instance, args=(ch, results, errors))
        for ch in channels
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    if errors:
        print(f"\nFailed to start {len(errors)} instance(s):")
        for ch, err in errors.items():
            print(f"  {ch}: {err}")
        if not results:
            sys.exit(1)

    # --- Step 3: Verify REST API + gather system info ---
    print("\nWaiting for REST API on all instances...")
    version_info: dict[str, dict] = {}
    for channel in channels:
        if channel not in results:
            continue
        port_base = PORT_BASES[channel]
        http_port = port_base  # offset 0 = HTTP

        booted = wait_for_boot(http_port, timeout_s=180)
        if not booted:
            print(f"  [timeout] {machine_name(channel)} did not boot in time")
            continue

        resource = rest_get(http_port, "/system/resource")
        pkgs = rest_get(http_port, "/system/package") or []

        version_info[channel] = {
            "version": resource.get("version", "?") if resource else "?",
            "arch": resource.get("architecture", "?") if resource else "?",
            "packages": [p["name"] for p in pkgs if p.get("disabled") != "true"],
        }

    # --- Step 4: Print comparison table ---
    print("\nRouterOS version matrix:")
    print(f"  {'channel':<14}  {'version':<12}  {'arch':<8}  extras")
    print(f"  {'-'*14}  {'-'*12}  {'-'*8}  -----")
    for channel in channels:
        if channel not in version_info:
            print(f"  {channel:<14}  (no data)")
            continue
        info = version_info[channel]
        extras = [p for p in info["packages"] if p not in ("routeros", "system")]
        print(f"  {channel:<14}  {info['version']:<12}  {info['arch']:<8}  [{', '.join(extras)}]")

    # Warn if ARM64-only packages are missing
    for channel, info in version_info.items():
        for pkg in ARM64_PACKAGES:
            if pkg not in info["packages"]:
                print(f"\n  [warn] {machine_name(channel)}: '{pkg}' not in active packages")

    # --- Step 5: Config upload + reset + export + diff ---
    if CONFIG_RSC.exists():
        print("\nConfig drift check (upload → reset → export → diff)...")
        exports: dict[str, str] = {}

        for channel in channels:
            if channel not in version_info:
                continue

            port_base = PORT_BASES[channel]
            http_port = port_base
            ssh_port = port_base + 2  # offset 2 = SSH

            name = machine_name(channel)
            print(f"  [{channel}] uploading config...")

            try:
                scp_upload(ssh_port, CONFIG_RSC, "rb5009-arm64.rsc")
                print(f"  [{channel}] resetting configuration...")
                rest_post(http_port, "/system/reset-configuration", {
                    "run-after-reset": "rb5009-arm64.rsc",
                    "keep-users": "yes",
                    "skip-backup": "yes",
                })
                time.sleep(5)
                booted = wait_for_boot(http_port, timeout_s=120)
                if not booted:
                    print(f"  [{channel}] did not reboot in time — skipping export")
                    continue
                print(f"  [{channel}] exporting...")
                exports[channel] = ssh_exec(ssh_port, ":export")
            except Exception as e:  # noqa: BLE001
                print(f"  [{channel}] step failed: {e} (is ssh/scp in PATH?)")

        if len(exports) >= 2:
            channels_done = list(exports.keys())
            baseline_ch = channels_done[0]
            baseline_lines = set(
                l.strip() for l in exports[baseline_ch].splitlines()
                if l.strip() and not l.strip().startswith("#")
            )
            print(f"\n4-way diff (baseline: {baseline_ch}):")
            any_drift = False
            for ch in channels_done[1:]:
                curr_lines = set(
                    l.strip() for l in exports[ch].splitlines()
                    if l.strip() and not l.strip().startswith("#")
                )
                added = curr_lines - baseline_lines
                removed = baseline_lines - curr_lines
                if added or removed:
                    any_drift = True
                    print(f"  {baseline_ch} → {ch}:  +{len(added)} lines  -{len(removed)} lines")
                    for line in sorted(added)[:5]:
                        print(f"    + {line}")
                    for line in sorted(removed)[:5]:
                        print(f"    - {line}")
                else:
                    print(f"  {baseline_ch} → {ch}:  (identical)")

            if not any_drift:
                print("\nResult: no config drift — config is compatible across all tested versions")
            else:
                print("\nResult: config drift detected — review differences above")
        else:
            print("  Fewer than 2 exports collected — skipping diff")
    else:
        print(f"\n[skip] {CONFIG_RSC.name} not found — skipping config drift check")

    # --- Step 6: Cleanup (unless --no-cleanup) ---
    if args.no_cleanup:
        print("\nInstances left running (--no-cleanup):")
        for channel in channels:
            port_base = PORT_BASES[channel]
            name = machine_name(channel)
            ssh_port = port_base + 2
            print(f"  {name:<24}  http://127.0.0.1:{port_base}  ssh -p {ssh_port} admin@127.0.0.1")
        print()
    else:
        print("\nStopping and removing instances...")
        for channel in channels:
            stop_instance(channel)
            print(f"  [removed] {machine_name(channel)}")

    print("\nDone.")


if __name__ == "__main__":
    main()
