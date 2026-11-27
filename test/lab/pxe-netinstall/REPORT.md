# Lab Report: PXE / netinstall boot of RouterOS in QEMU VMs (#329)

<!-- cspell:ignore KYJA FFAW HKLY FKPU NVPXE QCHRPXE pxeni harddrives tapbridge RNDR depex AAVMF OVMF BDS impdef MLD Omarchy SNP tmpfs unpadded varstore -->

**Date**: 2026-11-27
**Host**: macOS Intel x86_64, QEMU 11.1.1 (Homebrew). x86 guests under HVF, arm64 guests under TCG.
**Re-run**: Linux x86_64 (Arch based), QEMU 11.1.2, x86 under KVM, arm64 under TCG, distro
EDK2 202608. See [Linux re-run](#linux-re-run-kvm). It corrects three findings below (3a,
the 7.25.2 `ip-range` reply, x86 on virtio-blk). Where a section disagrees with the re-run,
the re-run section has the evidence.
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
| 3a | arm64 EDK2 PXE (either server) | **No.** ~~No network stack~~: the stack is there but needs an RNG that `-cpu cortex-a710` lacks. With `-cpu max` EDK2 PXE-boots (option 93 = 11), and both servers then send a reply with no subnet mask, which EDK2 drops (`PXE-E16`). Linux re-run |
| 3b | `netinstall-cli` → arm64, no PXE (`-kernel linux.arm64-uefi`) | **Works**, 73 s (TCG target), with NVMe disk + igb NIC |
| 4 | QEMU slirp `tftp=`/`bootfile=` | Boots the netinstall image (0.5 s TFTP), then **stalls**: no server is reachable through slirp |

What a netinstalled VM is: **x86 or arm64 RouterOS, not CHR.** It has a 24-hour demo license
(`expires-in: 23h49m31s` at 30 s uptime, no `level`) and an `x86`/`arm64` board name. It also
needs a non-virtio disk at runtime. On virtio-blk both die the same way: `Fatal error 0x853`,
`died with signal 6`, then power-off. x86 prints this to VGA only, which is why the macOS run saw
only a power-off. An untouched x86 install died the same way on its very first boot (SeaBIOS,
HVF; see Experiment 1).

## Linux re-run (KVM)

**Host**: Omarchy (Arch based), kernel 7.2.15, x86_64, 8 cores, load average under 2 during the
runs. QEMU 11.1.2 (Arch `qemu-*` 11.1.2-1), `seabios` 1.17.0-2, iPXE ROMs from
`qemu-system-x86-firmware` 11.1.2. x86 guests under **KVM**, arm64 guests under TCG.
Firmware: Arch `edk2-ovmf` 202608-1 (`/usr/share/edk2/x64/OVMF_CODE.4m.fd` + `OVMF_VARS.4m.fd`)
and `edk2-aarch64` 202608-1 (`/usr/share/AAVMF/AAVMF_CODE.fd` → `/usr/share/edk2/aarch64/QEMU_EFI.fd`).
For 3a, three more aarch64 builds were unpacked into `/tmp` without installing them: Debian
`qemu-efi-aarch64` 2025.02-8+deb13u1, Ubuntu `qemu-efi-aarch64` 2025.11-3ubuntu7.4, and QEMU
v11.1.0's `pc-bios/edk2-aarch64-code.fd` (`edk2-stable202408-prebuilt.qemu.org`, the build the macOS
run used through Homebrew).

**netinstall-cli** ran on the host, not in the Alpine VM (no `tikoci/netinstall` checkout here).
`ni-server.sh` falls back to it on Linux: `unshare -rn` gives an unprivileged user and network
namespace, `tapbridge.py` creates a TAP device in it and joins that TAP to the dgram link, and
`netinstall-cli -a 192.168.88.2` runs as namespace root. No sudo, no host interface. It answers about 6 s
after launch, where the VM took 17–20 s.

