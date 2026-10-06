# CMR beta lab evidence

Tested 2026-10-05 local date (captures use 2026-10-06 UTC), **RouterOS
7.26beta1 x86 CHR**, quickchr 0.4.8 at base commit `a258a7b`, Bun 1.4.2,
QEMU 11.1.1, Intel macOS/HVF. All routers were disposable VMs; no physical
router was contacted or upgraded. A second agent rechecked every finding on a
fresh lab ([config/7.26beta1-recheck.json](./config/7.26beta1-recheck.json)).

![CMR lab topology](./config/topology.svg)

The topology is controller—transit—remote, plus controller—local
([topology.dot](./config/topology.dot)). Each link is a unique named socket pair. Every
guest has its own user-mode management NIC, on which tcp/54321 is dropped
inbound and reset outbound. The remote connects to the controller loopback
through OSPF. The local client finds its controller without a configured
address. Normal runs put the loopback on a bridge created before CMR starts.

## Results and limits

| Check | Result |
|---|---|
| Matching controller package and built-in clients | CMR installed only on controller; all four guests pinned to 7.26beta1 |
| TCP service | Dynamic `cmr` service on 54321 |
| Routed client | Paired at `10.255.0.1`; active OSPF route via transit |
| Direct discovery | Local client found `203.0.113.1` without `controller-addresses` |
| Six fresh pairing combinations | Client none/password × per-device server none/password/confirm paired successfully |
| Fleet script | Successful nonce-bearing output per device |
| Topology | Four nodes and three links matching the socket graph |
| Alerts | Log marker, bridge addition, connected, disconnected-more-than and rebooted fired; HTTP webhooks delivered |
| Resource/version monitors | Enabled and read back; resource exhaustion and upgrades not induced |
| Remote stop/start (`--probe`) | Down alert and webhook, then reconnect without re-pairing and a second connected webhook |
| Clean reboot, hard power-off, controller reboot | Client reconnected with pairing intact each time (recheck) |
| First bridge event | First bridge on a bridge-free device never alerts; later ones do (three devices) |
| Client disable/enable | Client drops to `waiting-for-pairing`; controller row flagged REMOTE-PENDING |
| Client confirm | Completion lists none/password; confirm returns syntax error at column 37 |
| Default upgrade rule | Dynamic stable rule; edit rejected; observed offer 7.24.5 is older than 7.26beta1 |
| Lab upgrade rule | Matching devices selected pinned 7.26beta1 rule; no upgrade triggered |
| Package directory | Existing directory accepted with trailing slash; missing slash rejected |
| Export | Scoped, verbose and full verbose exports omit controller settings and device labels |
| Binary backup | Save, disable and load restored identical settings, device identities, labels and pairing IDs |

Bounded results of the default demo are in
[config/7.26beta1-demo.json](./config/7.26beta1-demo.json). Probe observations,
and hashes of the original captures, are in
[config/7.26beta1-probes.json](./config/7.26beta1-probes.json).
[SUPPORT-REPORTS.md](./SUPPORT-REPORTS.md) has the findings written up for
MikroTik.

## The reconnect failure that was the lab

The first `--probe` runs failed: after a restart, the remote stayed
`paired,disconnected` for 90+ seconds, even with Full OSPF and working pings.
The recheck traced that to the lab, not to CMR.

While OSPF had no route to `10.255.0.1`, the client's connect followed the DHCP
default route out of `ether1`. The SYN kept retransmitting from `10.0.2.15`
after OSPF recovered, and every user-mode NIC has that address, so it could
never complete. The `probes.json` `restart` sample, `waiting-for-pairing` with
`password required`, came from the client disable/enable control in that run,
not from the restart. That control is now finding 4 in the support reports.

`tool/lab.ts` now rejects tcp/54321 leaving `ether1` with a TCP reset. With that
rule the full `--probe` run passed (exit 0), including automatic reconnect.
Without it, a reconnect could take one SYN timeout.

## What the bugs mean for this example

The default demo runs and inspects the fleet. It asserts its core behaviour and
cleans up on success or failure; `--hold` keeps the lab and the host webhook
listener alive for GUI exploration until Ctrl-C.

`--first-bridge` builds the lab without bridges and fails if the first
bridge-added event is missing. Creating a bridge before CMR starts is a lab
setup choice, **not a fix**.

`--probe` adds the pairing, export and backup checks, then a real outage of the
remote.

The directory slash, the restart on a directory change and the older upgrade
offers are documented behaviour, not bug reports.

## Verification

- `bun run cmr.ts --probe --report …` with the output-reject rule: exit 0 in
  about 5m20s.
- Teardown: earlier `--probe` runs leaked the restarted remote's QEMU. The old
  handle's `remove()` deleted the machine state without stopping the new
  process, so `quickchr list` looked clean. Teardown now removes machines by
  name. After a fixed `--probe` run, and after a Ctrl-C during boot, no
  `qemu-system` process for the lab remained (checked with `ps`, not only
  `quickchr list`).
- `bun run check` and `bun test test/unit/`: 1,220 pass, 19 existing skips.
- PowerShell parser: passed. No Windows or PowerShell end-to-end run is claimed.
- Not part of the routine CI smoke subset; no hosted CI result is claimed.

WiFi radios, physical health sensors, VLAN provisioning, DHCP discovery,
application-traffic classification, global controller pairing policy,
push-button pairing, wrong-password controls, arm64 CHR and newer betas remain
separate experiments. Work is tracked in
[quickchr #183](https://github.com/tikoci/quickchr/issues/183).
