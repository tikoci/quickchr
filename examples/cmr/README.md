# cmr — four RouterOS routers, OSPF and a CMR controller

**Status:** ⚠ Beta lab · manual only · not part of the routine CI smoke subset

**Validated against:** RouterOS 7.26beta5 (default), x86 CHR. Earlier builds with
`--version`; what changed per build is in [FINDINGS.md](./FINDINGS.md).

This example is also quickchr's **CMR grounding lab**. CMR is still in beta, so
the lab pins a build, keeps [studies](#grounding-studies) that answer one question
each on a fresh lab, and records the answers per build in
[FINDINGS.md](./FINDINGS.md). Other projects (centrs, the `routeros-cmr` skill)
cite that file instead of keeping their own CMR notes.

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

The script pairs clients with `pairClient()` from
[`tool/pairing.ts`](./tool/pairing.ts) (controller approval first, then the
client's generated quickchr login; it records whether a build still needed the
half-pair repair, see [FINDINGS.md → Pairing](./FINDINGS.md#pairing)), applies
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
license is sufficient. The version is pinned (`DEFAULT_VERSION` in
[`tool/lab.ts`](./tool/lab.ts)); `--version 7.26beta1` or
`QUICKCHR_CMR_VERSION` reruns another build.

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
WiFi requires radios and is outside this CHR example. VLAN provisioning and global server pairing policy remain open questions in FINDINGS.md.

Add `--sniff` to any run (the demo, `--probe`, or a study) to record what crosses
the lab's links. The report gains a `wire` section; see [Wire capture](#wire-capture).

`bun run cmr.ts --first-bridge` builds the fleet without bridges (loopbacks on
`lo`), to check the first-bridge alert that 7.26beta1 missed and 7.26beta3's
changelog says is fixed. The `recheck` study covers the same question on a pair
lab.

## Grounding studies

A study boots its own two-CHR lab (controller and one client on one socket link),
answers one question, and writes raw RouterOS output with `--report`. Studies
record rather than assert, so they fail only when the lab breaks.

```sh
bun run cmr.ts --study pairing --boots 3 --trials 12 --report /tmp/pairing.json
bun run cmr.ts --study policy --report /tmp/policy.json
bun run cmr.ts --study recheck --report /tmp/recheck.json
bun run cmr.ts --study wire --report /tmp/wire.json
```

| Study | Question |
|---|---|
| `pairing` | Which pairing sequences leave a fresh client half-paired, how often, and is it per boot? Each trial checks `run-script` selection and then restarts the controller's CMR service to see whether the pairing was committed. `--strategies` picks from `credentialed`, `confirm-first`, `client-local`, `client-none`. |
| `policy` | What may a `run-script` line do on a client, compared with the manual's permission table, and which controller login groups may send one? |
| `recheck` | Do the 7.26beta1 findings (export, client `confirm`, first-interface alert, identity sync, default upgrade rule, disable/enable) still hold? |
| `wire` | What crosses the link while a client connects and pairs? Does MNDP carry CMR state? Do the discovery method (`controller-addresses` or MNDP) or the delay between enabling controller and client change the first connect or the half-pair? `--delays 0,5,30,75` (seconds) and `--trials` pick the grid; it always captures. |

In recheck reports, `firstBridgeFired` is `null` (inconclusive) when the rule
did not cover the client immediately before the first bridge was added
(`ruleCovered=false`). `firstBridgeAlertCount` keeps the observed counter;
the second-bridge check requires a further increment from that count.

Curated reports are kept under [`evidence/<build>/`](./evidence/).
[FINDINGS.md → Re-grounding a new build](./FINDINGS.md#re-grounding-a-new-build)
is the checklist for a new beta. To add a study, write a function in
[`tool/studies.ts`](./tool/studies.ts), register it in `STUDIES`, and give its
question a section in FINDINGS.md.

## Wire capture

`--sniff` and the `wire` study use RouterOS's own packet sniffer. The lab's links
are `socket::<name>` pairs that the host cannot join (see
[docs/mndp.md](../../docs/mndp.md)), so each router reports its own links:

```text
router  /tool/sniffer set filter-interface=ether2[,ether3] streaming-enabled=yes \
          streaming-server=10.0.2.2:<port> filter-stream=yes
        /tool/sniffer start
QEMU    user-mode networking delivers guest UDP for 10.0.2.2:<port> to host 127.0.0.1:<port>
host    one TzspReceiver per router, each on its own ephemeral port
```

Each router is armed right after boot, before identities, addresses or CMR are
configured. It is armed again after the lab's known reboots (the `--probe` backup
restore and the remote restart), setting everything again rather than assuming
the sniffer survives a reboot. A `--probe --sniff` run verified both re-arms by
the frames received afterwards (`routers.*.attached`).
`ether1` is never sniffed, because it carries the stream and the lab's REST calls.

The report's `wire` section uses one clock: milliseconds since `startedAt`, by host
arrival time. RouterOS sends TZSP with no timestamp tag, so the times are accurate
to a few milliseconds of host jitter. It contains:

| Field | Contents |
|---|---|
| `routers` | per router: its host port, sniffed interfaces, and each arming (`attached`) with the frames received before the next one, which shows whether a re-arm after a reboot really restarted the stream |
| `marks` | lab events on the same clock: sniffer armed, clients enabled, each `pair` command returned (passwords redacted), settle verdicts, controller restarts, trial steps |
| `mndp` | one row per announcement (`sender` = identity/interface/family, the 4-byte header). Decoded TLVs and the raw UDP payload hex appear only when they differ from that sender's previous announcement |
| `mndpIntervals` | per sender: announcements, lifetimes (one per machine and boot, from the MAC and the uptime TLV), and min/median/max gap within a lifetime |
| `cmr` | one entry per TCP/54321 connection: every segment that is not a bare ACK as `[t, ">" to controller or "<" from it, flags, payload bytes]`, plus a count of bare ACKs (keepalives) |
| `other` | per router and protocol: count, first and last time (OSPF, ARP, LLDP, CDP, anything new) |

Both ends of a link see each packet, and a router that forwards it sees it on
both of its links. MNDP and TCP rows are deduplicated (`dedupe()`): sightings of
the same content from different **capture points** within 250 ms are one packet,
and the first is kept. A capture point is a router plus the frame's source MAC,
because RouterOS's TZSP carries no interface tag. A forwarded frame changes source
MAC at each hop, while a retransmission repeats a capture point and is kept.
`other` counts each router's view. A frame cut short in its IP or TCP header
decodes as `truncated` rather than stopping the report.

The code is split so the generic part can move:

- [`tool/tzsp.ts`](./tool/tzsp.ts) has no quickchr or CMR imports, only
  `node:dgram`. It contains `TzspReceiver` (bind, collect, `close()`), `tzspPayload()`,
  `decodeEthernet()` (802.1Q, ARP, LLDP, CDP/LLC, IPv4/IPv6, UDP/TCP with flags and
  sequence numbers, OSPF, ICMP, never throwing on a truncated frame) and `parseMndp()`.
  Every MNDP TLV keeps its raw bytes.
  Unit tests with captured RouterOS datagrams:
  [`test/unit/examples-cmr-tzsp.test.ts`](../../test/unit/examples-cmr-tzsp.test.ts).
- [`tool/wire.ts`](./tool/wire.ts) is the lab glue: `Capture.attach()` runs the
  sniffer commands, `mark()` adds events, `cmrBetween()` and `lastMndp()` serve the
  study, and `report()` builds the section above. `dedupe()` and `spread()` are
  pure and unit-tested; a shared package would want them too.

Notes for a shared TZSP package (quickchr, centrs or a new tikoci repo):

- **Use one port per router.** QEMU user-mode networking does not tell the host
  which guest sent a datagram. A shared port would need a different label, such
  as RouterOS's TZSP sensor tag, which these builds do not send.
- **Always close the socket.** An open dgram socket keeps Bun running. The first
  ad hoc capture hung after teardown until a 20-minute limit killed it.
- **Grounded so far:** x86 CHR on Linux/KVM, 7.26beta5, for the pair lab and the
  four-router lab (two interfaces in one `filter-interface`). The gateway path is
  quickchr's documented guest→host UDP primitive (`hostGatewayIp`,
  `captureInterface`), also documented for macOS and Windows hosts but not run
  there with this code.
- **Not built:** pcap/pcapng export for Wireshark, live streaming or filtering,
  IPv6 extension headers, decoding CMR's TCP payload (it is not plain text), and
  a host-side capture for `socket-mcast` or `tap` links, where tshark would do.
- **Overlap with centrs:** centrs' MNDP parser keeps unknown TLVs as type and
  length only. `parseMndp()` here keeps the bytes and names TLV 18 `running`.

## If you copied only this directory

Replace `../../../src/index.ts` in `tool/lab.ts`, `tool/pairing.ts`, `tool/studies.ts`
and `tool/wire.ts`, and
`../../src/index.ts` in `cmr.ts`, with `@tikoci/quickchr` (`bun add @tikoci/quickchr`). Copy
[../lib.ts](../lib.ts) and the CLI common helpers or inline the helpers you use.
For CLI mode set `QUICKCHR=quickchr` to use the installed package.

## Friction found

See [FINDINGS.md](./FINDINGS.md) for observed RouterOS behavior per build,
[REPORT.md](./REPORT.md) for the original 7.26beta1 record, and
[prepared support reports](./SUPPORT-REPORTS.md). This example deliberately uses bounded polling of CMR
state; host REST readiness alone does not prove pairing or OSPF convergence.

## See also

- [Coverage matrix](../COVERAGE.md)
- [CMR manual](https://manual.mikrotik.com/docs/management-tools/cmr/)
- [Shared CMR skill](https://github.com/tikoci/routeros-skills/blob/main/routeros-cmr/SKILL.md)
- [Amm0Bot's OSPF topology](https://forum.mikrotik.com/t/i-upgraded-a-chr-from-an-iphone-a-bots-eye-view-of-agentic-routeros-ops/273246/8)
