# cmr — four RouterOS routers, OSPF and a CMR controller

**Status:** ⚠ Beta lab, work in progress · manual only · not part of the routine CI smoke subset

**Validated against:** RouterOS 7.26beta1, x86 CHR (see [REPORT.md](./REPORT.md)).

## What it does

Builds four disposable CHRs using quickchr's named socket links. The controller
installs the optional `cmr` package; the other routers use the built-in client.
OSPF carries the controller loopback to a remote client through a transit router.
A directly attached client discovers CMR without `controller-addresses`.

![CMR lab topology](./config/topology.svg)

Source: [topology.dot](./config/topology.dot).

Every link is its own `socket::<unique-name>` pair. Every router also has an
independent `ether1` user-mode NIC for host management. CMR TCP/54321 is dropped
inbound and reset outbound on that NIC, so CMR sessions use the socket topology.
The outbound reset matters: without it, a connect attempted while OSPF has no
route leaves via the user-mode default route and stalls for a SYN timeout.
The remote client connects to `10.255.0.1`, with an asserted active OSPF route
through the transit router.
There is no physical-device access, TAP interface or host routing change.
Each router has a bridge loopback before CMR starts; see the first-bridge alert
finding in the evidence report.

The script pairs clients using their generated quickchr credentials, applies
labels, pins the lab's upgrade rule, creates resource/reboot/interface/log/version
alerts, runs a nonce-bearing script on all four routers, and builds a topology.
The default demo verifies a connected HTTP webhook at an ephemeral host listener.
The extended probe stops and restarts the remote VM to check disconnect/reconnect
alerts and automatic reconnect without re-pairing. Resource rules
are enabled for exploration; the script does not force CPU/RAM/disk exhaustion.

## Run it

From this directory:

```sh
bun run cmr.ts --report /tmp/cmr-result.json
sh cmr.sh --report /tmp/cmr-cli-result.json
pwsh cmr.ps1 --report /tmp/cmr-powershell-result.json
```

The shell and PowerShell drivers select `--cli`: the shared runner invokes
`quickchr start --add-network socket::… --add-package cmr` and `quickchr exec`.
Read-back assertions use the library in both modes, avoiding duplicated assertions.
They require Bun as well as QEMU. `$QUICKCHR` defaults to the repo CLI and can
select an installed binary, following the other examples' invocation convention.

Expect several minutes on x86 KVM/HVF, longer under TCG. All four guests are
explicitly x86, so an Intel Mac uses HVF and Apple Silicon uses TCG. The free CHR
license is sufficient. Version is pinned to 7.26beta1 for reproducibility.

Add `--hold` to inspect the finished lab in WinBox 4 or WebFig. The script prints
machine names and WinBox ports; use `quickchr inspect <name>` locally for generated
login credentials. Ctrl-C in the hold phase removes all four VMs. Default runs
remove them on success or failure; report JSON survives teardown. Ctrl-C during
boot or probes stops after the current step and removes the VMs (a second Ctrl-C
removes them at once). Teardown looks machines up by name, so a VM restarted by
`--probe` is stopped too. Reports contain
lab state and webhook messages, never descriptors or pairing passwords.

For validated ad hoc commands in another terminal:

```sh
centrs retrieve --quickchr <machine-name> /cmr/device --json
centrs execute --quickchr <machine-name> --yes '/cmr/layout/rebuild-links [find name=lab]'
```

Add `--probe` for six fresh pairing combinations, command completion, default-rule
editing, package-directory syntax, export checks, a real binary-backup restore
and finally the remote outage.
These probes change only the disposable lab. A failing check exits nonzero;
`--report` saves the partial evidence and failure state before cleanup.

The lab configures upgrade rules but never calls `upgrade` or `trigger`.
WiFi requires radios and is outside this CHR example. VLAN provisioning and global server pairing policy remain exploratory work.

To investigate the beta first-bridge event gap, run `bun run cmr.ts --first-bridge`.
This uses the built-in `lo` interface instead of a pre-existing bridge loopback.
If the first event is absent, its assertion fails after 90 seconds and cleanup
still runs. Initialization timing remains unresolved; a passing run is useful
counter-evidence. This bridge-free experiment is outside the default demo.

## If you copied only this directory

Replace `../../../src/index.ts` in `tool/lab.ts` and `../../src/index.ts` in
`cmr.ts` with `@tikoci/quickchr` (`bun add @tikoci/quickchr`). Copy
[../lib.ts](../lib.ts) and the CLI common helpers or inline the helpers you use.
For CLI mode set `QUICKCHR=quickchr` to use the installed package.

## Friction found

See [REPORT.md](./REPORT.md) for observed RouterOS behavior, limitations and
[prepared support reports](./SUPPORT-REPORTS.md). This example deliberately uses bounded polling of CMR
state; host REST readiness alone does not prove pairing or OSPF convergence.

## See also

- [Coverage matrix](../COVERAGE.md)
- [CMR manual](https://manual.mikrotik.com/docs/management-tools/cmr/)
- [Shared CMR skill](https://github.com/tikoci/routeros-skills/blob/main/routeros-cmr/SKILL.md)
- [Amm0Bot's OSPF topology](https://forum.mikrotik.com/t/i-upgraded-a-chr-from-an-iphone-a-bots-eye-view-of-agentic-routeros-ops/273246/8)
