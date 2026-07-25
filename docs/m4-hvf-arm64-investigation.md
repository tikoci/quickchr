# aarch64 CHR Panics Under HVF on Apple Silicon

**Date:** 2026-07-25
**Investigator:** quickchr / tikoci (consolidating tikoci/mikropkl#11,
tikoci/quickchr#97, and tikoci/quickchr#98)
**Status:** **ROOT CAUSE STRONGLY ESTABLISHED — the shipped artifact, reporter's
runtime capability bitmap, QEMU 11.0.2 source, and MikroTik's best-available GPL
disclosure all converge on the same mechanism.** The exact `-ENOEXEC` line has
not been observed on the reporter's M4, and MikroTik has not published source
cryptographically tied to RouterOS 7.22.1. A verbose M4 log would close those
last evidence-provenance gaps, but is not required to choose the mitigation.

> **Direct runtime evidence (2026-07-25 review).** The reporter's panic printed
> the guest kernel's capability bitmap. Decoded against Linux v5.6
> `cpucaps.h`—also unchanged in MikroTik's only published 5.6.3 kernel
> patch—the M4/HVF guest **lacks `ARM64_HAS_32BIT_EL0`** while the booting TCG
> guest has it. See E15/E16 and "Runtime Evidence". In the disclosed loader
> source, that makes `system_supports_32bit_el0() == false`, the exact gate that
> rejects the shipped ELF32 `/init` with `-ENOEXEC`.

The failure is not currently supported as an SSBS bug, an M4 memory-map bug, or
a missing-disk bug. The shipped arm64 CHR boot chain mixes architectures:

```text
64-bit arm64 Linux kernel
  └─ appended XZ-compressed initramfs
       └─ /init = 32-bit ARM EABI executable
            └─ system package = mixed AArch64 kernel modules and ARM32 userspace
```

TCG CPU models provide AArch32 EL0 and can execute `/init`. Under HVF, QEMU
passes through the hardware-backed `ID_AA64PFR0_EL1`; on the reported M4 its
EL0/EL1 fields are AArch64-only. The best-available Linux source therefore
predicts rejection of the 32-bit `/init` with `-ENOEXEC` and, because the
initramfs contains no fallback `/sbin/init`, `/etc/init`, `/bin/init`, or
`/bin/sh`, the observed panic:

```text
No working init found. Try passing init= option to kernel.
```

This predicts that the issue affects **all Apple Silicon hosts using arm64 HVF**,
not only M4. M4/`FEAT_SSBS=0` is an accidental marker for the first reported
host, not the mechanism.

---

## Executive Summary

### Root-cause chain

Every link below is grounded in the actual 7.22.1 image, QEMU 11.0.2 source, or
Linux 5.6.3 source. The Linux source is corroborated by MikroTik's published
patch, but the disclosure is not specific to 7.22.1:

1. `BOOTAA64.EFI` is a 64-bit arm64 Linux 5.6.3 kernel.
2. At byte offset `11,739,140`, that file contains an appended XZ stream. It
   decompresses to a 169,984-byte `newc` initramfs with four entries:
   `dev/`, `dev/ram0`, `dev/console`, and `/init`.
3. `/init` is a 169,168-byte, statically linked **ELF 32-bit LSB ARM EABI5**
   executable, SHA-256
   `69859b2fcdb329580b8fdad2e1b72e29526294708f58ced413b58895af85e706`.
4. The 7.22.1 arm64 system package is also mixed: a filesystem scan found 101
   ARM32 executables and 18 ARM32 shared objects. The only two AArch64
   executables were `kexec` and `vmcore-dmesg`; the other AArch64 ELF files were
   kernel modules. Replacing `/init` alone would not produce a usable system.
5. Linux v5.6 arm64's `compat_elf_check_arch()` accepts an `EM_ARM` ELF only
   when `system_supports_32bit_el0()` is true. A failed architecture check
   returns `-ENOEXEC` (`-8`). MikroTik's only published 5.6.3 patch does not
   modify this gate, its capability numbering, or the init fallback logic, and
   its arm64 config enables `CONFIG_COMPAT` and `CONFIG_COMPAT_BINFMT_ELF`.
6. QEMU v11.0.2 reads the real HVF vCPU's `ID_AA64PFR0_EL1` and exposes it to
   the guest. For `host`/`max`, its host probe also refuses to initialize unless
   `{EL1,EL0} == 0x11`, meaning AArch64-only at both exception levels. This is a
   fail-closed assertion, not a feature mask.
7. Linux logs `Run /init as init process` immediately before `execve()`. If
   the disclosed 5.6.3 behavior matches the shipped binary, `/init` returns
   `-ENOEXEC`, Linux logs `Failed to execute /init (error -8)`, tries four
   absent fallback paths, and emits the reported panic.
8. A local TCG control with the real 7.22.1 UEFI/ACPI boot path executes the
   same 32-bit `/init`, mounts the disk from userspace, and reaches
   `MikroTik Login:`.

### What an M4 verbose boot would add (optional)

The working diagnosis is strong without it (see "Runtime Evidence"), so this is
**nice-to-have corroboration, not a blocker.** A verbose HVF boot should contain:

```text
Run /init as init process
Failed to execute /init (error -8)
Kernel panic - not syncing: No working init found
```

It is worth collecting only if preparing an upstream MikroTik report: it would
observe the predicted errno in the actual 7.22.1 binary and reduce reliance on
the stale GPL disclosure. The `cortex-a53` question no longer needs reporter
testing; QEMU source establishes that the live HVF vCPU still exposes the
hardware `ID_AA64PFR0_EL1` for named CPU models.

### Product consequence

There is no current QEMU flag that makes physical Apple Silicon execute AArch32
guest userspace through HVF. The durable fix is for MikroTik to ship an
ARM32-free arm64 CHR userspace—not merely an AArch64 `/init`. Until then:

- TCG is the safe accelerator for current arm64 CHR on **all** Apple Silicon.
- A QEMU version floor is not a credible restore signal unless a future QEMU
  explicitly adds mixed HVF/software execution for AArch32, which it does not
  do today.
- `FEAT_SSBS=0` is too narrow as a fallback predicate; it leaves M1/M2/M3
  exposed to the same artifact-level incompatibility.

### Independent-review verdict and reporter follow-up

The 2026-07-25 independent review agrees with the mechanism and product
consequence. It added three qualifications/findings:

1. MikroTik's published GPL source corroborates the stock Linux behavior but
   cannot prove the exact 7.22.1 binary because the disclosure is stale and not
   per-release.
2. QEMU source closes the named-CPU-model question: `cortex-a53` cannot restore
   AArch32 EL0 under HVF, even though the model advertises it internally under
   TCG.
3. `/init` is only the first incompatible executable. The 7.22.1 system
   package contains extensive ARM32 runtime userspace, so changing `/init` alone
   is not a durable fix.

**Recommendation: do not send the reporter another exploratory test ladder.**
The useful homework is complete, and none of `cortex-a53`, QEMU HEAD, a modern
Linux guest, SSBS toggles, or more CPU models can change the artifact-level
incompatibility. If a MikroTik report is being prepared, one optional request
for a verbose `-accel hvf -cpu host` boot is justified to capture
`Failed to execute /init (error -8)` from the shipped binary. Otherwise, thank
the reporter for the existing data and avoid another round-trip.

---

## Symptom

Reporter's Apple M4, QEMU 11.0.2, arm64 CHR 7.22.1:

```text
EFI stub: Booting Linux Kernel...
EFI stub: Generating empty DTB
EFI stub: Exiting boot services and installing virtual address map...
[    0.076915][    T1] Kernel panic - not syncing: No working init found.  Try passing init= option to kernel.
[    0.077579][    T1] SMP: stopping secondary CPUs
[    0.077802][    T1] Kernel Offset: disabled
[    0.077995][    T1] CPU features: 0x20012,28000230
[    0.078206][    T1] Memory Limit: none
[    0.078371][    T1] Rebooting in 5 seconds..
```

The EDK2 messages above this (`Image type X64 can't be loaded on AARCH64 UEFI
system`, `Tpm2...`, and `Error: Image at ... start failed`) also appear on the
successful TCG boot and are unrelated.

The original report described this as failure to reach the root filesystem.
That interpretation is incorrect. In the successful verbose control,
`Run /init as init process` appears **before** `vda: vda1 vda2` and before the
EXT4 mount. RouterOS's `/init` discovers and mounts the disk. The kernel panic
therefore occurs before disk discovery is required.

### What the panic proves—and does not prove

Linux v5.6 follows this sequence:

1. If `/init` exists in the initramfs, retain it as
   `ramdisk_execute_command`; otherwise call `prepare_namespace()`.
2. Log `Run /init as init process`.
3. Call `execve("/init")`.
4. If it fails, log the error except for later fallback paths that return
   `-ENOENT`.
5. Try `/sbin/init`, `/etc/init`, `/bin/init`, and `/bin/sh`.
6. Panic with `No working init found` if none executes.

Therefore the panic says no init candidate could execute. It does **not** by
itself prove that the initrd unpacked, that the disk was probed, or that a root
filesystem was mounted. The verbose log supplies those missing facts.

The earlier localization by timestamp comparison (TCG `Run /init` at ≈1.27s vs
the HVF panic at 0.0769s) is **superseded** by the capability-bitmap decode and
should no longer be relied on — the bitmap is direct evidence and the timing
argument is now redundant.

For the record, the stated objection to it is itself not quite right: the guest
architectural timer is driven by QEMU's virtual clock, which under TCG *without*
`icount` follows host wall-clock, so a speed-ratio comparison was defensible.
The point is moot either way; use E15/E16.

---

## Verified Artifact and Boot Chain

### Static image analysis

The stock 7.22.1 image contains:

```text
vda1 FAT ESP
  └─ /EFI/BOOT/BOOTAA64.EFI
       ├─ arm64 Linux 5.6.3 EFI-stub kernel
       ├─ built-in default initramfs: dev/, dev/console, root/
       └─ appended XZ stream at offset 11,739,140
            └─ newc initramfs, 169,984 bytes
                 ├─ dev/
                 ├─ dev/ram0
                 ├─ dev/console
                 └─ init
                      ELF 32-bit LSB ARM, EABI5, static
```

The appended archive explains the earlier confusing observation that
`Freeing initrd memory: 72K` appeared despite no separate initrd file on the
ESP and no `initrd=` command-line option. "EFI-supplied external initrd" was an
imprecise description: the archive is appended to the kernel file and the
MikroTik EFI boot path hands it to Linux as an initrd.

The architecture mix is not unique to 7.22.1:

| CHR image | `/init` type | `/init` SHA-256 |
|-----------|--------------|-----------------|
| 7.20.8 arm64 | ELF32 ARM EABI5, static | `ac38d4da59c5801aa645c28fd435f4143b07c43c0cbd5907570b0646af033352` |
| 7.22.1 arm64 | ELF32 ARM EABI5, static | `69859b2fcdb329580b8fdad2e1b72e29526294708f58ced413b58895af85e706` |
| 7.23beta5 arm64 | ELF32 ARM EABI5, static | `5cf17a2e32548c0ae2a9bbabe27dcfa8a145f382abeef17bd3990d4a36064385` |

### The system package also requires AArch32

A fresh review extracted `/var/pdb/system/image` from the same 7.22.1 arm64
root filesystem, unpacked its SquashFS payload, and classified every ELF with
`file`:

| ELF role | ARM32 | AArch64 |
|----------|------:|--------:|
| Executables | 101 | 2 |
| Shared objects | 18 | 0 |
| Relocatable kernel modules | 0 | 282 |

The two AArch64 executables are `sbin/kexec` and `sbin/vmcore-dmesg`.
Representative ARM32 runtime programs include `sbin/sysinit`,
`nova/bin/user`, `nova/bin/net`, `nova/bin/route`, and `nova/bin/snmp`; the
package's `lib/libc.so` is also ARM32.

This strengthens the ownership and fix conclusion. The immediate panic is the
kernel failing to execute the first ARM32 program, `/init`, but replacing only
that file would merely move failure later. Apple-Silicon HVF needs a RouterOS
arm64 artifact whose required userspace is AArch64 throughout (or a future
mixed-execution mechanism that does not exist today).

### Successful TCG control

The local control used the shipped 7.22.1 topology: UEFI, ACPI, 1024 MiB RAM,
two vCPUs, explicit `virtio-blk-pci`, and `cortex-a710` under TCG. Relevant
ordering:

```text
Trying to unpack rootfs image as initramfs...
Freeing initrd memory: 72K
virtio_blk virtio0: [vda] 262144 512-byte logical blocks
Freeing unused kernel memory: 640K
Run /init as init process
  with arguments:
    /init
vda: vda1 vda2
EXT4-fs (vda2): recovery complete
EXT4-fs (vda2): mounted filesystem
MikroTik Login:
```

The partition scan completing after `/init` begins is expected: the 32-bit
RouterOS init program opens `/dev/vda1`, reads GPT, and mounts the state
partition.

---

## Runtime Evidence

The panic itself printed the most important runtime evidence, and it has been
sitting in mikropkl#11 since the original report. Linux v5.6
`arch/arm64/kernel/cpufeature.c:67-71`:

```c
static int dump_cpu_hwcaps(struct notifier_block *self, unsigned long v, void *p)
{
    /* file-wide pr_fmt adds "CPU features: " prefix */
    pr_emerg("0x%*pb\n", ARM64_NCAPS, &cpu_hwcaps);
```

`%*pb` is the kernel bitmap format: comma-separated 32-bit chunks, **most
significant chunk first**. With `ARM64_NCAPS == 51` the top chunk covers bits
32–50 and prints as 5 hex digits, the low chunk covers bits 0–31 as 8 digits —
which is exactly the shape of both observed strings (`0x20012,28000230`).

Decoded against v5.6 `arch/arm64/include/asm/cpucaps.h`
(`ARM64_HAS_32BIT_EL0 == 13`):

| Guest | Bitmap | Caps | `ARM64_HAS_32BIT_EL0` |
|-------|--------|------|------------------------|
| M4, HVF `-cpu host` — **panics** | `0x20012,28000230` | 8 | **ABSENT** |
| Intel, TCG `cortex-a710` — **boots** | `0x20013,28402230` | 11 | **PRESENT** |

The M4 guest's capability set is a **strict subset** of the booting guest's. The
only three differences are `ARM64_HAS_32BIT_EL0`, `ARM64_SVE`, and
`ARM64_HAS_STAGE2_FWB`; the latter two are a userspace vector extension and a
stage-2 attribute feature, neither of which participates in `execve()` of a
userspace binary.

Under the published 5.6.3 mapping and loader path, the M4 guest has
`system_supports_32bit_el0() == false`, so `compat_elf_check_arch()` rejects the
`EM_ARM` `/init` with `-ENOEXEC`. Combined with the actual ELF32 artifact and
the exact panic this path produces, this is a strongly established chain. It is
not the same as observing `error -8` directly from the shipped 7.22.1 binary.

**Provenance caveat:** the `cortex-a710` bitmap comes from a direct-kernel (DT)
control boot, which is a different boot path than the shipped UEFI/ACPI one — a
*successful* UEFI boot never panics, so it never prints a bitmap. The comparison
is nonetheless valid for CPU capability bits, which reflect the CPU, not the
boot path.

### MikroTik GPL cross-check and provenance boundary

The upstream-kernel inference was checked against
[`tikoci/mikrotik-gpl`](https://github.com/tikoci/mikrotik-gpl), not left at
stock Linux:

- MikroTik's published `linux-5.6.3.patch` has no hunks for
  `arch/arm64/include/asm/elf.h`,
  `arch/arm64/include/asm/cpucaps.h`,
  `arch/arm64/kernel/cpufeature.c`, or `fs/compat_binfmt_elf.c`.
- Its `init/main.c` changes do not touch `/init` selection, `execve()`, the
  fallback list, or `No working init found`.
- Its `fs/binfmt_elf.c` changes add unrelated `CONFIG_HOMECACHE` hooks; they do
  not alter the ELF architecture rejection path.
- Its arm64 config has `CONFIG_COMPAT=y` and
  `CONFIG_COMPAT_BINFMT_ELF=y`.
- The disclosed tree assigns `ARM64_HAS_32BIT_EL0` to bit 13, prints the panic
  bitmap with `%*pb`, and uses `system_supports_32bit_el0()` in
  `compat_elf_check_arch()` exactly as cited above.

This is strong corroboration, not exact-build proof. The repository README says
the only received sources are internally dated 2022 and were supplied in
response to a RouterOS 7.18.2 request. MikroTik has not provided regular
per-build disclosure, and nothing cryptographically links that tree to the
7.22.1 `BOOTAA64.EFI`. An unpublished later patch is therefore logically
possible. The actual bitmap, ELF32 `/init`, matching 5.6.3 base version, and
matching panic make such a patch an unsupported escape hatch, not a competing
theory.

### Why a named CPU model cannot restore AArch32 under HVF

QEMU has two relevant layers:

1. `hvf_arm_get_host_cpu_features()` copies the host feature registers for
   `host`/`max` and fails the probe unless `ID_AA64PFR0_EL1[7:0] == 0x11`.
2. `hvf_arch_init_vcpu()` runs for every HVF CPU model, reads the live vCPU's
   hardware-backed `ID_AA64PFR0_EL1`, changes only the GIC-version bit, and
   writes it back. That register is excluded from the normal modeled-register
   synchronization list in `sysreg.c.inc`.

Therefore `-cpu cortex-a53` can change QEMU's modeled metadata, but it cannot
make the guest observe or execute AArch32 EL0 on Apple hardware that lacks it.
The reporter does not need to test this.

### A local repro of `-ENOEXEC` is not achievable with QEMU's TCG models

Attempted and recorded so it is not retried: the plan was to boot CHR under TCG
with an AArch64-only CPU model, reproducing the M4 symptom on Intel hardware.

- `neoverse-v1` and `neoverse-n2` are **not** AArch64-only — `ID_AA64PFR0[7:0]`
  is `0x12`, i.e. AArch32 *is* available at EL0 (E18). They were the wrong
  vehicle; an early attempt with them tested the wrong thing, and produced no
  negative result. (The observed PXE fallthrough was an artifact of renaming the default
  loader in the verbose image, unrelated to CPU features.)
- `a64fx` is the only AArch64-only TCG model (`0x11`), but the RouterOS 5.6.3
  kernel hits `Kernel BUG at _stext+0xa4d8` / `Internal error: Oops - BUG` at
  `t=0.000000` on it, with `sve=off` and `sve512=off` alike — an unrelated,
  earlier incompatibility. It cannot host this experiment.

Hence the runtime conclusion above rests on the bitmap decode rather than a
local negative-control boot.

---

## Evidence Ledger

| ID | Host/artifact | Accel | Result | Source |
|----|---------------|-------|--------|--------|
| E1 | Apple M4, CHR 7.22.1 | HVF, `-cpu host` | `No working init found` | mikropkl#11 |
| E2 | Apple M4, CHR 7.22.1 | HVF, `-cpu max` | identical panic | mikropkl#11 |
| E3 | Apple M4, QEMU 11.0.2 | HVF, `host,ssbs=on/off` | property rejected | mikropkl#11 |
| E4 | Apple M4, CHR 7.22.1 | TCG default | boots | mikropkl#11 |
| E5 | Apple M4, CHR 7.22.1 | TCG, `cortex-a72` | boots | mikropkl#11 |
| E6 | Apple M4 | — | `FEAT_SSBS=0`, SME/SME2 present | mikropkl#11 |
| E7 | Intel Mac, CHR 7.22.1 | TCG, `cortex-a53` | boots | mikropkl arm64 lab |
| E8 | Intel Mac, CHR 7.22.1 | TCG, `cortex-a72` | boots | mikropkl arm64 lab |
| E9 | Intel Mac, CHR 7.22.1 | TCG, `neoverse-n1` | boots | mikropkl arm64 lab |
| E10 | Intel Mac, CHR 7.22.1 | TCG, `cortex-a710` | verbose UEFI/ACPI boot succeeds | local |
| E11 | Stock 7.22.1 `BOOTAA64.EFI` | — | appended initramfs `/init` is ELF32 ARM EABI5 | local static analysis |
| E12 | Stock 7.20.8 and 7.23beta5 | — | appended `/init` is also ELF32 ARM EABI5 | local static analysis |
| E13 | Linux v5.6 arm64 | — | compat ELF requires 32-bit EL0; rejection is `-ENOEXEC` | upstream source |
| E14 | QEMU v11.0.2 arm64 HVF | — | host features are passed through, host/max require AArch64-only EL0/EL1, and the live `ID_AA64PFR0_EL1` remains hardware-backed for named models | upstream source |
| **E15** | Apple M4 guest kernel, CHR 7.22.1 | HVF, `-cpu host` | panic bitmap `0x20012,28000230` decodes to 8 caps, **`ARM64_HAS_32BIT_EL0` (bit 13) ABSENT** | mikropkl#11 panic line, decoded locally |
| **E16** | Intel Mac guest kernel, CHR 7.22.1 | TCG, `cortex-a710` | panic bitmap `0x20013,28402230` decodes to 11 caps, **`ARM64_HAS_32BIT_EL0` PRESENT**; M4's set is a strict subset (only `HAS_32BIT_EL0`, `SVE`, `HAS_STAGE2_FWB` differ) | local |
| **E17** | Stock 7.22.1 `BOOTAA64.EFI` | — | independent re-verification of E11: XZ at offset 11,739,140 → 169,984-byte `newc` archive → `/init` = ELF 32-bit LSB ARM EABI5 static, 169,168 bytes, SHA-256 `69859b2f…e706` (**exact match**) | local, second pass |
| **E18** | QEMU v11.0.2 TCG models | — | `ID_AA64PFR0[7:0]`: `cortex-a53`/`a72` `0x22`, `a710`/`neoverse-n1`/`neoverse-v1` `0x12` — **all provide AArch32 at EL0**; only `a64fx` is `0x11` (AArch64-only) | local, `target/arm/tcg/cpu64.c` |
| **E19** | MikroTik GPL disclosure, Linux 5.6.3 | — | published patch leaves the compat gate, cap numbering/bitmap dump, and init fallback path unchanged; arm64 config enables compat ELF | `tikoci/mikrotik-gpl`, independently audited |
| **E20** | QEMU v11.0.2, all HVF CPU models | — | `hvf_arch_init_vcpu()` preserves the live hardware-backed `ID_AA64PFR0_EL1`; a named model cannot synthesize AArch32 EL0 | upstream source, independently audited |
| **E21** | RouterOS 7.22.1 arm64 system package | — | 101 ARM32 executables and 18 ARM32 shared objects; the AArch64 ELF files are two maintenance executables and 282 kernel modules | local case-sensitive `unsquashfs` + `file` scan of `/var/pdb/system/image` |

The earlier claim that arm64 CHR works under HVF on M1/M2/M3 had no provenance.
The artifact/source chain predicts the opposite. Treat prior-generation
Apple-Silicon HVF support as **unverified and expected to fail** until an actual
boot log demonstrates otherwise.

---

## Optional One-Shot M4 Confirmation Bundle

**Do not request this merely to continue the investigation.** Use it only when
an upstream MikroTik report needs the exact runtime errno from the shipped
binary. It runs on a **copy** of the extracted `.utm` bundle, preserves the
shipped QEMU config (1024 MiB, two vCPUs, disk and NIC device types), changes
only the kernel loglevel, and captures:

1. HVF with `-cpu host` — expected `Failed to execute /init (error -8)`.
2. TCG with `-cpu cortex-a710` — same verbose image, expected to boot.

Replace only `BUNDLE=...`; paste the rest as one block:

```sh
set -eu

BUNDLE="$HOME/vms/chr.aarch64.qemu.7.22.1.utm"
RESULTS="$HOME/Desktop/mikropkl-11-m4-results"
QEMU=/opt/homebrew/bin/qemu-system-aarch64
CODE=/opt/homebrew/share/qemu/edk2-aarch64-code.fd
VARS=/opt/homebrew/share/qemu/edk2-arm-vars.fd

if [ -e "$RESULTS" ]; then
  echo "Refusing to overwrite $RESULTS" >&2
  exit 1
fi

mkdir -p "$RESULTS/mnt"
cp -R "$BUNDLE" "$RESULTS/bundle"
IMG=$(find "$RESULTS/bundle/Data" -name '*-arm64.img' -print -quit)

{
  date
  sw_vers
  uname -a
  "$QEMU" --version
  sysctl -n machdep.cpu.brand_string
  sysctl -n kern.hv_support
  sysctl hw.optional.arm
  shasum -a 256 "$IMG"
} > "$RESULTS/environment.txt" 2>&1

# Inject verbose kernel arguments into the copied image's ESP.
dd if="$IMG" of="$RESULTS/p1.fat" bs=512 skip=2048 count=67584 status=none
hdiutil attach -imagekey diskimage-class=CRawDiskImage \
  -mountpoint "$RESULTS/mnt" "$RESULTS/p1.fat"
mv "$RESULTS/mnt/EFI/BOOT/BOOTAA64.EFI" \
  "$RESULTS/mnt/EFI/BOOT/ROSKRNL.EFI"
printf '%s\r\n' \
  'FS0:\EFI\BOOT\ROSKRNL.EFI ignore_loglevel loglevel=8 printk.time=1 initcall_debug earlycon=pl011,0x09000000' \
  > "$RESULTS/mnt/startup.nsh"
sync
hdiutil detach "$RESULTS/mnt"
dd if="$RESULTS/p1.fat" of="$IMG" bs=512 seek=2048 \
  conv=notrunc status=none

run_case() {
  name=$1
  accel=$2
  cpu=$3
  cp "$VARS" "$RESULTS/$name-vars.fd"

  (
    cd "$RESULTS/bundle"
    "$QEMU" --readconfig ./qemu.cfg \
      -accel "$accel" -cpu "$cpu" \
      -drive if=pflash,format=raw,readonly=on,unit=0,file="$CODE" \
      -drive if=pflash,format=raw,unit=1,file="$RESULTS/$name-vars.fd" \
      -netdev user,id=net0 \
      -display none -vga none -monitor none -serial stdio -no-reboot
  ) > "$RESULTS/$name.log" 2>&1 &

  qemu_pid=$!
  (sleep 35; kill -TERM "$qemu_pid" 2>/dev/null || true) &
  watchdog_pid=$!
  wait "$qemu_pid" || true
  kill "$watchdog_pid" 2>/dev/null || true
  wait "$watchdog_pid" 2>/dev/null || true
}

run_case hvf-host hvf host
run_case tcg-control tcg,tb-size=256 cortex-a710

grep -aE \
  'Run /init|Failed to execute /init|No working init|virtio_blk| vda:|MikroTik Login' \
  "$RESULTS"/*.log > "$RESULTS/summary.txt" || true

tar -czf "$RESULTS/logs-only.tar.gz" \
  -C "$RESULTS" environment.txt summary.txt \
  hvf-host.log tcg-control.log

cat "$RESULTS/summary.txt"
echo "Attach: $RESULTS/logs-only.tar.gz"
```

### Interpretation

| Result | Meaning |
|--------|---------|
| HVF host logs `Failed to execute /init (error -8)` | predicted root cause confirmed |
| TCG reaches `MikroTik Login:` | verbose-image/control integrity confirmed |
| HVF error is not `-8` | retain the artifact finding but re-open the immediate failure mechanism |
| Verbose HVF log never reaches `Run /init` | failure is earlier than predicted; compare last initcall with the TCG control |

Do not infer ownership from arbitrary errno values alone. `-ENOEXEC` is
diagnostic here because the shipped `/init` architecture and both loader/HVF
source paths independently predict it.

---

## Retired and Demoted Theories

### FEAT_SSBS removal — retired as the mechanism

TCG boots the same kernel and 32-bit init on `cortex-a53`, `cortex-a72`, and
`neoverse-n1`, none of which implement FEAT_SSBS. Linux 5.6 treats SSBS as an
optional mitigation feature. `FEAT_SSBS=0` may identify M4 hardware, but it
does not explain the exec failure.

### SME exposure — demoted

M4 exposes SME through HVF, but there is no need to invoke SME to explain this
panic. The artifact architecture and compat-loader check produce the exact
failure deterministically.

### Guest memory map / highmem / PCIe ECAM — retired

Local TCG controls booted with `highmem=off`, `highmem-ecam=off`,
`highmem-mmio=off`, and `highmem-redists=off`, including a monitor control
confirming that ECAM moved. More importantly, the successful log shows
`/init` starts before partition discovery. ECAM placement is not needed to
explain why the kernel cannot execute an ELF32 init.

### Disk or root filesystem missing — retired

A no-root direct-kernel control panics with
`VFS: Unable to mount root fs on unknown-block(0,0)`, a different signature.
The actual initramfs contains `/init`; that program, not the kernel, discovers
and mounts the disk after exec.

### Initramfs handoff failure — demoted

The appended archive and its `/init` are now statically verified. A handoff
failure remains logically possible, but the predicted verbose HVF result
distinguishes it immediately. If the archive were absent at runtime, the log
would not reach `Run /init`.

### QEMU version floor — retired as a near-term fix

Changing QEMU versions can fix CPU-feature presentation bugs, but it cannot
make Apple hardware execute AArch32 through normal HVF virtualization. Re-test
a newer QEMU only if its release notes explicitly add an AArch32 execution
mechanism or after MikroTik ships an ARM32-free required userspace.

---

## Implications for quickchr and mikropkl

1. **Keep a safe TCG fallback, but broaden its scope — this is a live bug
   today.** The current `hostLacksSsbs()` gate covers M4+ only, so on
   **M1/M2/M3 quickchr still selects HVF for arm64 guests** and those users will
   hit this panic: no Apple Silicon implements AArch32 at any exception level, so
   the ELF32 `/init` cannot execute there either. The predicate should not be
   `FEAT_SSBS == 0` but simply *"Apple Silicon host + arm64 guest + current CHR
   artifact"* — i.e. in `detectAccel("arm64")`, return `tcg` for
   `darwin`/`arm64` unconditionally until the artifact changes. Note there is
   currently **no env-var accelerator override** in quickchr (unlike mikropkl's
   `QEMU_ACCEL`); the only bypass is the library-level `config.accel` passed to
   the QEMU arg builder (`src/lib/qemu.ts:45`). If we make the fallback
   unconditional, an explicit escape hatch should land with it so a fixed future
   image can be tested on HVF without a code change. E12's "works through M3"
   claim is not merely unverified — the chain predicts it false.
2. **Rewrite user-facing warnings.** They should say current arm64 CHR includes
   required 32-bit ARM userspace that HVF cannot execute, not that RouterOS
   requires SSBS.
3. **Correct the shipped quickchr explanation and mitigation.** `DESIGN.md`,
   `CHANGELOG.md`, `src/lib/platform.ts`, tests, and the launch warning still
   claim SSBS is causal and scope the fallback to M4+. The runtime policy must
   fall back for current arm64 CHR on all Apple Silicon, while preserving the
   evidence boundary that the exact M4 `-8` line remains unobserved.
4. **Define a restore signal from the guest artifact.** The useful signal is a
   future arm64 CHR release whose appended `/init` and required system-package
   executables and shared objects are AArch64, followed by a real HVF boot. Host
   SSBS, QEMU version, and a 64-bit `/init` alone are not sufficient restore
   signals.
5. **Report upstream to MikroTik with a minimal artifact fact.** The narrow
   request is: ship an ARM32-free required userspace for arm64 CHR, or document
   that the image requires AArch32 EL0 even though its kernel is AArch64.
6. **Do not advertise prior-generation Apple-Silicon HVF support without a
   log.** Source predicts the same failure on M1/M2/M3.

The fallback remains a mitigation, not the desired performance outcome.
Removing it safely requires a changed RouterOS artifact, not additional QEMU
flag tuning.

---

## Remaining Questions

1. **Downgraded to corroboration.** Does the M4 verbose log contain the
   predicted `Failed to execute /init (error -8)`? The capability-bitmap decode
   (E15/E16), artifact, and source establish the working diagnosis; this would
   observe the predicted loader result in the exact shipped binary and harden
   an upstream report.
2. Can anyone provide a complete successful arm64 CHR HVF log from M1/M2/M3?
   **The chain now predicts there is none**, which makes the current M4-only
   fallback predicate a live bug (Implications #1) rather than merely narrow.
3. Will MikroTik ship an arm64 CHR build whose required userspace, including
   `/init`, is AArch64? The static archive and package checks can become a
   release-time guard.

`-cpu cortex-a53` is no longer an open question: E20 shows that QEMU preserves
the hardware-backed `ID_AA64PFR0_EL1` for every HVF CPU model. A reporter run
would be redundant.

---

## References

- [tikoci/mikropkl#11](https://github.com/tikoci/mikropkl/issues/11) — original
  M4 report and reporter diagnostics
- [tikoci/quickchr#97](https://github.com/tikoci/quickchr/issues/97) and
  [quickchr#98](https://github.com/tikoci/quickchr/pull/98) — quickchr tracking
  and shipped mitigation
- [tikoci/mikropkl#12](https://github.com/tikoci/mikropkl/pull/12) — parallel
  mikropkl mitigation
- `mikropkl/Lab/qemu-arm64/NOTES.md` — CHR arm64 CPU sweep and kernel analysis
- Linux v5.6 [`init/main.c`](https://github.com/torvalds/linux/blob/v5.6/init/main.c) —
  `/init` selection, exec, fallback list, and panic
- Linux v5.6
  [`arch/arm64/include/asm/elf.h`](https://github.com/torvalds/linux/blob/v5.6/arch/arm64/include/asm/elf.h) —
  `compat_elf_check_arch()` and `system_supports_32bit_el0()`
- Linux v5.6
  [`fs/compat_binfmt_elf.c`](https://github.com/torvalds/linux/blob/v5.6/fs/compat_binfmt_elf.c)
  and [`fs/binfmt_elf.c`](https://github.com/torvalds/linux/blob/v5.6/fs/binfmt_elf.c) —
  compat loader and `-ENOEXEC` architecture rejection
- [`tikoci/mikrotik-gpl`](https://github.com/tikoci/mikrotik-gpl) —
  best-available MikroTik GPL disclosure and its per-release provenance warning
- MikroTik-disclosed Linux 5.6.3
  [`elf.h`](https://github.com/tikoci/mikrotik-gpl/blob/main/2025-03-19/linux-5.6.3/arch/arm64/include/asm/elf.h),
  [`cpucaps.h`](https://github.com/tikoci/mikrotik-gpl/blob/main/2025-03-19/linux-5.6.3/arch/arm64/include/asm/cpucaps.h),
  [`cpufeature.c`](https://github.com/tikoci/mikrotik-gpl/blob/main/2025-03-19/linux-5.6.3/arch/arm64/kernel/cpufeature.c),
  and
  [`init/main.c`](https://github.com/tikoci/mikrotik-gpl/blob/main/2025-03-19/linux-5.6.3/init/main.c) —
  disclosed counterparts of the load-bearing upstream paths; the published
  patch does not modify the relevant logic
- QEMU v11.0.2
  [`target/arm/hvf/hvf.c`](https://github.com/qemu/qemu/blob/v11.0.2/target/arm/hvf/hvf.c) —
  HVF host feature discovery, fail-closed AArch64-only check, and live vCPU
  `ID_AA64PFR0_EL1` handling
- QEMU v11.0.2
  [`target/arm/hvf/sysreg.c.inc`](https://github.com/qemu/qemu/blob/v11.0.2/target/arm/hvf/sysreg.c.inc) —
  system-register synchronization list
- QEMU v11.0.2
  [`hw/arm/virt.c`](https://github.com/qemu/qemu/blob/v11.0.2/hw/arm/virt.c)
  and [`target/arm/cpu64.c`](https://github.com/qemu/qemu/blob/v11.0.2/target/arm/cpu64.c) —
  accepted CPU model list and `host`/`max` behavior
