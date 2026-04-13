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

- Machine: `-M pc`
- No firmware needed (SeaBIOS built in)
- Disk: `-drive file=...,format=raw,if=virtio` (fine on q35/pc — maps to PCI)
- QGA available via `virtio-serial-pci` + `virtserialport`

## Acceleration

1. Linux + matching host/guest arch + /dev/kvm writable → `kvm`
2. macOS + matching host/guest arch + `kern.hv_support=1` → `hvf`
3. Fallback → `tcg` (software emulation, use `tb-size=256`)

> **macOS HVF — host/guest arch determines acceleration:**
> - **x86_64 host (Intel Mac)**: `qemu-system-x86_64` uses HVF for x86 CHR because the host *is* x86 hardware — this is native virtualization, not Rosetta. `qemu-system-aarch64` falls back to `accel=tcg` for ARM64 CHR, which is software emulation; startup times are only marginally slower for CHR's typical boot workload on fast Intel hardware.
> - **arm64 host (Apple Silicon)**: `qemu-system-aarch64` uses HVF for ARM64 CHR. `qemu-system-x86_64` for x86 CHR must use `accel=tcg` (x86 software emulation on ARM) — expect 10–20× slower startup. **Rosetta2 does not help**: it translates QEMU's *process binary* to run natively on arm64 but cannot provide hardware acceleration for x86 *guest instructions* inside QEMU. CHR images also have known conflicts with Apple's Virtualization Framework (separate from QEMU HVF), making QEMU the only reliable hypervisor for CHR on any Mac.

## Networking

- User mode: `-netdev user,id=net0,hostfwd=...`
- Socket (inter-VM L2): `-netdev socket,id=net1,listen=:4001` / `connect=127.0.0.1:4001`
- socket_vmnet (macOS, preferred): `-netdev socket,id=net0,fd=3` — QEMU launched via `socket_vmnet_client <socket_path> qemu-system-*`. Daemon runs as root, QEMU runs unprivileged
- vmnet-shared (macOS, fallback): `-netdev vmnet-shared,id=net0` — requires entire QEMU as root
- vmnet-bridged (macOS, fallback): `-netdev vmnet-bridged,id=net0,ifname=en0` — requires root
- TAP (Linux): `-netdev tap,id=net0,ifname=tap-chr0,script=no,downscript=no` — pre-created user-owned TAP

**Resolution order for `--add-network shared`:** socket_vmnet daemon → vmnet-shared (root) → error
**Resolution order for `--add-network bridged:<iface>`:** socket_vmnet bridged → vmnet-bridged (root) → error

## Channels (background mode)

- Monitor: Unix socket, readline protocol. Wait for `(qemu)` prompt before sending commands.
- Serial: Unix socket, bidirectional byte stream.
- QGA: Unix socket, JSON protocol. Send `guest-sync-delimited` first, then commands.

## Boot Detection

Poll `http://127.0.0.1:{http_port}/` with timeout. RouterOS REST API responds once booted.
Typical boot time: 5-15s (KVM/HVF), 20-60s (TCG).