| # | Linux result | vs macOS |
|---|--------------|----------|
| 1a | Rejected: `Unknown BOOTP architecture option carch: 0`. iPXE sent 4 DISCOVERs in 7 s (`PXEClient:Arch:00000:UNDI:002001`) | confirmed |
| 1b | Installed in **24 s**, twice (power-on → `Successfully finished`). DISCOVER → reply 0.24 s, TFTP of 7.2 MB in 1.0 s, UDP/5000 from +12.7 s. REST 30 s after boot from disk. License `KYJA-S23L`, both scripts applied | confirmed, 63 s → 24 s |
| 1c | `-kernel`, SeaBIOS: 18 s. Disk gets p1 at LBA 34 (ext2 layout), boots under SeaBIOS, REST in 30 s | confirmed |
| 1d | **New.** `-kernel` under **OVMF** (`exp1-netinstall-cli.sh direct-uefi`): 19 s. Disk gets the FAT32 ESP at LBA 2048 (`EFI BOOT`, GPT name `RouterOS Boot`), the same layout as the OVMF PXE install. Boots under OVMF, REST in 31 s | was untested |
| 2a | 7.25.2 with `ip-range`: the BOOTP reply was **fine** (`yiaddr 192.168.88.10`, `siaddr 192.168.88.1`, mask /24, option 13). The TFTP failure reproduced: DATA 1 (1,456 B) without OACK, OVMF re-sends the RRQ every 4 s | ip-range part **contradicted**; TFTP part confirmed |
| 2b | 7.26beta7 **with** `ip-range`: works. Reply `yiaddr .11`, `siaddr .1`, mask /24; OACK `blksize=1452`. `booting` at +133 s, `done` at **+331 s**. The disk boots to `MikroTik 7.26beta7` / `x86 Login:` under OVMF | was untested; 1 Mbps cap unchanged by KVM |
| 2b' | 7.26beta7 **without** `ip-range`: lease `169.254.47.211/16`, `siaddr 169.254.1.1`, reply from 192.168.88.1; OACK `blksize=1452`. `booting` +133 s, `done` +333 s | confirmed |
| 2e | **New.** CHR 7.25.2 → x86 **OVMF** `-kernel` (`exp2-chr-server.sh 7.25.2 direct-x86-uefi`): 193 s to the installer's reboot. Boots under OVMF to `MikroTik 7.25.2` / `x86 Login:` | was untested |
| 3a | See below | **contradicted** |
| 3b | `-kernel linux.arm64-uefi`, Arch AAVMF, NVMe + igb: installed in 34 s (TCG). Boots on NVMe to `arm64 Login:`; on virtio-blk `Fatal error 0x853` after 13 s | confirmed |
| 4 | slirp TFTP: 7.2 MB in 0.43 s, then UDP/5000 and UDP/59813 broadcasts go unanswered | confirmed |
| post-install | NIC still first in the boot order, server gone: PXEv4 → PXEv6 → HTTPv4 → HTTPv6 → disk → `x86 Login:` took **487 s**. The four network attempts took about 4 min, then the firmware sat for about 4 min after the HTTPv6 error before it booted the disk | slower here (one run) |

**x86 on virtio-blk** (`e1-uefi` disk, OVMF, three runs): QEMU exits with status 0 after about 4 s.
With `-no-shutdown` and a `screendump`, the VGA shows `No errors found.` / `Starting...` /
`Starting services...` / `Fatal error 0x853` / `Please contact support@mikrotik.com` /
`connect failed (errno=2)` / `died with signal 6`. This is the arm64 failure. On ide-hd the same
disk reaches REST; on NVMe (`serial=`) it was still up after 60 s.

**The TFTP duplicates are the Sorcerer's Apprentice bug.** `netinstall-cli` sends DATA 1 together
with the OACK, before ACK 0. OVMF ACKs both copies of DATA 1, and the server answers each ACK, so
from then on every block goes out twice (about 9,870 DATA frames for 4,936 blocks). The 7.26beta7 CHR
does the same (OACK, then DATA 1 without waiting). slirp's TFTP does not.

### 3a on Linux: arm64 EDK2 has a network stack, gated on an RNG

