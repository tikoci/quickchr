#!/usr/bin/env python3
"""
mndp — receive RouterOS MNDP broadcasts from a CHR (Python / subprocess CLI)

Drives the quickchr CLI to boot one CHR with a second NIC on QEMU's TCP `socket`
netdev (`socket:connect:<port>`), runs a host TCP server, and parses the guest's
Layer-2 frames to extract MNDP neighbor-discovery announcements (UDP/5678).

QEMU streams each guest Ethernet frame to the host length-prefixed
(4-byte big-endian length + raw frame). We strip the prefix and parse
Ethernet -> IPv4 -> UDP/5678 -> MNDP TLVs. Loopback-only, rootless, cross-platform.

Why not mcast? QEMU's `socket,mcast=` is broken on macOS (SO_REUSEADDR vs the
SO_REUSEPORT macOS needs to share a multicast port). socket-connect has no such
limit. See ../../docs/mndp.md and ../../test/lab/mndp/REPORT.md.

Usage:
    python3 mndp.py [--channel stable] [--arch auto] [--timeout 45] [--no-cleanup]

Requirements:
    - quickchr installed (or run via the Makefile with QUICKCHR="bun run ../../src/cli/index.ts --")
    - QEMU for the chosen arch; acceleration auto-detected (quickchr doctor)
"""

import argparse
import platform
import socket
import struct
import subprocess
import sys
import threading
import time

NAME = "mndp-example"
IDENTITY = "mndp-example"
MNDP_PORT = 5678
QUICKCHR = ["quickchr"]  # overridden by --quickchr / Makefile


