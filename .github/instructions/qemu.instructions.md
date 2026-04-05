---
applyTo: "src/lib/qemu.ts,src/lib/channels.ts,src/lib/platform.ts"
---

# QEMU Domain Knowledge

## ARM64 CHR (qemu-system-aarch64)

- Machine: `-M virt`
- UEFI firmware: two pflash drives (unit=0 code readonly, unit=1 vars writable)
- Disk: `-drive file=...,format=raw,if=none,id=drive0 -device virtio-blk-pci,drive=drive0`
- **NEVER use `if=virtio`** on virt — it maps to MMIO, causing silent boot failures
- CPU: `-cpu host` when using HVF, `-cpu cortex-a710` for TCG
- pflash sizes must match (dd to pad/truncate vars copy)

## x86 CHR (qemu-system-x86_64)

- Machine: `-M q35`
- No firmware needed (SeaBIOS built in)
- Disk: `-drive file=...,format=raw,if=virtio` (fine on q35 — maps to PCI)
- QGA available via `virtio-serial-pci` + `virtserialport`

## Acceleration

1. Linux + matching host/guest arch + /dev/kvm writable → `kvm`
2. macOS + matching host/guest arch + `kern.hv_support=1` → `hvf`
3. Fallback → `tcg` (software emulation, use `tb-size=256`)

## Networking

- User mode: `-netdev user,id=net0,hostfwd=...`
- vmnet-shared: `-netdev vmnet-shared,id=net0` (macOS only)
- vmnet-bridge: `-netdev vmnet-bridged,id=net0,ifname=en0` (macOS only)

## Channels (background mode)

- Monitor: Unix socket, readline protocol. Wait for `(qemu)` prompt before sending commands.
- Serial: Unix socket, bidirectional byte stream.
- QGA: Unix socket, JSON protocol. Send `guest-sync-delimited` first, then commands.

## Boot Detection

Poll `http://127.0.0.1:{http_port}/` with timeout. RouterOS REST API responds once booted.
Typical boot time: 5-15s (KVM/HVF), 20-60s (TCG).