- All four aarch64 builds contain the whole stack. `uefi-firmware-parser -b` lists `MnpDxe`,
  `Ip4Dxe`, `Dhcp4Dxe`, `Mtftp4Dxe`, `UefiPxeBcDxe` and `HttpBootDxe` in each, including QEMU's
  202408 build. In that build every NetworkPkg driver above SNP (`MnpDxe`, `ArpDxe`, `Ip4Dxe`,
  `Ip6Dxe`, `Dhcp4Dxe`, `Dhcp6Dxe`, `Udp4Dxe`, `Mtftp4Dxe`, `UefiPxeBcDxe`, `HttpBootDxe`, `HttpDxe`,
  `TcpDxe`, `DnsDxe`, `VlanConfigDxe`) has `3152bca5-eade-433d-862e-c01cdc291f44`
  (`EFI_RNG_PROTOCOL`) in its DXE depex. `VirtioNetDxe` does not, so the NIC driver still loads.
  Arch's `MnpDxe` has the same depex. The build's `RngDxe` gets randomness from the CPU (`RNDR`).
- With `-cpu cortex-a710` (quickchr's TCG model), nothing produces that protocol, no network driver
  loads, there is no network boot option, and the NIC sends nothing (0 frames in 90 s on every build).
  That is what the macOS probe saw. The Debian shell's `drivers` list shows `VirtioNetDxe` and no
  MNP or IP drivers, as the macOS run reported.
- With an RNG-capable CPU model, EDK2 PXE-boots: `-cpu max` (Arch, Debian, QEMU 202408),
  `neoverse-n2` (Arch, Ubuntu), `neoverse-v1` (Arch). DISCOVER carries option 93 = 11,
  `PXEClient:Arch:00011:UNDI:003000`, then PXEv6, and HTTP boot as option 93 = 19.
- `-device virtio-rng-pci` with `cortex-a710` is not enough. The stack loads (IPv6 MLD/NS frames
  appear) but BDS has already built its boot list, so there is no PXE option (Arch, Ubuntu). Debian
  sent nothing at all.
- Ubuntu's build with `-cpu max` (also with `pauth-impdef=on`) stopped after its version banner in
  two runs. `neoverse-n2` works there.
- **Both servers send arm64 a bare BOOTP reply.** To option 93 = 11, `netinstall-cli` 7.25.2 logs
  `(arm64_uefi)` and `Assigned 192.168.88.2`, and the 7.26beta7 CHR (`ip-range` set) logs
  `bootp reply sent arch=arm64-uefi`. Both replies carry `yiaddr`, `siaddr` and `file "/image"`,
  but **no options** after the magic cookie: no subnet mask, no option 13. EDK2 keeps sending
  DISCOVERs and ends with `PXE-E16: No valid offer received`. Its HTTP-boot DHCP (option 93 = 19)
  then gets `Unknown BOOTP architecture option carch: 19`. Seen with `netinstall-cli` in two runs
  and with the CHR in one. No TFTP request was ever sent. The x86 reply has mask and option 13, and
  works. So arm64 netinstall over EDK2 PXE fails on the server side, whatever the firmware does.
- `-fw_cfg name=opt/org.tianocore/IPv4PXESupport,string=no` and `IPv6PXESupport,string=no` on
  Arch's aarch64 build (with `-cpu max`) remove both PXE options, but **HTTP boot still runs**
  (`HTTPClient:Arch:00019` DISCOVERs, `>>Start HTTP Boot over IPv4/IPv6`). One run. That matters
  for #327: the knobs alone don't stop arm64 network boot once the CPU has an RNG.

`exp3-arm64.sh pxe` and `exp2-chr-server.sh <ver> pxe-arm64` reproduce the arm64 PXE runs.
`target-arm64.sh` now defaults to `-cpu max` (`ARM_CPU`). `IGB=1` puts virtio-net, which EDK2 can
drive, and igb, which the arm64 netinstall kernel needs, on one QEMU hub with one MAC. That way the
kernel would have found its NIC if the PXE stage had worked.

### Script bugs found on the way

- `uefi_vars` padded the x86 OVMF vars file to the code ROM's size. With split OVMF (3.5 MB code +
  528 KB vars) that moves the varstore, and OVMF then never writes to it: after a boot to the
  shell, 0 bytes of the padded file had changed, against 5,781 bytes of the unpadded one. The runs
  still worked, but no variable reached the file. Padding is now applied only for aarch64, where
  both pflash units must be 64 MiB.
