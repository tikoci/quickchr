---
applyTo: "src/lib/qemu.ts,src/lib/channels.ts,src/lib/platform.ts"
---

# QEMU Domain Knowledge

## ARM64 CHR (qemu-system-aarch64)

- Machine: `-M virt`
- UEFI firmware: two pflash drives (unit=0 code readonly raw, unit=1 vars writable)
- **Vars pflash MUST be qcow2** (`efi-vars.qcow2`, built via `qemu-img convert`) —
  QEMU refuses `savevm`/`loadvm` while ANY writable block device is non-qcow2
  ("Device 'pflash1' is writable but does not support snapshots"), which silently
  broke all arm64 snapshots (#31, `test/lab/arm64-rollback/REPORT.md`). Legacy raw
  `efi-vars.fd` is migrated in place at next launch (NVRAM preserved).
- Disk: `-drive file=...,format=raw,if=none,id=drive0 -device virtio-blk-pci,drive=drive0`
- **NEVER use `if=virtio`** on virt — it maps to MMIO, causing silent boot failures
- CPU: `-cpu host` when using HVF, `-cpu cortex-a710` for TCG
- pflash virtual sizes must match the code ROM (pad/truncate the raw stage before converting)

## x86 CHR (qemu-system-x86_64)

- Machine: `-M pc`
- No firmware needed (SeaBIOS built in)
- Disk: `-drive file=...,format=raw,if=virtio` (fine on q35/pc — maps to PCI)
- QGA available via `virtio-serial-pci` + `virtserialport`

## Acceleration

0. An explicit override (`--accel` flag > `QUICKCHR_ACCEL` env > `accel` in `quickchr.env`) other than `auto` → used verbatim, **skipping every check below**
1. Linux + matching host/guest arch + /dev/kvm writable → `kvm`
2. macOS + `kern.hv_support=1` + **physical x86_64 host + x86 guest** → `hvf`
3. Fallback → `tcg` (software emulation, use `tb-size=256`)

macOS **arm64 guests never auto-select HVF** — see the Apple Silicon note below.

> **macOS HVF — host/guest arch determines acceleration:**
> - **x86_64 host (Intel Mac)**: `qemu-system-x86_64` uses HVF for x86 CHR — native virtualization, not Rosetta. `qemu-system-aarch64` falls back to `accel=tcg` for ARM64 CHR (cross-arch software emulation).
> - **arm64 host (Apple Silicon)**: `qemu-system-aarch64` must use `accel=tcg` for ARM64 CHR, **not HVF** — current arm64 CHR images require a 32-bit ARM userspace (the appended initramfs `/init` is `ELF 32-bit LSB ARM, EABI5`) and no Apple CPU implements AArch32 at any exception level, so an HVF guest panics at t≈0.076 s with `No working init found`. HVF passes the hardware `ID_AA64PFR0_EL1` straight through, so **no `-cpu` model changes this** and no QEMU version fixes it; the restore signal is a future AArch64-only CHR image, not a host or QEMU property. See DESIGN.md #10 and `docs/m4-hvf-arm64-investigation.md` (quickchr#97). `qemu-system-x86_64` for x86 CHR must also use `accel=tcg` (x86 software emulation on ARM). **Rosetta2 does not help**: it translates QEMU's *process binary* to run natively on arm64 but cannot provide hardware acceleration for x86 *guest instructions* inside QEMU. CHR images also have known conflicts with Apple's Virtualization Framework (separate from QEMU HVF), making QEMU the only reliable hypervisor for CHR on any Mac.
>
> Cross-arch TCG (guest arch ≠ host arch) is significantly slower than native KVM/HVF. Do not assume any specific timing — measure with your target config. The per-probe HTTP timeout in boot-wait loops is often the critical factor, not total poll duration.

## Networking

- User mode: `-netdev user,id=net0,hostfwd=...`
- Socket (inter-VM L2): `-netdev socket,id=net1,listen=:4001` / `connect=127.0.0.1:4001`
- socket_vmnet (macOS, preferred): `-netdev socket,id=net0,fd=3` — QEMU launched via `socket_vmnet_client <socket_path> qemu-system-*`. Daemon runs as root, QEMU runs unprivileged
- vmnet-shared (macOS, fallback): `-netdev vmnet-shared,id=net0` — requires entire QEMU as root
- vmnet-bridged (macOS, fallback): `-netdev vmnet-bridged,id=net0,ifname=en0` — requires root
- TAP (Linux): `-netdev tap,id=net0,ifname=tap-chr0,script=no,downscript=no` — pre-created user-owned TAP

**Resolution order for `--add-network shared`:** socket_vmnet daemon → vmnet-shared (root) → error
**Resolution order for `--add-network bridged:<iface>`:** socket_vmnet bridged → vmnet-bridged (root) → error

### SLiRP hostfwd Requires a Guest IP

SLiRP `hostfwd` forwards connections to a specific guest IP (default `10.0.2.15`).
**Without that IP on the guest interface, hostfwd creates half-open connections:**
the host-side TCP connect succeeds (SLiRP accepts immediately) but the guest never
receives data. HTTP requests hang until the per-probe timeout — not ECONNREFUSED.

This means SLiRP **must** be on ether1 (RouterOS auto-creates DHCP client only on ether1;
SLiRP's built-in DHCP assigns 10.0.2.15). Multi-NIC configs: `user` first, then
shared/bridged/socket. Shared/bridged on ether2+ needs a manual DHCP client added via
REST after boot.

**TCG hazard:** Half-open connections burn the full per-probe HTTP timeout on every
`waitForBoot` probe. Under TCG where TCP round-trips are slow, this compounds badly.
Lab evidence: `test/lab/slirp-hostfwd/`.

### Reading `info usernet` — the only host-side view of the guest

The QEMU monitor's `info usernet` prints slirp's forwarding table plus live
connections. It is the **only** host-side instrument that separates "nothing is
listening" from "the packets are being silently dropped" — a host-side TCP connect
reads "accepting" in both cases (see the hostfwd note above). Measured on a healthy
7.21.5 CHR (x86/HVF), four probes per condition:

| guest condition | rows for that guest port |
|---|---|
| serving (e.g. `www` enabled) | `TIME_WAIT` / `ESTABLISHED` / `FIN_WAIT_*` |
| nothing listening (service disabled) | **none at all** — the guest RSTs and slirp discards the entry |
| silently dropped (`action=drop`) | `TCP[SYN_SENT]`, persisting |

Row format — the bracketed state can contain a space, so parse it as "anything but
`]`" (UDP rows carry a TTL):

```text
  Protocol[State]    FD  Source Address  Port   Dest. Address  Port RecvQ SendQ
  TCP[HOST_FORWARD]  21               *  9170       10.0.2.15    80     0     0
  TCP[SYN_SENT]     103       127.0.0.1  9100       10.0.2.15    80     0     0
  UDP[223 sec]      168       10.0.2.15  5678 255.255.255.255  5678     0     0
```

That last row is a useful positive: MNDP broadcasting *from* `10.0.2.15` proves the
guest holds its DHCP lease. `SYN_SENT` does **not** say *where* the drop happens —
a guest that received every SYN and dropped it itself looks identical from the
host. Localizing that needs a guest-side counter; see `src/lib/guest-snapshot.ts`
and `.github/instructions/provisioning.instructions.md`. Implementation:
`parseUsernetTable()` / `classifyForwardedPorts()` in `src/lib/diagnostics.ts`.

### Guest→host UDP via the gateway (no hostfwd)

SLIRP's gateway `10.0.2.2` **is the host** from inside the guest. A datagram the
guest sends to `10.0.2.2:<port>` is relayed to a host process bound on loopback
`<port>` — **no `hostfwd`, no extra NIC**. This is the general form of the TZSP path
(`ChrInstance.tzspGatewayIp` / `captureInterface`); it also covers remote syslog,
NetFlow, and a guest server replying to the gateway.

**The host socket must be left unconnected** (`recvfrom`, not `connect`): SLIRP
re-emits the datagram from a rewritten loopback source (`127.0.0.1:<ephemeral>`,
not the guest's `10.0.2.15`), so a connected socket filters it out. Lab evidence:
`test/lab/gateway-udp/REPORT.md`; recipe: `docs/networking-recipes.md`. For
host→guest (incl. dynamic/range ports) use `hostfwd` (`--forward`/`extraPorts`,
range form `name:hostStart-hostEnd[:guestStart-guestEnd][/proto]`).

## Channels (background mode)

- Monitor: Unix socket, readline protocol. Wait for `(qemu)` prompt before sending commands.
- Serial: Unix socket, bidirectional byte stream.
- QGA: Unix socket, JSON protocol. Send `guest-sync-delimited` first, then commands.

## Boot Detection

Poll `http://127.0.0.1:{http_port}/` with timeout. RouterOS REST API responds once booted.
Boot time varies significantly by acceleration mode and host hardware — do not hard-code estimates.
Under cross-arch TCG, a single HTTP round-trip through the emulated TCP stack can take many seconds;
the per-probe HTTP timeout must be long enough to actually receive a response.

### Aborting a probe damages `www` — don't do it to hurry a slow guest

`restGet()` enforces its deadline with `req.destroy()`, tearing the socket down
mid-request. Measured on RouterOS 7.21.5 (`test/lab/www-abort-damage/`):

| pattern | result |
|---|---|
| a lone aborted request, probed 0–3000 ms later | no effect, `HTTP 200` throughout |
| 2–5 aborts in a row, gaps 0–2000 ms, nothing completing between | no effect |
| **abort, then a completed request, repeated** | **`www` resets incoming connections, and a surviving one gets the ABORTED request's response** |

The third row is the damaging one and it is deterministic. Concretely: probe as a
non-existent user, abort mid-flight, then probe as `admin:` with its valid empty
password — and get `401`, the status belonging to the aborted request. Verified
with `curl` from a separate process, so it is **guest-side**, not client socket
reuse; and reproduced on **x86/HVF as well as arm64 cross-arch TCG**, so it is
not an arm64 quirk.

`waitForBoot()` emits exactly that pattern whenever a probe overruns its deadline
and the next one succeeds. Two rules follow:

- **Scale the per-probe deadline with the accel factor**, like the budget around
  it. Under TCG the honest fix for a slow answer is to wait for it.
- **Back off after consecutive aborted probes.** It is the abort/complete
  *alternation* that does the damage, not the number of aborts, so continuing to
  poll at a fixed cadence keeps re-triggering it.

Limits of the evidence: locally `www` recovers within ~6 s, so the permanent
wedge in #79's CI forensics is **not** reproduced here, and nothing local
explains what made CI's first probe exceed 3 s (a failed login answers in
~125 ms even at `cpu-load: 100`). Treat those two as open.
