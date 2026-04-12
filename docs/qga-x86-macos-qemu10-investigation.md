# QGA x86 Failure on macOS — Investigation Report

**Date:** 2026-04-12 (initial), 2026-04-12 (corrected)
**Investigator:** quickchr / tikoci
**Status:** Root cause identified — RouterOS CHR QGA is KVM-only. NOT a QEMU bug.

---

## Executive Summary

QEMU Guest Agent (QGA) does **not** work on MikroTik CHR x86 images when running under
QEMU with HVF or TCG acceleration on macOS. The same CHR image works under Linux + KVM.

**This is NOT a QEMU bug and NOT a QEMU version regression.**

The root cause is on the **guest side**: RouterOS CHR's QGA daemon only starts when it
detects a KVM hypervisor. Under HVF or TCG, the KVM hypervisor signature and feature
bits are absent from CPUID, so the daemon never starts. QEMU correctly provides the
virtio-serial port and sends `VIRTIO_CONSOLE_PORT_OPEN` to the guest — the guest simply
never opens it.

### Correction Notice

The original version of this report (2026-04-12) incorrectly diagnosed a QEMU 10.x
regression in `virtconsole_enable_backend()`. That diagnosis was **wrong** on multiple
counts:

1. **Event number error**: The report claimed PORT_OPEN is event 4 — it is actually
   event **6** (`VIRTIO_CONSOLE_PORT_OPEN = 6`). Event 4 is `VIRTIO_CONSOLE_CONSOLE_PORT`.
   The trace showing event 6 being sent was misidentified as "PORT_RESIZE".
2. **No QEMU regression exists**: All 7 relevant QEMU source files (`virtio-console.c`,
   `virtio-serial-bus.c`, `char-fe.c`, `char-socket.c`, `char.c`, `char.h`,
   `chardev-internal.h`) are **functionally identical** between QEMU v9.2.0 and v10.2.0.
3. **The "working reference" was always Linux + KVM** — not macOS + HVF. QGA never
   worked on HVF; the original comparison was apples-to-oranges.

---

## Host Environment

| Item | Value |
|------|-------|
| Host OS | macOS Intel (`Morpheus`) |
| QEMU version | 10.2.2 (Homebrew) |
| Accelerators tested | HVF, TCG — both fail |
| RouterOS versions tested | CHR 7.20.8, 7.22.1, 7.22rc4 (x86) |
| Working reference | Linux x86_64 + **KVM** + QEMU 9.2.0 (mikropkl lab) |

---

## Root Cause: RouterOS QGA Is KVM-Only

### Evidence Chain

**1. Guest never opens the virtio-serial port**

QMP `query-chardev` with a host client connected to the QGA socket:

```json
{"frontend-open": false, "filename": "unix:/tmp/qga-test.sock,server=on", "label": "qga0"}
```

`frontend-open: false` means `set_guest_connected()` was never called — the guest
kernel's `virtio_console` driver never received a userspace `open()` on the port device.
The QGA daemon never tried to open `/dev/virtio-ports/org.qemu.guest_agent.0`.

**2. QEMU host-side is correct — PORT_OPEN IS sent**

The original QEMU virtio trace shows (with corrected event identification):

```
virtio_serial_send_control_event port 1, event 1, value 1   ← PORT_ADD
virtio_serial_handle_control_message event 0, value 1       ← DEVICE_READY (guest → host)
virtio_serial_send_control_event port 1, event 1, value 1   ← PORT_ADD
virtio_serial_handle_control_message event 3, value 1       ← PORT_READY (guest → host)
virtio_serial_handle_control_message_port port 1

# After host client connects to socket:
virtio_serial_send_control_event port 1, event 6, value 1   ← PORT_OPEN (host → guest) ✅
```

Event 6 = `VIRTIO_CONSOLE_PORT_OPEN` (not "RESIZE" as the original report claimed).
The host correctly sends PORT_OPEN. The guest receives it but never opens the port.

Reference: `include/standard-headers/linux/virtio_console.h` (QEMU v10.2.0):
```c
#define VIRTIO_CONSOLE_DEVICE_READY     0
#define VIRTIO_CONSOLE_PORT_ADD         1
#define VIRTIO_CONSOLE_PORT_REMOVE      2
#define VIRTIO_CONSOLE_PORT_READY       3
#define VIRTIO_CONSOLE_CONSOLE_PORT     4    // ← NOT PORT_OPEN (original report was wrong)
#define VIRTIO_CONSOLE_RESIZE           5
#define VIRTIO_CONSOLE_PORT_OPEN        6    // ← THIS is PORT_OPEN
#define VIRTIO_CONSOLE_PORT_NAME        7
```

