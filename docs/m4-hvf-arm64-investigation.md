# aarch64 CHR Panics Under HVF on Apple Silicon

**Date:** 2026-07-25
**Investigator:** quickchr / tikoci (consolidating tikoci/mikropkl#11,
tikoci/quickchr#97, and tikoci/quickchr#98)
**Status:** **ROOT CAUSE STRONGLY ESTABLISHED FROM THE SHIPPED ARTIFACT AND
UPSTREAM SOURCE; ONE M4 VERBOSE BOOT SHOULD CONFIRM THE PREDICTED `-ENOEXEC`.**

The failure is not currently supported as an SSBS bug, an M4 memory-map bug, or
a missing-disk bug. The shipped arm64 CHR boot chain mixes architectures:

```text
64-bit arm64 Linux kernel
  └─ appended XZ-compressed initramfs
       └─ /init = 32-bit ARM EABI executable
```

TCG CPU models provide AArch32 EL0 and can execute `/init`. QEMU's arm64 HVF
path deliberately exposes an AArch64-only guest CPU profile. Linux 5.6 therefore
rejects the 32-bit `/init` with `-ENOEXEC` and, because the initramfs contains no
fallback `/sbin/init`, `/etc/init`, `/bin/init`, or `/bin/sh`, panics with:

```text
No working init found. Try passing init= option to kernel.
```

This predicts that the issue affects **all Apple Silicon hosts using arm64 HVF**,
not only M4. M4/`FEAT_SSBS=0` is an accidental marker for the first reported
host, not the mechanism.

---

## Executive Summary

### Root-cause chain

Every link below is grounded in either the actual 7.22.1 image or the exact
Linux/QEMU version's source:

1. `BOOTAA64.EFI` is a 64-bit arm64 Linux 5.6.3 kernel.
2. At byte offset `11,739,140`, that file contains an appended XZ stream. It
   decompresses to a 169,984-byte `newc` initramfs with four entries:
   `dev/`, `dev/ram0`, `dev/console`, and `/init`.
3. `/init` is a 169,168-byte, statically linked **ELF 32-bit LSB ARM EABI5**
   executable, SHA-256
   `69859b2fcdb329580b8fdad2e1b72e29526294708f58ced413b58895af85e706`.
4. Linux v5.6 arm64's `compat_elf_check_arch()` accepts an `EM_ARM` ELF only
   when `system_supports_32bit_el0()` is true. A failed architecture check
   returns `-ENOEXEC` (`-8`).
5. QEMU v11.0.2's HVF host-CPU probe explicitly verifies that
   `ID_AA64PFR0_EL1.{EL1,EL0} == 0x11`, meaning AArch64-only at both exception
   levels. Its source comment is: "Make sure we don't advertise AArch32 support
   for EL0/EL1."
6. Linux logs `Run /init as init process` immediately before `execve()`. If
   `/init` returns `-ENOEXEC`, it logs `Failed to execute /init (error -8)`,
   tries four absent fallback paths, and emits the reported panic.
7. A local TCG control with the real 7.22.1 UEFI/ACPI boot path executes the
   same 32-bit `/init`, mounts the disk from userspace, and reaches
   `MikroTik Login:`.

### What the M4 reporter needs to confirm

One verbose HVF boot should contain:

```text
Run /init as init process
Failed to execute /init (error -8)
Kernel panic - not syncing: No working init found
```

That is the decisive confirmation. The one-shot collection below also runs a
TCG control and an HVF `cortex-a53` experiment so we do not need a second
round-trip.

### Product consequence

There is no QEMU flag that can make physical Apple Silicon execute AArch32
guest userspace through HVF. The durable fix is for MikroTik to ship an
AArch64 `/init` in the arm64 CHR initramfs. Until then:

- TCG is the safe accelerator for current arm64 CHR on **all** Apple Silicon.
- A QEMU version floor is not a credible restore signal unless a future QEMU
  explicitly adds mixed HVF/software execution for AArch32, which it does not
  do today.
- `FEAT_SSBS=0` is too narrow as a fallback predicate; it leaves M1/M2/M3
  exposed to the same artifact-level incompatibility.

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

The previous comparison between the TCG `Run /init` timestamp and the HVF panic
timestamp was invalid. Guest kernel timestamps use the guest architectural
timer; a TCG-to-HVF wall-clock speed ratio cannot be applied to them. No
localization should rely on the similar-looking numbers.

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
| E14 | QEMU v11.0.2 arm64 HVF | — | host profile explicitly excludes AArch32 EL0/EL1 | upstream source |

The earlier claim that arm64 CHR works under HVF on M1/M2/M3 had no provenance.
The artifact/source chain predicts the opposite. Treat prior-generation
Apple-Silicon HVF support as **unverified and expected to fail** until an actual
boot log demonstrates otherwise.

---

## One-Shot M4 Confirmation Bundle

The goal is one reporter response containing all decisive evidence. Run this on
a **copy** of the extracted `.utm` bundle. It preserves the shipped QEMU config
(1024 MiB, two vCPUs, disk and NIC device types), changes only the kernel
loglevel, and captures:

1. HVF with `-cpu host` — expected `Failed to execute /init (error -8)`.
2. HVF with `-cpu cortex-a53` — checks whether the accepted named model changes
   the outcome; source says it should not restore physical AArch32 execution.
3. TCG with `-cpu cortex-a710` — same verbose image, expected to boot.

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

# Panic cases first so the successful TCG boot cannot mutate their input.
run_case hvf-host hvf host
run_case hvf-a53 hvf cortex-a53
run_case tcg-control tcg,tb-size=256 cortex-a710

grep -aE \
  'Run /init|Failed to execute /init|No working init|virtio_blk| vda:|MikroTik Login' \
  "$RESULTS"/*.log > "$RESULTS/summary.txt" || true

tar -czf "$RESULTS/logs-only.tar.gz" \
  -C "$RESULTS" environment.txt summary.txt \
  hvf-host.log hvf-a53.log tcg-control.log

cat "$RESULTS/summary.txt"
echo "Attach: $RESULTS/logs-only.tar.gz"
```

### Interpretation

| Result | Meaning |
|--------|---------|
| HVF host logs `Failed to execute /init (error -8)` | predicted root cause confirmed |
| TCG reaches `MikroTik Login:` | verbose-image/control integrity confirmed |
| HVF `cortex-a53` also returns `-8` | named model is accepted but does not provide usable AArch32 under HVF |
| HVF `cortex-a53` boots | unexpected fast configuration fix; verify the log says HVF and then revise both projects |
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
mechanism or after MikroTik ships an AArch64 `/init`.

---

## Implications for quickchr and mikropkl

1. **Keep a safe TCG fallback, but broaden its scope.** The current
   `hostLacksSsbs()` gate covers M4+ only. The incompatibility is the guest's
   ELF32 `/init` versus the AArch64-only HVF profile, so current arm64 CHR
   should use TCG on every Apple-Silicon host.
2. **Rewrite user-facing warnings.** They should say current arm64 CHR includes
   32-bit ARM early userspace that HVF cannot execute, not that RouterOS
   requires SSBS.
3. **Correct `DESIGN.md` and test comments.** Remove causal claims about SSBS
   and the M4-only scope. Preserve the evidence boundary: the exact M4 `-8`
   line remains pending until the reporter runs the bundle.
4. **Define a restore signal from the guest artifact.** The useful signal is a
   future arm64 CHR release whose appended `/init` is `ELF 64-bit LSB,
   ARM aarch64`, followed by a real HVF boot. Host SSBS and QEMU version are not
   sufficient restore signals.
5. **Report upstream to MikroTik with a minimal artifact fact.** The narrow
   request is: ship AArch64 early userspace in the arm64 CHR initramfs, or
   document that the image requires AArch32 EL0 even though its kernel is
   AArch64.
6. **Do not advertise prior-generation Apple-Silicon HVF support without a
   log.** Source predicts the same failure on M1/M2/M3.

The fallback remains a mitigation, not the desired performance outcome.
Removing it safely requires a changed RouterOS artifact, not additional QEMU
flag tuning.

---

## Open Questions

1. Does the M4 verbose log contain the predicted
   `Failed to execute /init (error -8)`?
2. Does QEMU accept `-cpu cortex-a53` under HVF on that host, and if so does
   the guest result remain `-ENOEXEC`?
3. Can anyone provide a complete successful arm64 CHR HVF log from M1/M2/M3?
   Until then, the prior "works before M4" statement is unsupported.
4. Will MikroTik change `/init` to AArch64 in a future CHR build? The static
   archive check can become a release-time guard.

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
- QEMU v11.0.2
  [`target/arm/hvf/hvf.c`](https://github.com/qemu/qemu/blob/v11.0.2/target/arm/hvf/hvf.c) —
  HVF host feature discovery and explicit exclusion of AArch32 EL0/EL1
- QEMU v11.0.2
  [`hw/arm/virt.c`](https://github.com/qemu/qemu/blob/v11.0.2/hw/arm/virt.c)
  and [`target/arm/cpu64.c`](https://github.com/qemu/qemu/blob/v11.0.2/target/arm/cpu64.c) —
  accepted CPU model list and `host`/`max` behavior