def run_quickchr(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run([*QUICKCHR, *args], capture_output=True, text=True, check=check)


# ── frame parsing ────────────────────────────────────────────────────────────
def eth_to_udp_payload(frame: bytes, want_dport: int):
    """Return the UDP payload of an IPv4/UDP Ethernet frame, or None."""
    if len(frame) < 14 + 20 + 8:
        return None
    if struct.unpack_from("!H", frame, 12)[0] != 0x0800:  # not IPv4
        return None
    ip = 14
    if (frame[ip] >> 4) != 4:
        return None
    ihl = (frame[ip] & 0x0F) * 4
    if frame[ip + 9] != 17:  # not UDP
        return None
    udp = ip + ihl
    if udp + 8 > len(frame):
        return None
    if struct.unpack_from("!H", frame, udp + 2)[0] != want_dport:
        return None
    udp_len = struct.unpack_from("!H", frame, udp + 4)[0]
    return frame[udp + 8 : min(udp + udp_len, len(frame))]


def parse_mndp(buf: bytes) -> dict:
    """Parse MNDP TLVs (see the routeros-mndp skill for the full type table)."""
    fields, o = {}, 4  # skip 2-byte header + 2-byte sequence
    while o + 4 <= len(buf):
        t, ln = struct.unpack_from("!HH", buf, o)
        o += 4
        if o + ln > len(buf):
            break
        v = buf[o : o + ln]
        if t == 1:
            fields["mac"] = ":".join(f"{b:02x}" for b in v)
        elif t == 5:
            fields["identity"] = v.decode("utf-8", "replace")
        elif t == 7:
            fields["version"] = v.decode("utf-8", "replace")
        elif t == 8:
            fields["platform"] = v.decode("utf-8", "replace")
        elif t == 10 and ln == 4:
            fields["uptime"] = struct.unpack("<I", v)[0]  # the only LE value
        elif t == 11:
            fields["softwareId"] = v.decode("utf-8", "replace")
        elif t == 12:
            fields["board"] = v.decode("utf-8", "replace")
        elif t == 16:
            fields["ifname"] = v.decode("utf-8", "replace")
        elif t == 17 and ln == 4:
            fields["ipv4"] = ".".join(str(b) for b in v)
        o += ln
    return fields


def build_refresh_stream_frame() -> bytes:
    """A length-prefixed MNDP refresh frame to write back over the TCP socket."""
    payload = b"\x00\x00\x00\x00"  # minimal MAC-Telnet refresh
    udp = struct.pack("!HHHH", MNDP_PORT, MNDP_PORT, 8 + len(payload), 0) + payload
    ip = bytearray(20)
    ip[0] = 0x45
    struct.pack_into("!H", ip, 2, 20 + len(udp))
    ip[8] = 1   # TTL
    ip[9] = 17  # UDP
    struct.pack_into("!I", ip, 12, 0)            # src 0.0.0.0
    struct.pack_into("!I", ip, 16, 0xFFFFFFFF)   # dst 255.255.255.255
    s = sum(struct.unpack("!10H", bytes(ip)))
    s = (s & 0xFFFF) + (s >> 16)
    struct.pack_into("!H", ip, 10, ~s & 0xFFFF)
    eth = b"\xff\xff\xff\xff\xff\xff" + b"\x02\x00\x00\x00\x00\x01" + struct.pack("!H", 0x0800)
    frame = eth + bytes(ip) + bytes(udp)
    return struct.pack("!I", len(frame)) + frame


# ── capture thread: accept QEMU's connection, de-frame, parse ────────────────
class Capture(threading.Thread):
    def __init__(self, server: socket.socket):
        super().__init__(daemon=True)
        self.server = server
        self.records: list[dict] = []
        self.conn: socket.socket | None = None
        self._stop = threading.Event()

    def run(self) -> None:
        self.server.settimeout(1.0)
        conn = None
        while not self._stop.is_set() and conn is None:
            try:
                conn, _ = self.server.accept()
            except socket.timeout:
                continue
            except OSError:
                return
        if conn is None:
            return
        self.conn = conn
        conn.settimeout(1.0)
        buf = b""
        while not self._stop.is_set():
            try:
                chunk = conn.recv(65536)
            except socket.timeout:
                continue
            except OSError:
                break
            if not chunk:
                break
            buf += chunk
            while len(buf) >= 4:
                (length,) = struct.unpack_from("!I", buf, 0)
                if length > 0xFFFF or len(buf) < 4 + length:
                    break
                frame, buf = buf[4 : 4 + length], buf[4 + length :]
                udp = eth_to_udp_payload(frame, MNDP_PORT)
                if udp is None:
                    continue
                rec = parse_mndp(udp)
                if rec.get("identity"):
                    self.records.append(rec)

    def inject_refresh(self) -> None:
        if self.conn:
            try:
                self.conn.sendall(build_refresh_stream_frame())
            except OSError:
                pass

    def stop(self) -> None:
        self._stop.set()


def main() -> None:
    global QUICKCHR
    ap = argparse.ArgumentParser(description="receive MNDP from a CHR via socket-connect")
    ap.add_argument("--channel", default="stable")
    ap.add_argument("--arch", default="auto", help="arm64 | x86 | auto (host native)")
    ap.add_argument("--timeout", type=int, default=45, help="seconds to wait for an MNDP match")
    ap.add_argument("--no-cleanup", action="store_true")
    ap.add_argument("--quickchr", help='override the quickchr command, e.g. "bun run ../../src/cli/index.ts --"')
    args = ap.parse_args()
    if args.quickchr:
        QUICKCHR = args.quickchr.split()

    arch = args.arch
    if arch == "auto":
        arch = "arm64" if platform.machine() in ("arm64", "aarch64") else "x86"

    # 1. Host TCP server on an ephemeral loopback port.
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    port = server.getsockname()[1]
    cap = Capture(server)
    cap.start()
    print(f"host: TCP listener on 127.0.0.1:{port}")

    rc = 1
    try:
        # 2. Boot CHR: ether1 = user (mgmt), ether2 = socket-connect to the host.
        print(f"starting CHR '{NAME}' (channel={args.channel}, arch={arch})...")
        run_quickchr("stop", NAME, check=False)
        run_quickchr("remove", NAME, check=False)
        run_quickchr(
            "start", NAME,
            "--channel", args.channel,
            "--arch", arch,
            "--no-secure-login",
            "--add-network", "user",
            "--add-network", f"socket:connect:{port}",
        )
        print("  booted")

        # 3. Known identity + ensure MNDP on ether2.
        run_quickchr("exec", NAME, f"/system/identity/set name={IDENTITY}")
        run_quickchr("exec", NAME, "/ip/neighbor/discovery-settings/set discover-interface-list=all")

        # 4. Nudge an immediate reply, then wait for an announcement carrying our identity.
        time.sleep(1)
        cap.inject_refresh()
        deadline = time.time() + args.timeout
        got = None
        while time.time() < deadline:
            got = next((r for r in cap.records if r.get("identity") == IDENTITY), None)
            if got:
                break
            time.sleep(1)

        if not got:
            print(f"FAIL: no MNDP announcement with identity '{IDENTITY}' within {args.timeout}s", file=sys.stderr)
            return
        print("\nMNDP received over L2 (socket-connect):")
        for k in ("identity", "version", "platform", "board", "ifname", "ipv4", "uptime", "mac", "softwareId"):
            if k in got:
                print(f"  {k:<11} {got[k]}")
        rc = 0
    finally:
        cap.stop()
        try:
            server.close()
        except OSError:
            pass
        if args.no_cleanup:
            print(f"\n--no-cleanup: '{NAME}' left running")
        else:
            run_quickchr("stop", NAME, check=False)
            run_quickchr("remove", NAME, check=False)
            print(f"\nremoved '{NAME}'")
    sys.exit(rc)


if __name__ == "__main__":
    main()