**3. No QEMU source regression between v9.2.0 and v10.2.0**

All 7 source files governing virtio-serial and chardev behavior were compared line-by-line
between QEMU tags `v9.2.0` and `v10.2.0`. Every file is **functionally identical**:

| File | v9.2.0 vs v10.2.0 |
|------|--------------------|
| `hw/char/virtio-console.c` | Identical |
| `hw/char/virtio-serial-bus.c` | Identical |
| `chardev/char-fe.c` | Identical |
| `chardev/char-socket.c` | Identical |
| `chardev/char.c` | Identical |
| `include/chardev/char.h` | Identical |
| `include/chardev/chardev-internal.h` | Identical |

If the code is identical, the behavior is identical. There is no regression.

**4. CPUID KVM detection is identical in both QEMU versions**

`target/i386/cpu.c` in both v9.2.0 and v10.2.0:
```c
case 0x40000000:
    // Under TCG: returns "TCGTCGTCGTCG"
    // Under KVM with expose_kvm: returns "KVMKVMKVM\0\0\0"
    // Under HVF/others: returns all zeros
```

And later:
```c
if (!kvm_enabled() || !cpu->expose_kvm) {
    env->features[FEAT_KVM] = 0;   // Zero ALL KVM feature bits under HVF/TCG
}
```

This code is **identical in both versions**. Under HVF:
- CPUID leaf 0x40000000: no vendor string (zeros)
- CPUID leaf 0x40000001 (FEAT_KVM): all zeros (no KVM features)

**5. MikroTik documentation lists QGA exclusively under KVM**