- `uefi_vars`: `stat -f %z` is BSD only. GNU `stat -f` prints file-system info on stdout, exits
  1, and the fallback's output is appended to it, so `truncate` gets garbage. Now `wc -c`.
- `hmp` needed `nc -U`; there is no `nc` here. It now uses `socat` or `python3`.
- `exp2-chr-server.sh` had no cleanup on failure, so an error left the `pxe-srv` machine and the
  `pxe-link` socket behind. It now cleans up on exit, interrupt and `TERM`.
- `exp1-netinstall-cli.sh` and `exp3-arm64.sh install` left the server running when the install
  failed or timed out.
- `exp3-arm64.sh probe` needs an EFI shell on the boot menu. Arch's and Ubuntu's builds have none,
  so it waits out its 300 s and prints nothing useful. The pcap from `target-arm64.sh` is the
  portable check.
- `exp2` never boots the installed disk. Without `script-file`, the result has no DHCP client and
  `boot-installed.sh` can't reach REST. The 7.26beta7 disk above was checked on the serial console.

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
  NVMe and ide-hd both boot. The Linux re-run read the VGA before the power-off: it is the same
  `Fatal error 0x853` / `died with signal 6` as arm64. The cause has not been proven. The
  netinstall kernel's Hardware-ID failure on virtio-blk suggests the same lookup, but that is a
  hypothesis.
