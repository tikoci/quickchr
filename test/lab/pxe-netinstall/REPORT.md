# Lab Report: PXE / netinstall boot of RouterOS in QEMU VMs (#329)

<!-- cspell:ignore KYJA FFAW HKLY FKPU NVPXE QCHRPXE pxeni harddrives -->

**Date**: 2026-11-27
**Host**: macOS Intel x86_64, QEMU 11.1.1 (Homebrew). x86 guests under HVF, arm64 guests under TCG.
**RouterOS**: 7.25.2 (stable) and 7.26beta7. `netinstall-cli` 7.25.2.
**Status**: Research done. Netinstall into a blank VM works for x86 and arm64, from either server,
with no root and no host network setup. Firmware PXE is the weak link. Skipping it, by having QEMU
load MikroTik's netinstall boot image directly (`-kernel`), works in every combination tried.

## Summary

| # | Path | Result |
|---|------|--------|
| 1a | `netinstall-cli` → x86, SeaBIOS + iPXE PXE | **No.** The server ignores the BIOS client (`Unknown BOOTP architecture option carch: 0`) |
| 1b | `netinstall-cli` → x86, OVMF PXE | **Works**, with IDE/AHCI disk + e1000 NIC. 63 s to installed (light host load) |
| 1c | `netinstall-cli` → x86, no PXE (`-kernel linux.x86_64`, SeaBIOS) | **Works**, ~68 s. Disk gets the stock-CHR BIOS layout and boots under SeaBIOS |
| 2a | CHR 7.25.2 `netinstall` package → x86, OVMF PXE | **No.** TFTP ignores `blksize` (no OACK). OVMF re-sends the RRQ forever |
| 2b | CHR 7.26beta7 `netinstall` package → x86, OVMF PXE | **Works**, 319–329 s (CHR free license caps it at ~1 Mbps) |
| 2c | CHR 7.25.2 → x86, no PXE (`-kernel`, SeaBIOS) | **Works**, 197 s |
| 2d | CHR 7.25.2 → arm64, no PXE (`-kernel linux.arm64-uefi`) | **Works**, 156 s |
| 3a | arm64 EDK2 PXE (either server) | **Blocked.** QEMU's bundled `edk2-aarch64-code.fd` has no network stack |
| 3b | `netinstall-cli` → arm64, no PXE (`-kernel linux.arm64-uefi`) | **Works**, 73 s (TCG target), with NVMe disk + igb NIC |
| 4 | QEMU slirp `tftp=`/`bootfile=` | Boots the netinstall image (0.5 s TFTP), then **stalls**: no server is reachable through slirp |

What a netinstalled VM is: **x86 or arm64 RouterOS, not CHR.** It has a 24-hour demo license
(`expires-in: 23h49m31s` at 30 s uptime, no `level`) and an `x86`/`arm64` board name. It also
needs a non-virtio disk at runtime. On virtio-blk, x86 powers itself off and arm64 dies with
`Fatal error 0x853`.

## Setup

All links are QEMU `-netdev dgram` unix-socket pairs, the transport of quickchr's `socket::<name>`.
Nothing used root, vmnet, or a host interface.

- **netinstall-cli server**: the Alpine `vmlinuz-virt` + initramfs that `tikoci/netinstall` builds
  for macOS (Alpine 3.23.3). Its `/init` mounts a 9p share and runs `/host/.vm-cmd.sh`. The lab
  points that share at a directory holding `netinstall-cli`, the `.npk` files and the scripts, and
  gives the VM `192.168.88.1/24`. `netinstall-cli -v … -a 192.168.88.2` then runs as root inside
  the guest. See `ni-server.sh`.
- **CHR server**: a quickchr machine (this checkout, 0.6.0), `--add-package netinstall`, `user`
  NIC first, `socket::<link>` second. The raw-QEMU target takes slot 1 of that named socket
  (`<data-dir>/networks/<link>.1.sock`). See `exp2-chr-server.sh`.
- **Targets**: a blank 1 GiB qcow2 for each run. Firmware PXE runs give the NIC `bootindex=1` and
  the disk `bootindex=2` (`target-x86.sh`, `target-arm64.sh`). `-kernel` runs use
  `direct-install.sh`. Captures come from `-object filter-dump` on the target netdev, and screens
  from HMP `screendump`.

