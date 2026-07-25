# aarch64 CHR Panics Under HVF on Apple M4 — Open Investigation

**Date:** 2026-07-25 (initial), 2026-07-25 (local-homework pass)
**Investigator:** quickchr / tikoci (consolidating tikoci/mikropkl#11, tikoci/quickchr#97, #98)
**Status:** **OPEN — root cause not established, but now narrowed to a single step.** A
mitigation ships (HVF→TCG fallback on FEAT_SSBS-less Apple hosts). The published SSBS
mechanism is contradicted; the memory-map alternative has been **falsified locally**; the
failure is now localized to **`/init` exec**, and one M4 command would settle it.

---

## Executive Summary

aarch64 CHR panics in early guest boot under `-accel hvf -cpu host` on an Apple **M4**
host, and boots normally under `-accel tcg` on the same host with the same image.

Both mikropkl and quickchr fall back to TCG when `hw.optional.arm.FEAT_SSBS == 0` (true on
M4+). **That mitigation is correct and should stay.** But TCG is 10–20× slower, so we want
one of three real outcomes:

| Outcome | Owner | What it would look like |
|---------|-------|-------------------------|
| **A** — quickchr emits a wrong/fragile QEMU config for this host class | us | a machine/CPU-property fix, HVF speed retained |
| **B** — RouterOS's guest userspace/kernel can't cope with an M4-through-HVF platform | MikroTik | bug report with a minimal repro; TCG fallback stays until fixed |
| **C** — QEMU/HVF describes an M4 host to the guest incorrectly | QEMU | upstream issue + a QEMU-version floor to auto-restore HVF |

### What the local pass established (2026-07-25, Intel Mac, QEMU 11.0.3)

1. **The boot chain is now fully mapped and verified** (see "Verified Boot Chain"). A
   successful boot ends with `Run /init as init process` at **t≈1.27s** of guest time,
   after unpacking a **72 KB EFI-supplied initrd** and probing virtio-blk.
2. **The M4 panic timestamp lines up with that exact step.** Guest timestamps track host
   wall-clock (no `icount`), and HVF is ~15–25× faster than TCG here, so the successful
   boot's `Run /init` at 1.27s TCG corresponds to ≈0.05–0.09s under HVF. The M4 panics at
   **0.0769s**. The M4 kernel almost certainly did *all* the same work — unpack, driver
   init, virtio-blk probe — and failed **precisely at init-exec**, not early.
3. **T2 (memory map / PCIe ECAM placement) is falsified.** All five `virt` high-memory
   layouts boot CHR, including `highmem=off`, with a verified control showing the ECAM
   really did move (0x4010000000 → 0x3f000000). `-M virt,highmem=off` is neither a fix nor
   a repro — **remove it from the plan** (it was this doc's leading candidate yesterday).
4. **"Disk/root not found" produces a *different* panic**, reproduced locally: `VFS: Unable
   to mount root fs on unknown-block(0,0)`. The M4 shows `No working init found`. So the M4
   failure is **downstream of root acquisition** — the virtio-blk/PCI-enumeration family of
   theories is out.
5. **A verbose-boot recipe now exists for the real UEFI+ACPI path** (`startup.nsh`, below),
   verified locally to inject `loglevel=8 initcall_debug` and still boot to
   `MikroTik Login:`. This is the single most valuable thing to hand the reporter: it turns
   a bare panic line into a full trace, and will print the `error %d` from
   `Failed to execute /init` if that is what is happening.

**Leading theory is now T6b: `/init` unpacked fine but `execve("/init")` failed on M4.**
That is the only path in Linux 5.6 that produces `No working init found` *without* the VFS
panic we reproduced. One verbose M4 run distinguishes it from every alternative.

### Correction notice — the SSBS mechanism

The published root cause ("Apple M4 removes FEAT_SSBS; RouterOS's Linux 5.6.3 kernel
assumes it and panics") is **contradicted by pre-existing local evidence**: this same
kernel boots fine on `cortex-a53`, `cortex-a72`, and `neoverse-n1` — none of which
implement FEAT_SSBS (ARMv8.5; those are ARMv8.0/8.0/8.2). See E7–E9,
`mikropkl/Lab/qemu-arm64/NOTES.md:241-244`.

`FEAT_SSBS=0` remains a good **marker** for "M4-or-later Apple chip" — all the shipped
fallback needs — but it is not the mechanism. quickchr's `DESIGN.md` #10 asserts causation;
mikropkl's `AGENTS.md` already states the honest altitude ("a compatibility heuristic, not
a proven mechanism"). **Reconcile quickchr to mikropkl's altitude** and cite E7–E9.

---

## Symptom

Reporter's M4, `-accel hvf -cpu host`, aarch64 CHR 7.22.1:

```text
EFI stub: Booting Linux Kernel...
EFI stub: Generating empty DTB
EFI stub: Exiting boot services and installing virtual address map...
[    0.076915][    T1] Kernel panic - not syncing: No working init found.  Try passing init= option to kernel.
[    0.077579][    T1] SMP: stopping secondary CPUs
[    0.077802][    T1] Kernel Offset: disabled
[    0.078206][    T1] CPU features: 0x20012,28000230
[    0.078371][    T1] Memory Limit: none
[    0.078371][    T1] Rebooting in 5 seconds..
```

The EDK2 noise above this (`Image type X64 can't be loaded on AARCH64 UEFI system`,
`Tpm2...`, `Error: Image at ... start failed`) **also appears on successful boots** —
confirmed both by the reporter and locally. Not a lead.

**A successful boot prints no kernel messages at all** — it goes straight from
`EFI stub: Exiting boot services...` to `MikroTik 7.22.1 (stable)` / `MikroTik Login:`
(verified locally, E13). RouterOS boots with console loglevel suppressed, so the
`[ 0.0769]` lines in the M4 log exist *only* because panic output bypasses loglevel. There
is no timeline to diff without the cmdline injection in P0-1.

### Which panic means what (Linux 5.6, verified locally)

| Panic | Meaning | Reproduced locally? |
|-------|---------|---------------------|
| `VFS: Unable to mount root fs on unknown-block(0,0)` + `Please append a correct "root=" boot option` | no initrd **and** no mountable root device | **Yes** (E19) — direct-kernel/DT boot |
| `No working init found` | rootfs exists but no init could be **executed** from it | not yet — this is the M4 case |

`init/initramfs.c` (v5.6) line 661: the `Trying to unpack rootfs image as initramfs...`
path runs **only when `initrd_start` is set**. And `Initramfs unpacking failed` is
**KERN_EMERG** — it would print even at the M4's suppressed loglevel, and it does not
appear in the reporter's log. So on M4, the initrd either unpacked cleanly or was never
handed over.

---

## Verified Boot Chain

Established this pass by static image analysis plus a verbose local boot. Nothing here is
inferred from training data.

```text
EDK2 (edk2-aarch64-code.fd)
  └─ Boot0001 "UEFI Misc Device", no LoadOptions ⇒ kernel cmdline is EMPTY
     └─ vda1: FAT ESP, ONE file: /EFI/BOOT/BOOTAA64.EFI  (11,819,236 bytes)
        = uncompressed arm64 Image + EFI stub, "Linux version 5.6.3 ... #2 SMP Mon Mar 23 2026"
        ├─ built-in initramfs = kernel's 3-entry DEFAULT only (dev/, dev/console, root/) — NO /init
        └─ EFI stub supplies an EXTERNAL initrd  ⇒ "Freeing initrd memory: 72K"
           └─ 0.708s  Trying to unpack rootfs image as initramfs...   (⇒ initrd_start was set)
              0.994s  virtio_blk virtio0: [vda] 262144 512-byte logical blocks
              1.018s  vda: vda1 vda2
              1.254s  Freeing unused kernel memory: 640K
              1.272s  Run /init as init process        ← THE STEP THE M4 FAILS AT
                 └─ /init (RouterOS userspace) then:
                    1.397s  EXT4-fs (vda2): recovery required / recovery complete
                    1.447s  EXT4-fs (vda2): mounted filesystem
                    3.208s  EXT4-fs (vda2): resizing filesystem
                    3.209s  FAT-fs (vda1): mounted
                       └─ MikroTik 7.22.1 (stable) / MikroTik Login:
```

Notes that matter:

- **`/init` comes from the 72 KB EFI-supplied initrd, not from either partition.** vda2
  ("RouterOS", ext4, 92 MiB) contains only `lost+found`, `var`, `rw`, `boot`, `.asked` —
  **no `/sbin/init`, no `/bin/sh`** — plus the 13,696,208-byte system NPK at
  `/var/pdb/system/image`. vda2 is state, not root; it is mounted *by* `/init`, after it.
- The kernel has `virtio_blk` and `virtio_pci` built in but **no `pci-host-ecam-generic`
  and no `virtio_mmio`** (E11), so it depends on ACPI (MCFG) for PCI. Locally confirmed:
  `ACPI: MCFG table detected, 1 entries`.
- The only hardcoded root-device string in the kernel is `/dev/ram`; there is no
  `CONFIG_CMDLINE` carrying `root=`.

---

## Environments

| Item | Reporter (fails) | Maintainer (all local evidence) | CI |
|------|------------------|--------------------------------|----|
| Host | MacBook Air, **Apple M4** | 2020 MacBook Pro, **Intel x86_64** Core i9 | GitHub `macos-15` (Apple Silicon **VM**) |
| QEMU | 11.0.2 (Homebrew) | **11.0.3** (Homebrew) — see Q6 | runner-provided |
| aarch64 HVF | available, **panics** | **impossible** (Intel) | **impossible** (nested HVF unsupported) |
| aarch64 TCG | works | works | works |

No one on the project can run aarch64 HVF at all. Every aarch64-HVF datum came from the
reporter. See "Getting M4 Access".

---

## Evidence Ledger

Facts only, each with provenance. Add rows rather than rewriting prose.

| ID | Host | Accel | `-cpu` / `-M` | Result | Source |
|----|------|-------|---------------|--------|--------|
| E1 | M4 | hvf | `host` | panic, `No working init found`, t≈0.0769 | mikropkl#11 |
| E2 | M4 | hvf | `max` | **identical** panic, t≈0.0750 | mikropkl#11 (D1) |
| E3 | M4 | hvf | `host,ssbs=on/off` | QEMU refuses: `Property 'host-arm-cpu.ssbs' not found` | mikropkl#11 (D3) |
| E4 | M4 | tcg | (default) | **boots to RouterOS login** | mikropkl#11 |
| E5 | M4 | tcg | `cortex-a72` | **boots** | mikropkl#11 |
| E6 | M4 | — | — | `FEAT_SSBS=0`, `FEAT_SME=1/SME2=1`, `PAuth=1/2=1`, `MTE=0`, `sme_max_svl_b=64`, brand `Apple M4` | mikropkl#11 (D0) |
| E7 | Intel | tcg | `cortex-a53` (no SSBS) | **boot OK**, reaches userspace | `NOTES.md:241` |
| E8 | Intel | tcg | `cortex-a72` (no SSBS) | **boot OK** | `NOTES.md:242` |
| E9 | Intel | tcg | `neoverse-n1` (no SSBS) | **boot OK** | `NOTES.md:244` |
| E10 | Intel | tcg | `cortex-a710` | boots — shipped TCG default in both repos | `src/lib/qemu.ts`, `Pkl/QemuCfg.pkl:327` |
| E11 | — | — | — | kernel = Linux 5.6.3, `marvell,armada7040`; `virtio_pci` via ACPI; **no** `pci-host-ecam-generic`, **no** `virtio_mmio` | `NOTES.md` Phase 4 |
| E12 | M1/M2/M3 | hvf | `host` | "works" — **PROVENANCE UNKNOWN**, treat as unverified | `mikropkl/Files/QEMU.md:22,694` |
| **E13** | Intel | tcg | `-M virt` | **BOOT-OK**; successful boot prints **zero** kernel lines, straight to `MikroTik Login:` | local, this pass |
| **E14** | Intel | tcg | `-M virt,highmem=off` | **BOOT-OK** | local bisect |
| **E15** | Intel | tcg | `-M virt,highmem-ecam=off` | **BOOT-OK** | local bisect |
| **E16** | Intel | tcg | `-M virt,highmem-mmio=off` | **BOOT-OK** | local bisect |
| **E17** | Intel | tcg | `-M virt,highmem-redists=off` | **BOOT-OK** | local bisect |
| **E18** | Intel | tcg | control for E14 | ECAM (`pcie-mmcfg-mmio`) really moved: `virt` → **0x4010000000**, `highmem=off` → **0x3f000000** (`info mtree -f`) | local |
| **E19** | Intel | tcg | `-kernel` + `-append` (DT, no UEFI) | panic **`VFS: Unable to mount root fs on unknown-block(0,0)`** — a *different* panic from E1 | local |
| **E20** | Intel | tcg | UEFI, vda2 zeroed | EFI stub hands over, then silent hang (no panic) — a *third* distinct behavior | local |
| **E21** | Intel | tcg | UEFI + `startup.nsh` cmdline injection | **BOOT-OK with `loglevel=8 initcall_debug`**; full timeline in "Verified Boot Chain" | local |
| **E22** | — | — | — | vda1 = FAT (all arm64 images 7.20.8→7.23beta5); mikropkl's EXT2→FAT conversion is **x86-only**, so this is stock MikroTik layout | local |

**E12 is still a load-bearing assumption with no citation.** Nobody here has Apple Silicon
and CI cannot do nested HVF, so "HVF works through M3" may be inherited assumption. If
M1/M2 also fail, the M4-specific framing collapses and this is "aarch64 CHR has never
worked under HVF." **Reviewers: challenge this first.**

---

## Established (please do not re-litigate)

1. **Reproducible; the accelerator is the only variable** on the reporter's host (E1 vs E4).
2. **QEMU 11.0.2 cannot inject SSBS** — no such property (E3).
3. **Missing FEAT_SSBS is not sufficient to cause the panic** — three SSBS-less CPU models
   boot this same kernel (E7–E9).
4. **The upstream HVF SSBS shim is irrelevant here** — unmerged RFC, private Apple API,
   aimed at **old macOS guests**, not Linux.
5. **The guest memory-map / PCIe-ECAM axis is not the mechanism** (E14–E18, with control).
6. **The failure is downstream of root acquisition** — "no root device" panics differently
   (E19), and the M4 timestamp matches the `Run /init` step, not an early stage.
7. **`/init` comes from a 72 KB EFI-supplied initrd**, not from either disk partition (E21).

### Softened from the previous pass

**"`-cpu` is inert under HVF; the guest reads the physical CPU ID registers" is too strong.**
QEMU 11 *does* rewrite a guest-visible ID register under HVF:
`clamp_id_aa64mmfr0_parange_to_ipa_size()` (`target/arm/hvf/hvf.c:1066`, called from both
`hvf_arm_get_host_cpu_features` and `hvf_arm_set_cpu_features_from_host`) overwrites
`ID_AA64MMFR0.PARange` with the host's max IPA from `hv_vm_config_get_max_ipa_size()`. So
machinery for HVF guest-CPU-description control exists; E2 shows `max` ≡ `host`, which is
weaker than "nothing can be changed."

Also: `virt_get_valid_cpu_types()` (v11.0.2) permits **`cortex-a53` and `cortex-a57` under
HVF** — they are added under `if (target_aarch64())`, *not* gated on TCG; only `a710`/`a72`
etc. are TCG-only, and `host` is the accel-only addition. So "HVF requires `-cpu host`"
(mikropkl `Pkl/QemuCfg.pkl:329`) is right about `cortex-a710` but wrong as a
generalization. **`-accel hvf -cpu cortex-a53` is a legal, never-tried configuration** —
see P0-3.

---

## Theories

### T6b — `/init` unpacked but `execve("/init")` failed (LEADING)

- **Mechanism:** the initrd unpacks, `/init` exists, `prepare_namespace()` is therefore
  skipped, and `run_init_process("/init")` fails. The kernel prints
  `Failed to execute /init (error %d)` (KERN_ERR — suppressed at the M4's loglevel), falls
  through the `/sbin/init`, `/etc/init`, `/bin/init`, `/bin/sh` list, and panics
  `No working init found`.
- **Supports:** the *only* Linux 5.6 path to that panic that does not first hit the VFS
  panic we reproduced (E19). Matches the timestamp (point 2 of the summary). Consistent
  with `-cpu` being irrelevant under HVF (E2) — it would be a property of the physical CPU.
- **Contradicts:** nothing yet.
- **Discriminating test:** **P0-1** — the verbose recipe prints the `error %d`.
- **If true:** the error code names the owner. `-ENOEXEC` → binary/ABI rejection
  (MikroTik). `-EFAULT`/`-EIO` → memory/page-permission handling (QEMU/HVF). Note a `SIGILL`
  *after* a successful exec would give `Attempted to kill init`, not this panic — so a
  plain "unsupported instruction in `/init`" is **excluded**.

### T6a — the EFI stub never handed over the initrd on M4

- **Mechanism:** `initrd_start` unset ⇒ only the 3-entry default rootfs ⇒ no `/init`.
- **Supports:** would explain a missing `/init` without any CPU involvement.
- **Contradicts:** this path calls `prepare_namespace()`, which on this kernel should give
  the E19 panic (`VFS: Unable to mount root fs`), and the M4 did **not** show that.
  Disfavored unless `Root_RAM0` mounts "successfully" as an empty ramdisk.
- **Discriminating test:** P0-1 — presence of `Trying to unpack rootfs image as initramfs...`
  and `Freeing initrd memory: 72K` in the M4 log.
- **If true:** owner = QEMU/firmware (EFI memory handover under HVF).

### T1 — FEAT_SSBS feature gap (the shipped heuristic)

- **Contradicted as a mechanism** by E7–E9; upstream Linux 5.6 treats SSBS as optional
  (`has_ssbd_mitigation()` falls back to the SMCCC conduit). Retain as a *marker* only.
- No discriminating test is available (E3 — cannot be toggled under HVF).

### T4 — Inconsistent ID-register profile (v8.5+ minus SSBS)

- **Mechanism:** not "SSBS missing" but "SSBS missing within an otherwise ARMv8.6/9-class
  profile" — a combination no real ARM design ships and no TCG model can express. Survives
  E7–E9 (a53/a72/n1 present *coherent* profiles). Could plausibly break an `execve` of a
  binary built with specific ABI assumptions, so it composes with T6b.
- **Discriminating test:** P0-3 (`-cpu cortex-a53` under HVF) and P1-2 (dump the actual
  M4-through-HVF ID registers).
- **If true:** owner = MikroTik or QEMU.

### T3 — SME exposed through HVF

- M4 is the first Apple chip with FEAT_SME (E6) and HVF is documented to leak the SME flag
  to QEMU (qemu#2665, which aborted QEMU startup — 11.0.2 evidently fixed that symptom).
  A guest-side variant is conceivable but has no evidence. Would be largely retired by P0-2.

### T2 — Guest memory map / IPA divergence — **FALSIFIED**

Killed locally this pass by E14–E18 with the E18 control. Retained only so nobody
re-proposes it. The source path is real (`virt_set_memmap()`; `!highmem ⇒ pa_bits=32`; high
IO base fixed at 256 GiB ⇒ needs ≥39 bits; under HVF `pa_bits` comes from
`hvf_arch_get_max_ipa_bit_size()` → `hv_vm_config_get_max_ipa_size()`), and the ECAM does
move between layouts (E18) — **this kernel simply does not care.**

### T5 — Embedded initramfs unpack failure — **RETIRED**

Superseded: the built-in initramfs is only the kernel's 3-entry default, the real `/init`
comes from the EFI initrd (T6a/T6b), and `Initramfs unpacking failed` is KERN_EMERG and
absent from the M4 log.

---

## Proposed Test Plan

**P0-1 alone would likely settle ownership.** Everything is one batch — the reporter is a
volunteer, and a rented M4 bills 24 hours minimum.

### P0-1 — verbose boot on the real UEFI+ACPI path (verified locally, E21)

Injects a kernel cmdline where EDK2's auto-generated boot option provides none, without
switching the guest off UEFI/ACPI. Run on a **copy** of the image.

```sh
# 1. Extract the ESP (partition 1), edit it, splice it back.
IMG=~/vms/chr.aarch64.qemu.7.22.1.utm/Data/chr-7.22.1-arm64.img
cp "$IMG" /tmp/verbose.img
dd if=/tmp/verbose.img of=/tmp/p1.fat bs=512 skip=2048 count=67584 status=none
hdiutil attach -imagekey diskimage-class=CRawDiskImage -mountpoint /tmp/mnt /tmp/p1.fat

# 2. Move the default loader aside so EDK2 falls through to its EFI Shell,
#    and have the shell launch the kernel WITH arguments.
mv /tmp/mnt/EFI/BOOT/BOOTAA64.EFI /tmp/mnt/EFI/BOOT/ROSKRNL.EFI
printf 'FS0:\\EFI\\BOOT\\ROSKRNL.EFI loglevel=8 initcall_debug earlycon=pl011,0x9000000\r\n' \
  > /tmp/mnt/startup.nsh

hdiutil detach /tmp/mnt
dd if=/tmp/p1.fat of=/tmp/verbose.img bs=512 seek=2048 conv=notrunc status=none

# 3. Boot it under HVF with the same everything else, capturing serial.
cp /opt/homebrew/share/qemu/edk2-arm-vars.fd /tmp/vars.fd
qemu-system-aarch64 -M virt -accel hvf -cpu host -m 512 -smp 1 \
  -drive if=pflash,format=raw,readonly=on,unit=0,file=/opt/homebrew/share/qemu/edk2-aarch64-code.fd \
  -drive if=pflash,format=raw,unit=1,file=/tmp/vars.fd \
  -drive file=/tmp/verbose.img,format=raw,if=none,id=drive0 \
  -device virtio-blk-pci,drive=drive0 \
  -netdev user,id=net0 -device virtio-net-pci,netdev=net0 \
  -display none -vga none -monitor none -serial stdio | tee /tmp/m4-verbose.log
```

**Post the whole log.** What we read off it, in order:

| Look for | If present | If absent |
|----------|-----------|-----------|
| `Trying to unpack rootfs image as initramfs...` + `Freeing initrd memory: 72K` | initrd handover worked → **T6a dead** | **T6a live** — EFI/HVF handover problem (owner C) |
| `Failed to execute /init (error N)` | **T6b confirmed**; the error code names the owner (see T6b) | look at what the last initcall was instead |
| `virtio_blk virtio0: [vda]` + `vda: vda1 vda2` | disk fine (as expected) | contradicts E19 reasoning — re-open the disk family |
| `Run /init as init process` | got to the same step we do | died before it — compare the last `initcall` line to ours |

The equivalent successful log from this Intel box is in "Verified Boot Chain" and can be
regenerated any time with the same recipe under `-accel tcg,tb-size=256 -cpu cortex-a710`.

### P0-2 — modern arm64 Linux under identical HVF (the "QEMU vs MikroTik" question)

Boot an Alpine/Ubuntu arm64 ISO with the same `-accel hvf -cpu host -M virt` and a
`virtio-blk-pci` disk.

- **Boots** → the M4-through-HVF platform is fine for a modern guest ⇒ RouterOS is
  implicated (owner **B**), and we file upstream with the P0-1 log.
- **Also fails** → the platform is broken ⇒ owner **C**; upstream issue + version floor.

Still not run; highest-information test after P0-1.

### P0-3 — `-cpu cortex-a53` under HVF (new; never tried)

```sh
qemu-system-aarch64 ... -accel hvf -cpu cortex-a53 -M virt ...
```

Legal per `virt_get_valid_cpu_types()` (see "Softened"), contrary to the "HVF requires
`-cpu host`" assumption. If QEMU starts *and* CHR boots, that is a **fix that keeps HVF**
(owner A) — the single best outcome available. If QEMU refuses, we have a one-line fact
that retires the idea permanently.

### P1 — mechanism detail (only if P0 is inconclusive)

1. Full host feature dump: `sysctl hw.optional.arm` (**everything**, not a grep) — E6 was a
   grep of four families.
2. From a guest that *does* boot under HVF (P0-2): `dmesg | grep -i "CPU features"` plus
   `ID_AA64PFR0/1_EL1` and `ID_AA64MMFR0_EL1` (PARange). This is the M4-through-HVF profile
   no TCG model can express; it feeds T4.
3. `info mtree -f` from the QEMU monitor under HVF — now only a diagnostic (reads back the
   effective IPA via which high regions survived), no longer a theory test. Compare with
   E18.

### P2 — version axis

`brew install --HEAD qemu` (11.1.x-rc or HEAD) and re-run P0-1/P0-2 unchanged. If HVF boots
on a newer QEMU, the durable fix is a **version floor** and the TCG fallback becomes
conditional.

### Local follow-ups (no M4 needed)

1. Regenerate the E21 successful verbose log and attach it to mikropkl#11 as the reference
   diff (one command; ~1 min under TCG).
2. Determine *how* the EFI stub obtains the 72 KB initrd (it is not a file on the ESP and
   the cmdline is empty) — likely a MikroTik patch. Answering this sharpens T6a and is pure
   local image/kernel analysis.
3. Re-run `Lab/qemu-arm64/cpu-test.sh` if any doubt remains about E7–E9.

---

## Getting M4 Access

All bare metal, so Hypervisor.framework is available. **macOS CI runners are not an
option** — GitHub-hosted and Cirrus runners are macOS VMs under Virtualization.framework,
which does not expose nested virtualization, so M4 can never be a CI lane, only a rented
box.

| Option | Cost for a one-off | Notes |
|--------|--------------------|-------|
| **Scaleway Apple silicon M4** | **€0.22/hr, 24 h minimum ≈ €5.30** | dedicated Mac mini, "no hypervisor"; Scaleway documents running UTM/QEMU on it. Recommended. |
| AWS `mac-m4.metal` | ~$1.23/hr, 24 h minimum ≈ **$30** | dedicated host; us-east-1/us-west-2; Mac host quota usually 0 by default — budget a day |
| Used Mac mini M4 | ~$500 one-time | the durable answer if M4 keeps costing cycles across quickchr / mikropkl / chr-armed |

Both clouds enforce a 24-hour minimum allocation (Apple licensing). Nothing needs building:
`brew install qemu`, install bun, then `bunx @tikoci/quickchr launch --arch arm64` and
`QUICKCHR_INTEGRATION=1 bun test`. `mikropkl/Lab/qemu-arm64/cpu-test.sh` and
`mikropkl/Tests/accel-detect.sh` are already the harness. It is a runbook, not a system.

Apple added nested virtualization for M3+ in macOS 15, so a hosted-runner lane may become
possible eventually — but no macOS CI provider exposes it today (Tart, which Cirrus uses,
does not).

---

## Implications for quickchr

- **The shipped fallback stays.** `hostLacksSsbs()` → TCG for arm64 (`src/lib/platform.ts`)
  is right under every surviving theory: TCG boots, HVF panics, and the probe identifies
  the affected class correctly.
- **`DESIGN.md` #10 needs two corrections**: (a) drop the causal SSBS claim in favor of
  mikropkl's "compatibility heuristic, not a proven mechanism", citing E7–E9; (b) soften
  "the guest reads the *physical* CPU ID registers — the `-cpu` model is inert" — QEMU 11
  rewrites `ID_AA64MMFR0.PARange` under HVF, and `cortex-a53`/`a57` are legal HVF CPU
  models. `ssbsTcgWarning()`'s user-facing text has the same causal problem and should say
  *why we downgrade* without asserting a cause.
- **The restore signal is still unsolved and correctly deferred.**
  `hw.optional.arm.FEAT_SSBS` describes the host CPU and will never flip, so HVF cannot
  auto-restore from this probe; a `getQemuVersion()` floor waits on P2 finding a build that
  boots.
- **If P0-3 wins, the fix moves layers** — from `detectAccel()` (accelerator choice) to the
  CPU-model argument in `src/lib/qemu.ts:76`, and the SSBS probe is demoted to a warning.
  That would retain HVF speed on M4, so P0-3 is cheap and high-value.
- **The P0-1 recipe is reusable beyond this bug**: any "CHR won't boot and prints nothing"
  report can be turned into a full trace with it. Worth a home in `test/lab/` or the
  `routeros-qemu-chr` skill once this issue closes.

---

## Open Questions for Reviewers

- **Q1 — ANSWERED.** Embedded initramfs vs `root=`: neither. `/init` arrives in a 72 KB
  **EFI-supplied initrd**; the built-in initramfs is the kernel's 3-entry default; vda2 is
  state, not root. See "Verified Boot Chain".
- **Q2 — OPEN, highest leverage.** Provenance of E12 (aarch64 HVF works on M1/M2/M3)? If
  assumption, the M4-specific framing may be wrong.
- **Q3 — superseded by Q4.**
- **Q4 — ANSWERED.** `-M virt` under HVF ≥9.2 derives `pa_bits` from
  `hv_vm_config_get_max_ipa_size()`; `!highmem ⇒ pa_bits=32`; high regions are enabled by a
  `fits` test against `2^pa_bits`, with the high IO base fixed at 256 GiB. **But this axis
  does not affect CHR** (E14–E18), so it is now only a diagnostic.
- **Q5 — OPEN.** Is the failure sensitive to guest RAM size or `-smp`? Neither has been
  varied on the M4. Cheap to add to P0-1.
- **Q6 — NEW.** Local repro used QEMU **11.0.3**; the reporter has **11.0.2**. All local
  results should be re-checked against 11.0.2 if anything hinges on the difference.
- **Q7 — NEW.** How does the EFI stub obtain the 72 KB initrd? Not a file on the ESP, and
  the cmdline is empty — likely a MikroTik kernel/stub patch. Answering this decides how
  plausible T6a is. Local work.

---

## References

- tikoci/mikropkl#11 — original report, D0/D1/D3/D4 (reporter: payam124)
- tikoci/quickchr#97, #98 — quickchr issue and the merged TCG-fallback fix
- tikoci/mikropkl#12 — mikropkl's parallel fallback PR (open at time of writing)
- `mikropkl/Lab/qemu-arm64/NOTES.md` — arm64 CHR lab: CPU sweep (E7–E9), kernel binary
  analysis (E11), `check-installation` findings
- `mikropkl/AGENTS.md` §"FEAT_SSBS-less Apple hosts (M4+) fall back to TCG" — honest-altitude wording
- `quickchr/DESIGN.md` #10 — current (overstated) quickchr statement
- `docs/qga-x86-macos-qemu10-investigation.md` — prior art for this document's shape, and a
  cautionary tale about a confidently-wrong first diagnosis
- QEMU v11.0.2 sources read this pass: `hw/arm/virt.c` (`virt_set_memmap`,
  `virt_set_high_memmap`, `virt_get_valid_cpu_types`, `base_memmap`/`extended_memmap`),
  `target/arm/hvf/hvf.c` (`hvf_arch_get_max_ipa_bit_size`,
  `clamp_id_aa64mmfr0_parange_to_ipa_size`)
- Linux v5.6 `init/initramfs.c` — `populate_rootfs()`; the `initrd_start` gate at line 661
- QEMU: [issue 2665](https://gitlab.com/qemu-project/qemu/-/issues/2665) (HVF leaks SME on
  M4), [HVF SSBS RFC v2](https://lists.libreplanet.org/archive/html/qemu-arm/2025-10/msg00421.html)
  (unmerged, old-macOS guests), [hvf >63 GB RAM / IPA sizing](https://www.mail-archive.com/qemu-devel@nongnu.org/msg1060511.html),
  [virt highmem memory map](https://www.mail-archive.com/qemu-devel@nongnu.org/msg868539.html)
- [Tart: nested virtualization unsupported](https://github.com/cirruslabs/tart/discussions/701)
