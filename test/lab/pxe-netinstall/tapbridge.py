# cspell:ignore IFF RDWR TUNSETIFF tapbridge
"""Bridge a Linux TAP device to one end of a QEMU unix dgram link.

    python3 -I tapbridge.py <tap-name> <local.sock> <remote.sock>

Each datagram on the link is one Ethernet frame, as with QEMU's
`-netdev dgram,local.type=unix,...` (quickchr's `socket::<name>`). This lets a
host process, here `netinstall-cli` inside an unprivileged user + network
namespace (`unshare -rn`), sit on the same L2 as a QEMU target without root:
creating the TAP needs CAP_NET_ADMIN only inside that namespace.
Runs until killed. Frames sent before the peer socket exists are dropped.
"""

import fcntl
import os
import select
import socket
import struct
import sys

TUNSETIFF = 0x400454CA
IFF_TAP = 0x0002
IFF_NO_PI = 0x1000

name, local, remote = sys.argv[1:4]
tap = os.open("/dev/net/tun", os.O_RDWR)
fcntl.ioctl(tap, TUNSETIFF, struct.pack("16sH", name.encode(), IFF_TAP | IFF_NO_PI))
try:
    os.unlink(local)
except FileNotFoundError:
    pass
sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
sock.bind(local)
print(f"tapbridge {name} <-> {remote}", flush=True)
while True:
    ready, _, _ = select.select([tap, sock], [], [])
    if tap in ready:
        frame = os.read(tap, 65536)
        try:
            sock.sendto(frame, remote)
        except OSError:
            pass  # peer not started yet, or gone
    if sock in ready:
        os.write(tap, sock.recv(65536))