### The boot images

`netinstall-cli` and the RouterOS package both fetch a per-arch boot image from
`https://upgrade.mikrotik.com/routeros/<ver>/netinstk/linux.<arch>`. At 7.25.2:

| Name | HTTP | Size | What it is |
|------|------|------|------------|
| `linux.x86_64` | 200 | 7,244,512 | `MZ`/PE **EFI-stub bzImage**, kernel 5.6.3-64, boot protocol 2.15 |
| `linux.arm64-uefi` | 200 | 7,793,460 | PE32+ EFI application, AArch64 |
| `linux.arm64` | 200 | 7,840,936 | static AArch64 ELF (RouterBOOT) |
| `linux.arm`, `.mips`, `.mmips`, `.tile` | 200 | — | not examined |
| `linux.x86`, `.x86-uefi`, `.x86_64-uefi`, `.i386`, `.mipsbe`, `.ppc`, `.smips` | 404 | — | — |

There is one x86 image, and it serves both legacy and UEFI boot: it is a bzImage with an EFI stub.
The `netinstall-cli` binary carries the strings `X86_64__boot`, `ARM64UEFI__boot` and
`Unknown BOOTP architecture option`, and dispatches on DHCP option 93. Over TFTP, the x86 image is
served as `/image`, padded to 7,244,800 bytes (BOOTP option 13 = 14,150 × 512).

## Experiment 1: `netinstall-cli` as the server (x86)

### 1a. SeaBIOS + iPXE: rejected at BOOTP

iPXE (the `efi-virtio.rom`/`efi-e1000.rom` BIOS image, "iPXE 1.20.1+") sends
`PXEClient:Arch:00000:UNDI:002001`, so option 93 = 0. `netinstall-cli` logs
`Unknown BOOTP architecture option carch: 0 from 02:00:00:00:00:02` and sends nothing back. iPXE
gives up after 4 DISCOVERs in 7 s (`No configuration methods succeeded`). Reproduced with
virtio-net + virtio-blk and with e1000 + ide-hd.

The same server also rejects OVMF's HTTP-boot DHCP (`carch: 16`). It only accepts option 93 = 7
(x64 UEFI), logged as `(x86_64)`.

### 1b. OVMF PXE: works, after two hardware changes

The exchange that works (q35 + OVMF, e1000, ide-hd):

1. DISCOVER (option 93 = 7) → BOOTP reply: `yiaddr 192.168.88.2`, **`siaddr 192.168.88.1`**,
   `file /image`, option 13 `14150`, mask `/24`. The reply came 1.3 s after the DISCOVER.
2. TFTP RRQ `/image` `blksize=1468 windowsize=4` → **OACK `blksize=1468`** (no `windowsize`), then
   DATA from port 69. About 2 s for 7.2 MB. Every DATA and ACK appears twice, in both the server's
   and the target's capture.
3. OVMF runs the EFI stub. The netinstall kernel prints
   `Welcome to MikroTik Router Software remote installation 7.25.2` to **VGA only**. The serial
   log stays silent, so these runs keep `-vga std` and read the screen with `screendump`.
4. The install runs over UDP/5000 broadcasts in both directions: the server sends from
   `192.168.88.1:5000` and the target from `0.0.0.0:5000`. Server frames carry about 1 KB each,
   target frames are 66-byte acks. The target also broadcasts on UDP/59813. Wireshark mislabels
   UDP/5000 as "TAPA".
5. Server log: `Booting device … into setup mode` → `Formatting` → `Sending packages` →
   `Packages sent` → `Rebooting device` → `Successfully finished installing`.

The netinstall kernel will not take quickchr's hardware:

| Device | Netinstall kernel says |
|--------|------------------------|
| virtio-blk (with or without `serial=`) | `getHardwareID: could not get disk /dev/vda info` / `WARN: skip disk '(1024 MB)', can't get Hardware-ID` / `ERROR: no valid harddrives found`, then it reboots. A PXE loop of about 17 s per cycle |
| `ide-hd` (AHCI on q35) | accepted |
| virtio-net-pci | `FATAL ERROR: no network card found` |
| e1000 | accepted |