From the [CHR manual](https://help.mikrotik.com/docs/spaces/ROS/pages/18350234/Cloud+Hosted+Router+CHR)
(Guest tools section):

> **KVM**
> QEMU guest agent is available. Supported agent commands can be retrieved by using
> the guest-info command...

QGA is documented **only** under the "KVM" subsection of "Guest tools". It is not
listed as a general CHR feature.

**6. hv-vendor-id experiment failed**

Running QEMU with `-cpu host,hv-vendor-id=KVMKVMKVM` to fake the KVM vendor string
at CPUID 0x40000000 did NOT fix QGA. QMP confirmed that despite the vendor string,
`CPUID[0x40000001].EAX = 0x00000000` — the KVM feature bits remain zeroed because
`env->features[FEAT_KVM]` is unconditionally cleared under non-KVM accelerators.
RouterOS likely checks BOTH the vendor string AND feature bits, or uses a different
detection path entirely.

**7. Guest diagnostics show no QGA activity**

- `/rest/log` — no QGA-related log entries at any level
- `/rest/system/package` — standard CHR packages, no separate QGA package
- CPU profiling via `/tool/profile` — 0% CPU (no background QGA process)
- RouterOS `system/resource` — board-name "CHR QEMU Standard PC", platform "MikroTik"

**8. Both HVF and TCG fail identically**

This rules out HVF-specific issues. TCG also zeros KVM CPUID (via `TCG_KVM_FEATURES = 0`
and the `!kvm_enabled()` check), so the guest sees the same non-KVM environment
regardless of accelerator.

---

## What RouterOS Likely Does

RouterOS is Linux-based. Under KVM, the Linux kernel detects the KVM hypervisor via:

1. CPUID leaf 1, ECX bit 31 (hypervisor present) → set under both KVM and HVF
2. CPUID leaf 0x40000000 → vendor string "KVMKVMKVM" (only under KVM)
3. CPUID leaf 0x40000001 → KVM paravirt feature flags (only under KVM)

When KVM is detected, the Linux `kvm_para` module initializes. RouterOS's QGA daemon
likely depends on this KVM detection (directly or indirectly) before starting the QEMU
guest agent service and opening `/dev/virtio-ports/org.qemu.guest_agent.0`.

Under HVF: bit 31 IS set (hypervisor detected), but the vendor at 0x40000000 is empty
and KVM features at 0x40000001 are zero. No KVM paravirt → no QGA daemon → guest port
never opened.

---

## Variables Systematically Eliminated

| Variable | Configurations Tested | Result |
|----------|-----------------------|--------|
| Machine type | `q35`, `pc` | Both fail |
| Accelerator | `hvf`, `tcg` | Both fail identically |
| RouterOS version | 7.20.8, 7.22.1, 7.22rc4 | All fail |
| QEMU version | v9.2.0, v10.2.0 source comparison | Identical source code |
| KVM CPUID fakery | `-cpu host,hv-vendor-id=KVMKVMKVM` | No effect |
| virtio-serial variant | `virtio-serial-pci`, with/without options | No effect |
| Chardev mode | `server=on,wait=off` (server) AND `server=off` (client) | Both fail |
| Connect timing | At QEMU start (pre-boot) AND after boot | Both fail |

---

## Minimal Reproduction

```bash
QCOW=/tmp/test-chr.qcow2
IMG=/path/to/chr-7.22.1.img
qemu-img create -f qcow2 -b "$IMG" -F raw "$QCOW" 4G

QGA=/tmp/qga-test.sock
QMP=/tmp/qmp-test.sock
rm -f "$QGA" "$QMP"

qemu-system-x86_64 \
  -machine pc,accel=hvf \
  -cpu host \
  -smp 1 -m 256M \
  -drive file="$QCOW",format=qcow2,if=virtio \
  -device virtio-serial-pci \
  -chardev socket,id=qga0,path="$QGA",server=on,wait=off \
  -device virtserialport,chardev=qga0,name=org.qemu.guest_agent.0 \
  -netdev user,id=net0,hostfwd=tcp::18080-:80 \
  -device virtio-net-pci,netdev=net0 \
  -qmp unix:"$QMP",server=on,wait=off \
  -nographic &

# Wait for boot (~30s), then:
python3 -c "
import socket, json
# Check chardev status via QMP
qmp = socket.socket(socket.AF_UNIX)
qmp.connect('$QMP')
qmp.settimeout(3)
qmp.recv(4096)
qmp.sendall(b'{\"execute\":\"qmp_capabilities\"}\n')
qmp.recv(4096)
qmp.sendall(b'{\"execute\":\"query-chardev\"}\n')
import time; time.sleep(0.5)
data = qmp.recv(8192)
for line in data.decode().strip().split('\n'):
    d = json.loads(line)
    if 'return' in d:
        for item in d['return']:
            if 'qga' in item.get('label',''):
                print(f'{item[\"label\"]}: frontend-open={item[\"frontend-open\"]}')
                # Expected: frontend-open=False (guest never opened the port)
qmp.close()
"
```

Expected output: `qga0: frontend-open=False` — confirming the guest did not open the port.

---

## Implications for quickchr

1. **QGA works on KVM (Linux) only** — the mikropkl lab and SteamDeck CI (both Linux + KVM)
   are the correct environments for QGA testing. macOS testing will always fail.
2. **Not fixable from the QEMU side** — no amount of QEMU tuning, chardev configuration,
   or CPU flag manipulation will make RouterOS start its QGA daemon.
3. **Feature request target: MikroTik** — request QGA support under non-KVM hypervisors,
   or at minimum explicit documentation of the KVM requirement.
4. **quickchr should skip QGA gracefully on non-KVM platforms** — already mostly done
   (QGA is x86-only, and `qgaProbe()` handles timeouts), but the error messaging should
   reflect "KVM required" rather than implying a bug.

---

## Possible MikroTik Feature Request

**Title:** Support QEMU Guest Agent (QGA) under non-KVM hypervisors (HVF, TCG)

**Description:** RouterOS CHR's QGA daemon currently appears to only start when KVM is
detected as the hypervisor (via CPUID 0x40000000/0x40000001). This prevents QGA from
working on macOS (which uses HVF) or software emulation (TCG). The QEMU host correctly
creates the virtio-serial device and sends PORT_OPEN, but the guest never opens the port.

**Request:** Either (a) start the QGA daemon whenever a `virtio-serial` port named
`org.qemu.guest_agent.0` is present, regardless of detected hypervisor, or (b) document
the KVM requirement explicitly in the CHR manual.

---

## References

- QEMU `include/standard-headers/linux/virtio_console.h` — event number definitions
- QEMU `target/i386/cpu.c` — CPUID 0x40000000 handling (identical v9.2.0 / v10.2.0)
- MikroTik CHR manual: https://help.mikrotik.com/docs/spaces/ROS/pages/18350234/
- virtio-serial spec: https://docs.oasis-open.org/virtio/virtio/v1.2/virtio-v1.2.html
- quickchr issue tracking: BACKLOG.md in this repo