- **The first boot after install is no exception** (macOS, HVF, checked during the review of
  PR #331). A fresh `exp1 direct-bios` install, copied before anything booted it, died on
  virtio-blk under SeaBIOS on its first boot: `bootPart mount: Invalid argument`, then
  `Fatal error 0x853` / `died with signal 6`, and QEMU stops (`VM status: paused (shutdown)` with
  `-no-shutdown`). A second untouched copy of the same disk booted on ide-hd with the install-time
  `serial=QCHRPXE0001` to REST in about 20 s, and failed again on virtio-blk afterwards. Earlier in
  that review, three `exp1` runs seemed to show the first boot reaching REST on virtio-blk. That was
  an artifact: `exp1` exported `DISK_DEV=ide-hd` for the installer, and `boot-installed.sh`
  inherited it, so those boots ran on IDE. `exp1` now sets the post-install boot's disk
  explicitly (`POST_DISK_DEV`, default ide-hd).

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
| with `ip-range=192.168.88.10-192.168.88.20` | macOS: reply had **`siaddr 0.0.0.0`** and **mask `0.0.0.0`**, so OVMF reported `PXE-E16: No valid offer received`. **Not reproduced on Linux**: one run gave `yiaddr .10`, `siaddr .1`, mask /24 and option 13, and OVMF went on to TFTP. What differed in the macOS run is unknown | Linux: correct reply (`siaddr .1`, mask /24), installs |
| without `ip-range` | lease `169.254.x.x/16`, `siaddr 169.254.1.1`. The CHR answers ARP for 169.254.1.1 on ether2, but the BOOTP reply's IP source is 192.168.88.1 | same (Linux re-run too) |
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

> **Corrected by the Linux re-run.** The network stack is in this build. Its drivers depend on
> `EFI_RNG_PROTOCOL`, which nothing provides on `-cpu cortex-a710`, so they never load. With
> `-cpu max` the same file PXE-boots. What follows is what `cortex-a710` shows. See
> [3a on Linux](#3a-on-linux-arm64-edk2-has-a-network-stack-gated-on-an-rng).

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
- x86 UEFI PXE works only with `netinstall-cli` or a ≥7.26 CHR, and costs 4.5–8 minutes of
  network-boot fallthrough on every later reboot while the NIC stays first in the boot order.
  (The macOS "only without `ip-range`" did not reproduce: 7.26beta7 installs with it.)
- arm64 EDK2 PXE fails at the server: both MikroTik servers answer option 93 = 11 with a BOOTP
  reply that has no subnet mask, and EDK2 drops it. With quickchr's `cortex-a710` it never gets
  that far, because EDK2's network stack does not load without an RNG.
- `-kernel netinstk/linux.<arch>` worked in every server × arch combination tried, with
  `romfile=` set: under plain SeaBIOS (and OVMF) for x86, and under EDK2 for arm64.

Dropping the iPXE ROM by default (#327) therefore costs a future netinstall feature nothing.
~~On macOS Homebrew the arm64 `PXESupport` fw_cfg knobs will be no-ops, because there is no network
stack to switch off.~~ Corrected: arm64 network boot is off today only because `cortex-a710` has
no RNG. On a CPU model with one (`max`, `neoverse-n2`/`-v1`, possibly `-cpu host` under HVF/KVM;
not checked), EDK2 runs PXE and then HTTP boot. The `PXESupport` knobs removed only the PXE
options on Arch's aarch64 build; HTTP boot still ran (one run). #327 needs more than those two
knobs to make a broken arm64 disk fail fast on such a CPU.

**A real `--netboot` / netinstall feature is feasible.** It is worth an issue as a testing tool,
not as another way to get a CHR:

1. **Netinstall target machine.** A blank disk, `-kernel` from the netinstk cache (a new cache item:
   `upgrade.mikrotik.com/routeros/<ver>/netinstk/linux.<arch>`), `-no-reboot` as the "installed"
   signal, then a reboot from disk. Hardware profile: x86 `ide-hd` + e1000, arm64 NVMe + igb. The
   disk must **stay** non-virtio at runtime, which conflicts with quickchr's virtio-only disk
   assumption. A boot-time NIC can be virtio again.
2. **CHR netinstall server recipe.** A machine with `--add-package netinstall` and a
   `socket::<name>` link, plus REST setup: `install-once=yes`, an `ip-range` in the link's subnet
   (it worked on 7.25.2's BOOTP and on 7.26beta7 in the Linux re-run; without one the target gets
   169.254/16), and a check-for-updates first on 7.26. Expect ~1 Mbps without a paid or trial license.
3. **Scope it honestly.** The product is **x86/arm64 RouterOS with a 24 h demo license**, not CHR.
   That is right for testing netinstall itself (`-s`/`-sm` and `script-file`/`mode-file`, the
   etherboot protocol, the `netinstall` package, `tikoci/netinstall`) without hardware or root.
   It does not replace `chr-<ver>.img`.
4. **#328 side note.** Netinstall under UEFI yields a FAT-ESP x86 disk from MikroTik's own
   tooling. It is not CHR, so it does not replace fat-chr.

## Not tested / open

- ~~x86 `-kernel` under OVMF~~: works, writes the FAT layout (Linux re-run, 1d).
- ~~Distro AAVMF network stack, arm64 PXE with option 93 = 11~~: present, RNG-gated; servers send a
  mask-less reply (Linux re-run, 3a). Open: does a real ARM64 RouterBOARD's etherboot use the same
  bare reply, and does any MikroTik version add a mask for `arm64_uefi`?
- Whether `-cpu host` under HVF (Apple Silicon) or KVM (arm64 Linux) has an RNG, which would turn
  arm64 network boot on for quickchr's accelerated arm64 machines.
- The cause of `Fatal error 0x853` on virtio-blk (x86 and arm64 alike).
- ~~7.26 CHR with `ip-range`~~: works (Linux re-run, 2b). Why 7.25.2 sent `siaddr 0.0.0.0` on macOS.
- The `netinstall-cli` Alpine VM path of `ni-server.sh` on Linux (only native mode ran there).
- Whether the demo countdown persists across reboots. Every boot here read about `23h49m` at
  about 30 s uptime.
- What UDP/59813 is.

## Reproduce

Run everything from the repo root. `WORK` (default `/tmp/pxeni`) holds disks, pcaps, logs and the
sockets. Keep it short, because socket paths are limited to 104 bytes. The `netinstall-cli` server
needs `vmlinuz-virt` and `initramfs-netinstall.gz` from a `tikoci/netinstall` checkout (`NI_VMLINUZ`,
`NI_INITRD`). Without them, on Linux, it runs `netinstall-cli` natively in `unshare -rn`
(`NI_MODE=native|vm` forces one). That needs unprivileged user namespaces, `/dev/net/tun`,
`python3`, `ip` and `tcpdump`. Downloads are fetched into `$WORK/dl`. On a Linux host with a 7.8 GB
`/tmp` tmpfs, keep `WORK` small or move it: a full `/tmp` makes the installer's disk writes fail
(`ERROR: could not format partitions`).

`lib.sh` picks firmware and acceleration: QEMU's `edk2-*` names under `QEMU_SHARE` first, then
Arch, Debian/Ubuntu and Fedora package paths (override with `OVMF_CODE`/`OVMF_VARS`,
`AAVMF_CODE`/`AAVMF_VARS`). x86 uses KVM when `/dev/kvm` is usable, HVF on an Intel Mac, else TCG
(`X86_ACCEL`). arm64 targets use `ARM_CPU` (`max` in `target-arm64.sh`, `cortex-a710` in the
`-kernel` path and the probe).

```sh
sh test/lab/pxe-netinstall/exp1-netinstall-cli.sh uefi      # 1b, then boots the result and reads REST
WAIT=40 sh test/lab/pxe-netinstall/exp1-netinstall-cli.sh bios  # 1a
sh test/lab/pxe-netinstall/exp1-netinstall-cli.sh direct-bios # 1c
sh test/lab/pxe-netinstall/exp1-netinstall-cli.sh direct-uefi # 1d (Linux re-run)
IP_RANGE=192.168.88.10-192.168.88.20 sh test/lab/pxe-netinstall/exp2-chr-server.sh 7.26beta7 pxe
sh test/lab/pxe-netinstall/exp2-chr-server.sh 7.26beta7 pxe  # 2b
sh test/lab/pxe-netinstall/exp2-chr-server.sh 7.25.2 pxe     # 2a (stalls in TFTP; stop it)
sh test/lab/pxe-netinstall/exp2-chr-server.sh 7.25.2 direct-x86
sh test/lab/pxe-netinstall/exp2-chr-server.sh 7.25.2 direct-arm64
sh test/lab/pxe-netinstall/exp3-arm64.sh probe               # 3a
sh test/lab/pxe-netinstall/exp3-arm64.sh install             # 3b
WAIT=300 sh test/lab/pxe-netinstall/exp3-arm64.sh pxe        # 3a on Linux: EDK2 PXE, mask-less reply
IP_RANGE=192.168.88.10-192.168.88.20 WAIT=120 sh test/lab/pxe-netinstall/exp2-chr-server.sh 7.26beta7 pxe-arm64
sh test/lab/pxe-netinstall/exp4-slirp.sh                     # 4
```

| File | Role |
|------|------|
| `lib.sh` | paths, downloads, `dgram_pair`, `uefi_vars`, `hmp` |
| `ni-server.sh` | `netinstall-cli` on one end of a dgram link: in an Alpine VM, or natively in `unshare -rn` |
| `tapbridge.py` | joins a TAP device to a QEMU unix dgram link (native `ni-server.sh`) |
| `target-x86.sh`, `target-arm64.sh` | blank PXE-first targets (`DISK_DEV`, `NIC_DEV`, `DISK_SERIAL`, `ROM`; arm64: `ARM_CPU`, `RNG`, `IGB`) |
| `direct-install.sh` | `-kernel` netinstall target with `-no-reboot` |
| `boot-installed.sh` | boot a result on `user` networking and wait for REST |
| `exp1…exp4` | the experiments above |
| `scripts/` | the `-s` / `-sm` (`script-file` / `mode-file`) scripts |