Timing (target power-on → `Successfully finished`): **63 s** on a quiet host. The same run took
about 10 minutes while unrelated host activity pushed the load average to 170–275. Etherboot fell
from about 440 to 45 packets/s. Don't treat a slow run as a protocol problem without checking
`uptime`.

**Start-order race.** The `netinstall-cli` VM needs about 17–20 s before it answers. OVMF sends
4 DISCOVERs over about 31 s, then gives up (`PXE-E18: Server response timeout`) and moves on to
PXEv6 and HTTPv4/v6. In one run the server's first reply arrived 37 s after the last DISCOVER,
which was too late. `exp1-netinstall-cli.sh` therefore waits for `Waiting for RouterBOARD...`
before it powers on the target.

**After the install**, the target reboots and its NIC is still first in the boot order. With the
server gone, OVMF goes through PXEv4 → PXEv6 → HTTPv4 → HTTPv6, which takes about 4.5 minutes,
before it boots the disk to `MikroTik 7.25.2` / `x86 Login:` on serial. A server that is still
listening (`-m`) would install again.

### 1c. No PXE at all: `-kernel linux.x86_64`

`netinstall-cli` installs a device that never sent BOOTP. The kernel broadcasts on UDP/5000 about
1 s after power-on, the server answers at about 7 s, and the install completes at about 68 s.
This used plain `-M pc` SeaBIOS with no option ROM (`romfile=`) and no firmware network boot.

### The installed disk depends on how the installer was booted

| | p1 "RouterOS Boot" (ESP type GUID) | p1 boot sector | `/EFI/BOOT/BOOTX64.EFI` | Boots under |
|---|---|---|---|---|
| stock `chr-7.25.2.img` | LBA 34, 32 MiB, **ext2** | `eb66` loader | 4,020,960 B, sha256 `6eadfe7e…` | SeaBIOS |
| installer booted by OVMF PXE | LBA 2048, 33 MiB, **FAT32** (OEM `RouterOS`, label `EFI BOOT`) | mkfs.fat stub ("This is not a bootable disk") | **byte-identical** | **OVMF only** (SeaBIOS hangs at "Booting from Hard Disk...") |
| installer booted by `-kernel` under SeaBIOS | LBA 34, 32 MiB, ext2 | `eb66` loader | — | SeaBIOS (`x86 Login:` at 6 s) |

All three have a GPT plus a hybrid MBR, with p1 active and type 0x83, and identical MBR boot code.
The UEFI-installed ESP also holds `/VERSION` (`RouterOS v7.25.2 2026-11-20 11:11:10`) and an empty
`/map`; the stock ext2 `/map` is 60,416 B. OVMF later wrote `NvVars` to it. So MikroTik's own
installer writes a FAT ESP when it was booted under UEFI. That is relevant to #328, with the
caveat that the result is x86 RouterOS, not CHR.

### The installed system

Booted under OVMF with `ide-hd` + virtio-net on `user` networking. The `-s` configure script
added a DHCP client:

- REST answers after **31 s**. `board-name: x86 QEMU Standard PC (Q35 + ICH9, 2009)`,
  `architecture-name: x86_64`, one package (`routeros`).
- `/system/license`: `{"expires-in":"23h49m32s","software-id":"KYJA-S23L"}`. That is the x86
  demo license, with no `level`. Two different disks booted on `ide-hd` both showed
  `KYJA-S23L`. The same disk on NVMe (`serial=NVPXE01`) showed `00P5-FFAW`.
- `-sm mode.rsc` (sets a `/system/note`) and `-s configure.rsc` (identity + DHCP client) both
  applied. virtio-net works in the installed system, which uses the CHR kernel, unlike the
  netinstall kernel.
- **On virtio-blk the installed system powers off.** The kernel boots, fsck prints
  `No errors found`, then `Starting...`, and QEMU exits with status 0 about 5 s after launch.
  NVMe and ide-hd both boot. The cause has not been proven. The netinstall kernel's Hardware-ID
  failure on virtio-blk suggests the same lookup, but that is a hypothesis.

## Experiment 2: a CHR with the `netinstall` package as the server

This is the no-host-tools case: quickchr, QEMU, and a CHR that downloads what it needs over its
`user` NIC.

