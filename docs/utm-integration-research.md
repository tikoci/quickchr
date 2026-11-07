# UTM integration research

Research date: 2026-11-06. This is an options assessment, not an accepted design
or implementation specification. No UTM integration is implemented by this report.

## Direction after discussion

The preferred direction is now a **low-priority UTM-native machine kind**, rather
than linking existing quickchr machines and translating edits back on unlink.
An eventual `bunx @tikoci/quickchr utm` wizard could reuse machine selection and
provisioning work, then leave a native UTM bundle with UTM as its authority.
The handoff recommendation below records the initial assessment; it is superseded
by this direction, and does not authorize implementation.

The existing [CHR Images page](https://tikoci.dev/chr-images.html) already offers
Open in UTM and ZIP downloads. Its missing capability is provisioning, rather
than another way to register a bundle. Another plausible route is to expose
reusable provisioning through centrs and treat a UTM guest as any other RouterOS
device. That needs a separate review of provisioning dependencies: quickchr's
REST/SSH operations may transfer, while console fallback, host power cycles,
disk resets, and provisioning rollback currently depend on quickchr's runtime.
This report does not propose changing centrs or the website yet.

Persistent quickchr-owned macOS guests with direct vmnet networking are a
different topic; see [launchd service research](macos-launchd-research.md) and the
[managed-network/service research direction](macos-managed-services-research.md).

## Conclusion

UTM can open a generated `.utm` bundle in place and register it as a shortcut.
That makes a quickchr-to-UTM handoff plausible without importing a second copy.
It does **not** make UTM a GUI for quickchr's already-running QEMU process: UTM
loads its own configuration and launches its own backend.

The difficult boundary is ownership of the disks, runtime, and configuration,
not generating XML. A small command surface can conceal a substantial lifecycle
change. In particular, a safe automated `unlink` is not established by the public
scripting interface inspected here.

My preferred direction for the first experiment is **UTM ownership after an
explicit handoff**: quickchr creates and optionally provisions the guest, then
UTM owns virtual hardware configuration and runtime. Keep the bundle outside
UTM's default storage and register it as a shortcut. Do not attempt bidirectional
configuration synchronization initially. An independent export is the simpler
alternative if continuing to use the same guest disk is unnecessary.

## Evidence and limits

Inspected quickchr's `MachineConfig`/`MachineState`, QEMU argument generation,
status checks, provisioning, and design documentation; sibling mikropkl's
`Pkl/UTM.pkl`, `Pkl/utmzip.pkl`, README, and Makefile; current UTM documentation
and upstream source at commit
[`bbe69345b578b5ae89cc8e553399c480b10927d9`](https://github.com/utmapp/UTM/tree/bbe69345b578b5ae89cc8e553399c480b10927d9).

This research ran on Linux. Findings below are documentation/source observations,
not a passing macOS integration test. Upstream `main` can include features absent
from installed releases. A product design must choose a minimum released UTM
version and test its actual scripting dictionary and bundled `utmctl`.

## What UTM actually provides

### Bundles and shortcuts

A `.utm` is a directory bundle containing `config.plist`, normally with disks
and other resources in `Data/`. A distributed `.utm.zip` is a ZIP containing that
directory, not the on-disk document itself. mikropkl already generates these
bundles and demonstrates both QEMU and Apple backends.

On macOS, UTM's ordinary file-open import path defaults to `asShortcut: true`.
For an external bundle it registers the existing location; it does not copy it
into default storage. UTM keeps persistent bookmarks for access. Opening the
same file again selects the existing registration. Shortcut classification is
based on the bundle's parent directory relative to UTM's default storage.
This is UTM registration, not a filesystem symbolic link.

The AppleScript **import** verb is different: it calls `importNewUTM`, copies
the bundle into default storage, and adds a separate VM registration (regenerating its UUID on collision). Consequently,
`open -a UTM <bundle>` is the candidate for `link`; AppleScript `import` is a
candidate for an independent import/export workflow. Confirm the resulting UUID
and file location through UTM rather than treating successful `open` as completion.

Source: [UTMData import paths](https://github.com/utmapp/UTM/blob/bbe69345b578b5ae89cc8e553399c480b10927d9/Platform/UTMData.swift),
[shortcut classification](https://github.com/utmapp/UTM/blob/bbe69345b578b5ae89cc8e553399c480b10927d9/Platform/VMData.swift),
[scripting import](https://github.com/utmapp/UTM/blob/bbe69345b578b5ae89cc8e553399c480b10927d9/Scripting/UTMScriptingImportCommand.swift).

### Removal is a trap for an `unlink` command

The GUI's Remove shortcut action calls `listRemove` and preserves the bundle.
The scripting `delete` action instead calls `data.delete`, which removes the
loaded bundle from disk, including when it is externally located. The CLI
documents `delete` as destructive. These are different operations.

There is no public shortcut-only unregister command in the inspected scripting
dictionary or CLI. Do not implement `unlink` with `utmctl delete` or AppleScript
`delete`. mikropkl's `utm-uninstall` currently invokes AppleScript `delete`, so
that helper is not a safe model for the proposed command.

For a first version, either make removal a guided UTM GUI action, or add/obtain
an upstream public unregister operation before promising automatic `unlink`.
Editing UTM's private registry/preferences is a fragile alternative and should
not be the default. Merely deleting quickchr's association leaves the UTM entry
able to start the VM and does not complete a safe return to quickchr.

Source: [GUI removal](https://github.com/utmapp/UTM/blob/bbe69345b578b5ae89cc8e553399c480b10927d9/Platform/Shared/VMConfirmActionModifier.swift),
[scripting deletion](https://github.com/utmapp/UTM/blob/bbe69345b578b5ae89cc8e553399c480b10927d9/Scripting/UTMScriptingVirtualMachineImpl.swift),
[bundle deletion](https://github.com/utmapp/UTM/blob/bbe69345b578b5ae89cc8e553399c480b10927d9/Platform/UTMData.swift).

### Automation and cached configuration

`utmctl` ships inside UTM.app and wraps its AppleScript interface. It supports
listing/status, start/stop/suspend, and serial attachment; some guest operations
require QGA. Prefer UUIDs over names and verify UUID-to-path identity. UTM must
participate in these operations; this is not an independent headless hypervisor
daemon. macOS automation permissions and app sandbox access need testing.

The inspected upstream dictionary exposes a VM's bundle file and a stopped-only
`reload configuration` operation that discards cached changes and rereads disk.
Those can help detect associations and refresh generated configuration, subject
to release availability. A plist write alone cannot be assumed to update an
already-loaded UTM configuration.

The old `utm://start`, `stop`, and related URL commands were removed in 4.5.1.
`utm://downloadVM?url=...` remains a download/extract/import flow, unsuitable for
linking an existing local VM in place. mikropkl's README still describes the old
lifecycle URLs and should be corrected separately if this work proceeds.

Sources: [scripting overview and CLI](https://docs.getutm.app/scripting/scripting/),
[remote-control URL changes](https://docs.getutm.app/advanced/remote-control/),
[upstream scripting dictionary](https://github.com/utmapp/UTM/blob/bbe69345b578b5ae89cc8e553399c480b10927d9/Scripting/UTM.sdef).

## Mapping quickchr to UTM

| Concern | Current quickchr | UTM mapping / implication |
|---|---|---|
| Identity | Machine name and directory | Persist a stable UTM UUID and bundle path; names can change in the GUI. |
| Architecture | `x86`, `arm64` | QEMU `x86_64`, `aarch64`. |
| CPU / memory | Explicit counts and MiB | `System.CPUCount`, `MemorySize`; UTM defaults such as CPU count zero must be resolved or preserved deliberately. |
| Machine type | x86 `pc`, ARM `virt` | Preserve the target; mikropkl's x86 default is `q35`, which is a hardware change. |
| Boot | x86 BIOS, ARM UEFI | Select the corresponding UTM boot settings. Apple backend is a separate compatibility project. |
| Disks | Raw or qcow2 boot disk; qcow2 extras | Bundle `Data/` images are conventional. Preserve disk order and interface; mikropkl uses NVMe on ARM while quickchr uses VirtIO PCI. |
| ARM firmware state | `efi-vars.qcow2` plus host firmware | UTM manages its own firmware files. Do not assume names, format, firmware version, or saved state are interchangeable. |
| User networking | QEMU SLIRP with host forwards | UTM QEMU `Emulated` mode is the corresponding starting point; `Shared` uses a different networking path on macOS. |
| Host forwards | Stored TCP/UDP mapping | UTM `PortForward` entries; preserve ports and binding semantics, and validate guest DHCP/gateway behavior. |
| NICs | Ordered network configurations | Preserve order, model, and MAC identity. Socket/TAP/socket_vmnet topologies need separate mapping or explicit rejection. |
| Serial / monitor / QGA | quickchr-created socket channels | UTM owns its channels. Existing `ChrInstance` methods cannot simply assume quickchr socket paths remain usable. |
| Runtime | Status plus PID; `kill(pid, 0)` check | UTM status is authoritative when UTM runs it; unknown/unreachable must not mean stopped. |
| Provisioning | First-boot intent plus records of applied steps | Creating with `add` does not apply provisioning. Handoff must either provision first or explicitly reject/defer pending work. |
| Authentication | Guest credentials and managed SSH key metadata | Keep credentials in quickchr's existing store; do not copy secrets into plist notes. Reachability/auth must be verified for live descriptors. |
| Extra argv | Arbitrary `qemuArgs` | No general safe translation. Reject unsupported combinations initially; copying all argv would duplicate UTM-owned devices and control channels. |

UTM supports additional QEMU arguments, but imported custom arguments trigger a
security notice. Using them for the entire quickchr launch line would defeat
the purpose of native editable UTM configuration.

The existing quickchr Apple Silicon rule still applies: current ARM64 CHR images
contain required ARM32 userspace, so QEMU TCG is required. Switching the launcher
to UTM does not create AArch32 support in Apple hardware. Do not enable HVF or
promise the Apple Virtualization backend as an automatic speed improvement.
See [the existing investigation](m4-hvf-arm64-investigation.md) and DESIGN.md #10.

Relevant mapping sources: [UTM drive configuration](https://github.com/utmapp/UTM/blob/bbe69345b578b5ae89cc8e553399c480b10927d9/Configuration/UTMQemuConfigurationDrive.swift),
[network modes](https://github.com/utmapp/UTM/blob/bbe69345b578b5ae89cc8e553399c480b10927d9/Configuration/QEMUConstant.swift),
[generated QEMU arguments](https://github.com/utmapp/UTM/blob/bbe69345b578b5ae89cc8e553399c480b10927d9/Configuration/UTMQemuConfiguration+Arguments.swift).

## Ownership options

| Model | Authority | User experience | Cost / limitation |
|---|---|---|---|
| Independent export | Each tool owns its own VM and disk copy | Export a stopped guest, then edit/run the UTM copy freely | Simplest boundary; subsequent RouterOS changes diverge. Call it export, not link. |
| Generated UTM configuration | quickchr owns mapped hardware; UTM owns presentation | Link the same guest; hardware changes go through quickchr | Must detect drift and cached edits. UTM UI does not become read-only because quickchr says so. Runtime/lifecycle changes still required. |
| Explicit handoff | UTM owns hardware/runtime after linking; quickchr keeps provenance and guest metadata | Create/provision with quickchr, then edit and run in UTM | Best match for GUI editing. Native quickchr launch/clean/remove must be blocked or routed through a UTM adapter. Returning ownership is a separate operation. |
| UTM-native machine kind | UTM plist is authoritative from creation | `add` creates a bundle; quickchr commands use a UTM backend | Clean long-term model; requires backend dispatch, capability reporting, and a defined supported subset. |
| Bidirectional synchronization | Both edit a shared projection | Edits from either tool reconcile | Largest scope: merge conflicts, unknown fields, pending UI edits, and incompatible hardware choices. Avoid initially. |

These choices are independent of registration: either a generated or UTM-owned
configuration can live in an external bundle registered as a shortcut.

For a generated model, compare a normalized projection of fields quickchr owns
against the last generated projection. Report drift and require an explicit
refresh or handoff; do not silently overwrite UTM edits. Preserve unknown and
presentation fields. Whole-file hashing alone confuses harmless UTM serialization
changes with meaningful hardware drift.

For a handoff model, `machine.json` remains an association/provenance record,
not a second authoritative hardware configuration. A possible future record
would include runtime owner, bundle path, UTM UUID, and the generation baseline.
The field names and schema migration remain undecided. Quickchr-owned commands
must not keep using old CPU, network, disk, or PID assumptions after handoff.

## Storage and lifecycle implications

1. Prefer a real bundle with real disks in `Data/` for the experiment. For
   example, an outer quickchr directory could contain `machine.json` and
   `guest.utm/`. Supporting that requires adapting quickchr's disk path handling;
   it is not a drop-in layout change.
2. A thin bundle with symlinked `Data/` disks is tempting but unproven under
   sandbox access, UTM saves, clones, moves, and image conversion. Hard links
   also break when either tool replaces a file. External drives use UTM
   bookmark/registry mechanisms, not just an arbitrary absolute `ImageName`.
3. Enforce one runtime owner for shared disks. Quickchr's operation lock is not
   observed by UTM, and its PID status cannot see a UTM-launched process. QEMU
   image locks are an additional defense, not an ownership protocol.
4. A suspended UTM guest still owns its state. Never launch the same disk under
   quickchr while UTM can resume it. Require a cold shutdown and resolve saved
   state before returning ownership. Do not treat snapshots from different QEMU/firmware
   builds as interchangeable.
5. Guard `start`, `clean`, `remove`, disk resize, snapshots, port allocation,
   and any bulk cleanup against the new owner. If UTM cannot be queried, refuse
   a destructive operation rather than inferring that the machine is stopped.
6. GUI removal only changes registration. It does not reverse hardware edits,
   restore a quickchr disk layout, reconcile ports, or make old provisioning and
   connection metadata current. Consequently, unregistering and returning ownership should
   have separate meanings even if eventually exposed together.

CHR license/software identity preservation also needs live verification after
disk/controller/UUID changes. Do not assume a copied disk with changed virtual
hardware preserves the identity or can safely be run as a second licensed guest.

## Suggested bounded experiment

Use a disposable x86 QEMU guest first, with the same BIOS machine type, VirtIO
disk, one emulated NIC, stable MAC, explicit host forwards, and a serial terminal.
Create and provision it with quickchr, shut it down, and generate a standalone
bundle using mikropkl's plist structure as reference. Avoid making Pkl a required
quickchr runtime dependency just for XML generation.

On an actual Mac, record UTM/macOS/QEMU versions and establish:

- Opening twice registers one UUID at the original path and creates no second
  disk; repeat with the sandboxed UTM distribution and its permission prompts.
- UTM boots the guest, exposes the serial console, and preserves RouterOS
  configuration, credentials, NIC order, forwards, and observed license identity.
- GUI edits survive save, app restart, and any supported configuration reload;
  determine the minimum released version for each scripting capability used.
- GUI shortcut removal preserves every disk. Test scripting deletion only on
  a separate sacrificial bundle to confirm its different behavior.
- Quickchr refuses to launch or clean a UTM-owned machine, including while UTM
  is unavailable or suspended; disk replacement cannot leave a stale link.
- A cold, explicit return to quickchr either preserves the supported hardware
  mapping or fails with a concrete unsupported-field report.
- Repeat for ARM under TCG, including UEFI state, and for qcow2/extra disks.

The results decide between a simple independent export and a persistent UTM
machine kind. `quickchr utm link <name>`, `status`, and eventually `unlink` are
reasonable command names, but their ownership semantics should be settled first.
An eventual `link --all` should reconcile associations without duplicates and report
per-machine conflicts; it should not silently regenerate every editable plist.

No live tests were run for this report. No accepted design, shipped behavior,
or release notes are changed.
