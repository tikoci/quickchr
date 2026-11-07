# macOS launchd experiment

Status: ran live on Morpheus (Intel Mac) 2026-11-06; see `REPORT.md` for versions,
timings, and evidence. No service remains installed and no test guest remains.

Purpose: establish whether a persistent quickchr guest can be supervised by
launchd with direct vmnet networking, retaining a stable management endpoint for
app-t3code projects. This is a disposable experiment, not production service mode.

Next research: [quickchr-owned managed networks and service lifecycle](../../../docs/macos-managed-services-research.md).
This direct-QEMU lab is an initial comparison, not the final service architecture.

## Scope

Use one x86 guest with user-mode management first and native vmnet-shared second.
Start with no automatic restart or start-at-boot. Preserve serial socket access;
no video or UTM is involved. Record versions, generated argv, service state,
process counts, connectivity, permission failures, and cleanup evidence.

`generate.ts` reads an already provisioned and stopped `launchd-lab-` machine and
writes a fresh output directory containing a plist and a deployment manifest.
It reuses quickchr's argument builder, does not spawn anything, and does not
install a service or update machine state. The manifest contains host paths and
network mappings; it deliberately excludes guest credentials.

## Execution on the linked Mac

1. Read the Mac checkout's instructions and record its commit, Bun/QEMU versions,
   macOS version/architecture, data directory, current jobs, and QEMU processes.
   Use an isolated, short data path and a unique `launchd-lab-` name. Confirm the
   QEMU build supports native vmnet. Obtain privilege through the supported private
   secret/approval flow if required; never put a sudo password in chat or artifacts.
2. Provision the guest using this checkout's supported flags, with `user` first
   and `vmnet-shared` second. A direct-vmnet initial boot requires privileged
   QEMU initialization: use a reviewed, explicit owner-data-path invocation for
   this disposable lab and audit resulting ownership. Do not silently provision
   a different NIC topology and change persisted MAC identities afterward.
   Configure DHCP on ether2 through centrs, with offline explanation and readback.
3. Shut down gracefully and verify no process still holds the disk. Generate as
   the machine owner:

   ```sh
   bun test/lab/macos-launchd/generate.ts launchd-lab-<unique> /private/tmp/<new-output>
   ```

4. Inspect plist/argv, run `plutil -lint`, and check executable/path ownership.
   This is an explicitly admin-controlled test deployment, with no unattended
   execution of editable Bun code. Install the reviewed plist root-owned under
   `/Library/LaunchDaemons`, bootstrap it in the system domain, then kickstart it.
   Record launchctl's observed PID separately from quickchr's stopped record.
5. Verify serial/monitor access as the owner and privileged caller, REST/SSH
   readiness through the stored localhost mapping, and DHCP/reachability on ether2.
   Use centrs explicit endpoint targeting: `--quickchr` may refuse because this
   experiment deliberately does not fabricate quickchr runtime state.
6. Repeat start, guest reboot, graceful guest shutdown, start, forced termination,
   and start. Verify one QEMU each time, no automatic restart, preserved RouterOS
   identity/configuration, and stable localhost ports. Do not use ordinary
   quickchr start/clean/remove while launchd owns the disk.
7. Test privilege drop separately using the installed QEMU's supported option,
   recording effective user ID and networking/channel behavior after the drop.
   Test bridged networking separately only after shared mode works and an
   appropriate host interface has been identified.
8. In a `finally` cleanup path: bootout the exact generated label, verify its
   QEMU exited, remove only its installed plist, restore ownership of lab files
   if needed, then remove the disposable guest through quickchr. Verify no job,
   QEMU process, or lab socket remains. Preserve logs and a sanitized report.

Do not reboot the user's Mac for this experiment. Host-reboot/start-at-boot
validation is a later explicitly scheduled test; guest reboot is in scope.

## T3 project handoff observations

Record whether a project running on the same Mac can consume stable REST/SSH
endpoints after restart without depending on this agent's lifetime. A project on
another T3 machine cannot use the Mac's localhost endpoint directly: environment
linking is an execution/control connection, not an assumed TCP tunnel. Establish
where the app runs before choosing LAN access or an explicit transport.

Future UX must distinguish persistent service ownership from disposable test
cleanup, desired running state from readiness, and temporary stop from disabling
autostart. The platform-neutral contract can later map to systemd or Windows
services; this experiment does not prescribe their implementations.