```sh
quickchr networks sockets create pxe-link
quickchr add --name pxe-srv --version 7.26beta7 --arch x86 \
  --add-network user --add-network socket::pxe-link --add-package netinstall
quickchr start pxe-srv
# REST: ip address 192.168.88.1/24 on ether2, then
#   /tool/netinstall/add interface=ether2 version=7.26beta7 keep-old-configuration=no install-once=yes
```

Findings, all over REST:

- `/tool/netinstall/add` arguments on 7.25.2: `allow-etherboot allow-flashfig
  apply-default-configuration auto-reboot branding-and-custom-packages comment copy-from disabled
  extra-packages install-once interface ip-range keep-old-configuration mac-address mode-file
  place-before remove-branding script-file version wait`. The documented `etherboot-image` and
  `etherboot-image-arch` are not among them. `cache add arch=` completes to
  `arm arm64 mipsbe mmips ppc smips tile x86`.
- `cache add arch=x86` downloads only `netinstk/linux.x86_64`. The `routeros-*.npk` is fetched
  when a device needs it (state `waiting for package NetinstallCache/routeros-7.26beta7.npk`).
- On 7.26beta7, `cache add` fails with `Default version not fetched, can't determine etherboot
  image path, ERROR: IPv4: could not resolve dns name` until a `check-for-updates` succeeds. The
  first check after boot hit a DNS timeout. `cache add version=7.26beta7` then downloaded
  **7.25.2's** `linux.x86_64` (the `stable` channel's), while the install still used
  `routeros-7.26beta7.npk`.
- A rule added over REST reads back `install-once: false`; the manual says the default is `yes`.
  With `auto-reboot=reboot` that is a **reinstall loop**: the target reboots, PXE-boots, and is
  served again. `install-once=yes` gives `done, won't reinstall`, and the next PXE gets
  `PXE-E18`.
- `/tool/netinstall/devices` reports x86 clients as `arch: i386`, for UEFI PXE and `-kernel`
  alike. arm64 is reported as `arm64`.
- `script-file` and `mode-file`, pointing at `.rsc` files uploaded to the CHR with
  `PUT /rest/file`, both applied.
- The SeaBIOS iPXE client (option 93 = 0) gets no reply and no device entry (7.25.2).

### Why OVMF PXE fails on 7.25.2 and works on 7.26beta7

| | 7.25.2 | 7.26beta7 |
|---|---|---|
| with `ip-range=192.168.88.10-192.168.88.20` | reply has **`siaddr 0.0.0.0`** and **mask `0.0.0.0`**, so OVMF reports `PXE-E16: No valid offer received` | not tried |
| without `ip-range` | lease `169.254.x.x/16`, `siaddr 169.254.1.1`. The CHR answers ARP for 169.254.1.1 on ether2, but the BOOTP reply's IP source is 192.168.88.1 | same |
| TFTP reply to `RRQ blksize=1468 windowsize=4` | **no OACK**: DATA block 1 at once, 1,452 bytes, from port 69. OVMF re-sends the RRQ every 4 s, forever. Reproduced 3×, including on a freshly created rule | **OACK `blksize=1452`**, then DATA 1 without waiting for ACK 0. Completes |

Neither changelog mentions the TFTP change. 7.26beta1's "install the package version of the
configured update channel" is the closest entry.

7.26beta7 full run (state transitions, seconds from target power-on): `bootp reply sent` 1–3 →
`booting` 123–126 → `formatting` 132–141 → `sending packages` 135–148 → `done` 319–329. TFTP of the
7.2 MB image took about 120 s (about 42 blocks/s, each sent twice). The package send took about
180 s, for 21 MB at about 0.96 Mbps. That is the **CHR free license's 1 Mbps cap**
(`/system/license` `level: free`). `netinstall-cli` moves the same data in about 46 s.

The installed disk (7.26beta7, `ide-hd`) booted under OVMF to REST in 30 s with
`software-id KYJA-S23L`, and both scripts had applied.

### Skipping PXE also skips the 7.25.2 bug

With the target booted by `-kernel` (`direct-install.sh`), the 7.25.2 CHR installs both arches:

- x86, SeaBIOS: 197 s to the target's reboot. The disk boots under SeaBIOS (`x86 Login:` at 6 s).
- arm64: 156 s. It boots under EDK2/TCG to `arm64 Login:` in 18 s.

**The installer writes its boot loader after the server says `done`.** A disk taken from a target
killed 2 s after `done` had a zeroed p1 boot sector (`Missing operating system` under SeaBIOS). The
same install, waited out with `-no-reboot` (QEMU exits when the installer reboots), was fine. Use the
target's reboot as the completion signal, not the server's state.

## Experiment 3: arm64

### 3a. EDK2 PXE: there is none

QEMU's bundled `edk2-aarch64-code.fd` (`edk2-stable202408-prebuilt.qemu.org`) offers no network
boot. With virtio-net at `bootindex=1`, the boot options are `UiApp` and `EFI Internal Shell`,
`ifconfig -l` is empty, and the only network driver loaded is `VirtioNetDxe` (no MNP, IP4, DHCP,
MTFTP, PXE or HTTP-boot drivers). The NIC sent **zero frames**. The x86 build from the same
Homebrew package does have PXE and HTTP boot. Distro AAVMF builds (quickchr's Linux firmware
lookup) were not tested. `exp3-arm64.sh probe` reproduces this.

Also seen: `efi-virtio.rom` loads on `virt` but fails with
`Image type X64 can't be loaded on AARCH64 UEFI system`.

### 3b. `-kernel linux.arm64-uefi`: works

EDK2 loads the image from fw_cfg (`EFI stub: Booting Linux Kernel... Generating empty DTB`). It
prints to **serial**, unlike x86.

| Device | arm64 netinstall kernel |
|--------|-------------------------|
| NVMe (`serial=`) | accepted |
| virtio-net, e1000, e1000e | `FATAL ERROR: no network card found` |
| **igb** (82576) | accepted |

`netinstall-cli`, given both `routeros-7.25.2.npk` and `routeros-7.25.2-arm64.npk`, picked the
arm64 one, and the install finished in **73 s** (TCG target). The disk matches the stock arm64
CHR image's layout: FAT ESP at LBA 2048, `/EFI/BOOT/BOOTAA64.EFI`. The partition is named
`RouterOS Boot` where the stock image has `RouterOS-Boot`.

The installed system on virtio-blk prints `Starting...`, `machine_apply_elf_rel: ERROR Unknown
type: 299`, then `Fatal error 0x853` / `Please contact support@mikrotik.com` /
`died with signal 6`, and QEMU exits. On NVMe the same `machine_apply_elf_rel` line appears and the
boot succeeds. REST answers in **36 s** (TCG), with
`board-name: arm64 QEMU QEMU Virtual Machine`, license
`{"expires-in":"23h49m31s","software-id":"HKLY-FKPU"}`, and both scripts applied.

## Experiment 4: slirp TFTP

`-netdev user,tftp=<dir>,bootfile=linux.x86_64` + OVMF + e1000/ide-hd:

- slirp's DHCP OFFER/ACK carries the bootfile. OVMF's first RRQ asks for `tsize=0` and aborts
  (`Option negotiation failed`, a size probe). The second RRQ (`blksize=1468 windowsize=4`) moves
  7.2 MB in **0.5 s**.
- The netinstall kernel boots and broadcasts on UDP/5000 and UDP/59813 about once a second. The
  screen fills with `readMBR: could not open /dev/mtdblock2: 2`. Nothing answers: slirp has no L2
  peer and does not forward broadcasts, and `netinstall-cli` cannot run on the macOS host anyway.

slirp can deliver the boot image, but QEMU's `-kernel` does that already. The install itself needs
a server on the same L2. Reproduced twice (`exp4-slirp.sh`).

## Recommendation

**For #327: name it `--allow-pxe` and keep it a plain escape hatch.** Nothing in a working netinstall
flow needs firmware PXE or the iPXE ROM:

- x86 BIOS PXE (quickchr's default machine) is rejected by both servers.
- x86 UEFI PXE works only with `netinstall-cli` or a ≥7.26 CHR, only without `ip-range`, and
  costs about 4.5 minutes of network-boot fallthrough on every later reboot while the NIC stays
  first in the boot order.
- arm64 has no PXE with the firmware quickchr uses on macOS.
- `-kernel netinstk/linux.<arch>` worked in every server × arch combination tried, under plain
  SeaBIOS, with `romfile=` set.

Dropping the iPXE ROM by default (#327) therefore costs a future netinstall feature nothing.
On macOS Homebrew the arm64 `PXESupport` fw_cfg knobs will be no-ops, because there is no network
stack to switch off. Check AAVMF on Linux separately.

**A real `--netboot` / netinstall feature is feasible.** It is worth an issue as a testing tool,
not as another way to get a CHR:

1. **Netinstall target machine.** A blank disk, `-kernel` from the netinstk cache (a new cache item:
   `upgrade.mikrotik.com/routeros/<ver>/netinstk/linux.<arch>`), `-no-reboot` as the "installed"
   signal, then a reboot from disk. Hardware profile: x86 `ide-hd` + e1000, arm64 NVMe + igb. The
   disk must **stay** non-virtio at runtime, which conflicts with quickchr's virtio-only disk
   assumption. A boot-time NIC can be virtio again.
2. **CHR netinstall server recipe.** A machine with `--add-package netinstall` and a
   `socket::<name>` link, plus REST setup: no `ip-range`, `install-once=yes`, and a
   check-for-updates first on 7.26. Expect ~1 Mbps without a paid or trial license.
3. **Scope it honestly.** The product is **x86/arm64 RouterOS with a 24 h demo license**, not CHR.
   That is right for testing netinstall itself (`-s`/`-sm` and `script-file`/`mode-file`, the
   etherboot protocol, the `netinstall` package, `tikoci/netinstall`) without hardware or root.
   It does not replace `chr-<ver>.img`.
4. **#328 side note.** Netinstall under UEFI yields a FAT-ESP x86 disk from MikroTik's own
   tooling. It is not CHR, so it does not replace fat-chr.

## Not tested / open

- x86 `-kernel` under OVMF (does the installer then write the FAT layout?). `direct-install.sh x86 uefi` exists but was not run.
- Distro AAVMF (Debian/Ubuntu) network stack, and EDK2 arm64 PXE with option 93 = 11
  (`ARM64UEFI__boot`).
- The cause of the x86 virtio-blk power-off and arm64 `Fatal error 0x853`.
- 7.26 CHR with `ip-range`. CHR server for an x86 UEFI target via `-kernel`.
- Whether the demo countdown persists across reboots. Every boot here read about `23h49m` at
  about 30 s uptime.
- What UDP/59813 is.

## Reproduce

Run everything from the repo root. `WORK` (default `/tmp/pxeni`) holds disks, pcaps, logs and the
sockets. Keep it short, because socket paths are limited to 104 bytes. The `netinstall-cli` server
needs `vmlinuz-virt` and `initramfs-netinstall.gz` from a `tikoci/netinstall` checkout (`NI_VMLINUZ`,
`NI_INITRD`). Downloads are fetched into `$WORK/dl`.

```sh
sh test/lab/pxe-netinstall/exp1-netinstall-cli.sh uefi      # 1b, then boots the result and reads REST
sh test/lab/pxe-netinstall/exp2-chr-server.sh 7.26beta7 pxe  # 2b
sh test/lab/pxe-netinstall/exp2-chr-server.sh 7.25.2 pxe     # 2a (stalls in TFTP; stop it)
sh test/lab/pxe-netinstall/exp2-chr-server.sh 7.25.2 direct-x86
sh test/lab/pxe-netinstall/exp2-chr-server.sh 7.25.2 direct-arm64
sh test/lab/pxe-netinstall/exp3-arm64.sh probe               # 3a
sh test/lab/pxe-netinstall/exp3-arm64.sh install             # 3b
sh test/lab/pxe-netinstall/exp4-slirp.sh                     # 4
```

| File | Role |
|------|------|
| `lib.sh` | paths, downloads, `dgram_pair`, `uefi_vars`, `hmp` |
| `ni-server.sh` | `netinstall-cli` inside an Alpine VM on one end of a dgram link |
| `target-x86.sh`, `target-arm64.sh` | blank PXE-first targets (`DISK_DEV`, `NIC_DEV`, `DISK_SERIAL`, `ROM`) |
| `direct-install.sh` | `-kernel` netinstall target with `-no-reboot` |
| `boot-installed.sh` | boot a result on `user` networking and wait for REST |
| `exp1…exp4` | the experiments above |
| `scripts/` | the `-s` / `-sm` (`script-file` / `mode-file`) scripts |
