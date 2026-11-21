# CMR findings, by build

This is the **source of truth for what is known about RouterOS CMR** across the
7.26 development builds. Other projects cite it rather than keeping their own copy:
[centrs](https://github.com/tikoci/centrs) (`execute --cmr`, its two-CHR integration
lab) and the shared
[`routeros-cmr` skill](https://github.com/tikoci/routeros-skills/blob/main/routeros-cmr/SKILL.md).
CMR is in beta; any row can change in the next build. When it does, re-run the
study and add a column ([re-grounding a new build](#re-grounding-a-new-build)).

Every cell says where it comes from:

| Mark | Source |
|---|---|
| **lab** | Measured by this example; the evidence file is linked. |
| **centrs** | Measured by centrs' integration lab (linked issue or PR). |
| **log** | MikroTik's `CHANGELOG` for that build. A claim, until a lab cell confirms it. |
| **manual** | [manual.mikrotik.com → CMR](https://manual.mikrotik.com/docs/management-tools/cmr/) (7.26), read 2026-11-12. |
| **vendor** | A MikroTik staff statement on the forum (linked). |
| — | Not measured on that build. |

## Builds

| Build | Released | Status here |
|---|---|---|
| 7.26beta1 | 2026-10-01 | First CMR build. Original lab: [REPORT.md](./REPORT.md), [evidence/7.26beta1/](./evidence/7.26beta1/). |
| 7.26beta2 | never published | Not on the download server (`CHANGELOG` 404). Beta1→beta3 is one step; a change "since beta2" means "since beta3" for anyone booting a build. |
| 7.26beta3 | 2026-10-16 | 17 CMR changelog lines (pairing, export, first interface alert, identity sync). Measured by centrs. |
| 7.26beta4 | 2026-10-27 | Script-policy and VLAN `port-labels` changes. Measured by centrs. |
| 7.26beta5 | 2026-10-30 | **Lab default.** Studies below: [evidence/7.26beta5/](./evidence/7.26beta5/). Most ran on a Linux KVM host; [demo-probe-hvf-2026-11-20.json](./evidence/7.26beta5/demo-probe-hvf-2026-11-20.json) is the `--probe` demo on an Intel Mac (HVF). |

The lab is x86 CHR only. arm64 CHR, physical radios and IPv6 transport are
not grounded here.

## Pairing

### Vocabulary

Both ends have a `pairing-requirement` (`none`, `password`, `confirm`). The
controller has a global value (`/cmr`) and a per-device override
(`/cmr/device`). Read pairing from **both** sides; neither alone tells the truth:

| Term | Client `/cmr/client` `status` | Controller `/cmr/device` row | `run-script` |
|---|---|---|---|
| **pending** | `waiting-for-pairing,connected` | `pending=true` (flag `P`), maybe `remote-pending=true` (`p`); `state="pair: device:<…>, cmr:<…>"` | `no devices selected` |
| **paired** | `paired,connected` | `connected=true`, no `state`, has `upgrade-rule` and `channel` | selects it |
| **half-paired** | `paired,connected` | `connected=true`, `state="pair: device:ok, cmr:ok"`, no `upgrade-rule` | `no devices selected` |
| **committed** | — | Still **paired** after the controller's CMR service restarts (`/cmr set enabled=no`, `enabled=yes`) | selects it |

The client's `status` alone cannot tell paired from half-paired. A lab or tool
that waits only for `paired,connected` will accept a client the controller
never approved. [`tool/pairing.ts`](./tool/pairing.ts) implements these
definitions (`observe()`, `verdict()`, `selectable()`, `restartController()`).

### Claims

| Claim | beta1 | beta3 | beta4 | beta5 |
|---|---|---|---|---|
| Fresh client default `pairing-requirement` | — | — | — | `password` (lab, manual) |
| Fresh device row default (controller per-device) | — | — | — | `confirm` (lab); the manual does not state the server default |
| Without any `pair` command, a fresh client pairs | — | — | — | no (centrs, 3/3) |
| After pairing, the row's `pairing-requirement` reads `none` | — | — | — | yes, for paired and half-paired rows (lab) |
| One credentialed `/cmr/device/pair … username= password=` (the manual's path for server `confirm` + client `password`) can end **half-paired** | no: `state` cleared on first pair (centrs) | yes (centrs, #527) | yes (centrs) | yes: 7/9 trials on three boots (lab, KVM); 24/26 on two boots (lab, HVF, [repair study](#repair-study-726beta5)); 0–100% per boot (centrs). See [the pairing study](#pairing-study-726beta5) |
| The half-paired `pair` command still prints success | — | — | — | yes: its last table ends `device:ok, cmr:ok`, not `paired` (lab, centrs) |
| A half-paired session is idle | — | — | — | yes: a client tcp-reset rule saw 0 packets in 60 s, so it never disconnects (lab) |
| A half-paired pairing is not committed | — | — | — | yes: after a controller CMR restart the row is `pending`, `state="pair: device:ok, cmr:waiting confirmation"` (lab, centrs) |
| A reboot fixes a half-paired client | — | — | — | no: after a client reboot (6/6) or a controller reboot (6/6) the row is `pending` with `cmr:waiting confirmation`, as after a CMR restart (6/6), and the client reads `waiting-for-pairing,connected` (lab, [repair study](#repair-study-726beta5)) |
| A bare `/cmr/device/pair` finishes a half-paired client | — | yes (centrs) | yes (centrs) | yes, before or after a restart or reboot (lab, centrs). The repair is committed: 24/24 survived a controller CMR restart (lab, [repair study](#repair-study-726beta5)) |
| Committing the controller's approval first (bare `pair`, then credentialed) avoids the half-pair | works: 3/3 clients paired, demo passed ([demo-2026-11-12.json](./evidence/7.26beta1/demo-2026-11-12.json)); centrs suite passed | — | — | yes, 9/9 committed (lab); centrs 3/3 |
| A client-side `/cmr/client/pair`, then a bare controller `pair`, avoids it | — | — | — | yes, 9/9 (lab); centrs 7/7 |
| Client `pairing-requirement=none`, then a bare controller `pair`, avoids it | — | — | — | yes, 9/9 (lab); centrs 3/3 |
| Client `pairing-requirement=confirm` accepted | no: syntax error at column 37 (lab) | — | — | **yes**: accepted, and the paired client drops to `waiting-for-pairing` with `device:waiting confirmation` until approved locally (lab). Vendor said it was [frozen before release](https://forum.mikrotik.com/t/claude-and-codex-try-out-cmr-in-7-26beta-mostly-successful/273613/4) |
| Client `enabled=no`, `enabled=yes` clears the pairing | yes (lab) | — | — | yes: client `device:password required`, row kept with `remote-pending` (lab). Vendor: intended. The manual says enabling again "reconnects the client with its existing pairing" |
| Clean reboot, power-off or controller reboot keeps the pairing | yes (lab) | — | — | power-off of the remote and a backup-load reboot of the controller: yes, no re-pairing (lab, `--probe`) |
| In the six-combination matrix (client none/password × device none/password/confirm), only client `password` + device `confirm` half-pairs | — | — | — | it is the only one seen to: it half-paired on the KVM run ([demo-probe.json](./evidence/7.26beta5/demo-probe.json)) and committed on the HVF run ([demo-probe-hvf-2026-11-20.json](./evidence/7.26beta5/demo-probe-hvf-2026-11-20.json)); the same credentialed command against device `none` paired cleanly on both. One run per combination per host (lab `--probe`) |
| Changing a paired client's `pairing-requirement` makes it pair again | — | — | — | yes: `confirm`, and unsetting back to the default, each left the client pending (lab) |
| A fresh client's first connect can take over a minute | — | — | — | yes: 85 s from `enabled=yes` to pending on each of 7 boots, and on 4 more with the wire capture; about 1 s after a later `forget` (lab). Cause: the first SYN is sourced from the management NIC's 10.0.2.15 and times out. See [Wire → first connect](#first-connect-the-85-s) |

**Recommended lab sequence (beta5):** `pairClient()` in
[`tool/pairing.ts`](./tool/pairing.ts): wait for the row to be pending, run the
`confirm-first` sequence, and if the row is still half-paired run one bare
`pair` and **record that it was needed**. Then require `run-script` to select
the client. Do not treat the client's `paired,connected` as proof.

### Pairing study (7.26beta5)

`bun run cmr.ts --study pairing --boots 3 --trials 12` boots three fresh
two-CHR labs. Each trial starts from a client the controller has never seen,
runs one strategy (they rotate), checks `run-script` selection, then restarts the
controller's CMR service to see whether the pairing was committed.

Run 2026-11-12, 7.26beta5 x86 CHR, Linux KVM host, quickchr's generated
client login ([evidence/7.26beta5/pairing.json](./evidence/7.26beta5/pairing.json)):

| Strategy | Commands | Boot 1 | Boot 2 | Boot 3 | Total committed |
|---|---|---|---|---|---|
| `credentialed` | controller: `pair [find] username= password=` | 1/3 | 1/3 | 0/3 | **2/9** (7 half-paired) |
| `confirm-first` | controller: bare `pair`, then the credentialed `pair` | 3/3 | 3/3 | 3/3 | **9/9** |
| `client-local` | client: `/cmr/client/pair`, while controller: bare `pair` | 3/3 | 3/3 | 3/3 | **9/9** |
| `client-none` | client: `pairing-requirement=none`, then controller: bare `pair` | 3/3 | 3/3 | 3/3 | **9/9** |

What the run shows:

- **Only the single credentialed `pair` half-pairs.** Every other sequence was
  committed, interleaved on the same boots (27/27). Earlier runs the same day
  agreed (`credentialed` 2 committed / 3 half-paired, `confirm-first` 3/3), but
  those runs were development runs and their reports were not kept.
- **The `pair` command's output predicts the outcome.** In all 9 captured
  credentialed trials (and the 5 earlier, uncaptured ones), a last table of
  `device:ok, cmr:ok` meant half-paired and `paired` meant committed. A caller
  can check that output instead of polling.
- **It is not only per boot.** One boot gave committed and half-paired results
  on the same strategy. Boot 3 was 0/3, like centrs' "bad boot".
- **Recovery is a bare `pair`.** After a restart, every half-paired client was
  pending with `device:ok, cmr:waiting confirmation`, and one bare `pair`
  restored the pairing (7/7). The [repair study](#repair-study-726beta5) later
  showed that such a repair is committed (24/24).
- The `confirm-first` transcript shows why it works. The bare `pair` prints
  `confirmed, waiting for device`; the credentialed one then prints
  `device:password required, cmr:ok`, followed by `paired`.

Lab mechanics that matter for anyone scripting this:

- A bare `/cmr/client/pair` **blocks until the controller approves**. Run it
  concurrently with the controller's `pair`; a sequential REST call times out.
- After `/cmr/client/set pairing-requirement=…` the client renegotiates. A
  controller `pair` sent before the row shows `device:ok` selects nothing and
  prints nothing.
- Every fresh boot took 85 s from client `enabled=yes` to a pending row
  (7 boots). After `forget` and re-enable it is about 1 s.

### Repair study (7.26beta5)

`bun run cmr.ts --study repair --boots 2 --trials 12` asks what fixes a
half-paired client and whether the fix holds. Each trial pairs a fresh client
with the single credentialed `pair` until it half-pairs, applies one action,
records what it left, finishes with one bare `/cmr/device/pair` if the client is
still not paired, and then runs the commit test (a controller CMR restart).

Run 2026-11-20, 7.26beta5 x86 CHR, Intel Mac (HVF)
([evidence/7.26beta5/repair.json](./evidence/7.26beta5/repair.json)):

| Action on the half-paired client | After the action | After one bare `pair` | After the commit test |
|---|---|---|---|
| none (`bare-pair`) | — | paired, 6/6 | paired, 6/6 |
| controller CMR restart | pending, `cmr:waiting confirmation`, 6/6 | paired, 6/6 | paired, 6/6 |
| client reboot | pending, `cmr:waiting confirmation`, 6/6 | paired, 6/6 | paired, 6/6 |
| controller reboot | pending, `cmr:waiting confirmation`, 6/6 | paired, 6/6 | paired, 6/6 |

- **No reboot fixes a half-pair.** Rebooting either side drops the session, and
  the client comes back pending. The controller's approval was never stored, and
  a reboot does not supply it.
- **After any reconnect the client tells the truth.** While half-paired it reads
  `paired,connected`. After a restart or reboot it reads
  `waiting-for-pairing,connected`, like any pending client.
- **One bare `pair` is the whole repair, and it is committed.** All 24 repaired
  pairings were still paired after a controller CMR restart, with `run-script`
  selecting the client before it.
- The credentialed `pair` half-paired 24 of 26 attempts here (two trials needed a
  second try), more often than the KVM pairing study's 7/9.

### Recheck of the beta1 findings (7.26beta5)

`bun run cmr.ts --study recheck` on a pair lab whose client has no bridges
([evidence/7.26beta5/recheck.json](./evidence/7.26beta5/recheck.json); the
5 s-rule run is [recheck-rule-5s.json](./evidence/7.26beta5/recheck-rule-5s.json)).
Results are in the claim tables: client `confirm` and disable/enable above,
export and identity below, the first-interface alert and the default upgrade
rule further down. Of the four beta1 reports, export is fixed and client
`confirm` now works. The first-bridge alert fired once the rule covered the client.
Disable/enable still clears the pairing.

## Wire

What actually crosses the link, captured with `--study wire` and `--sniff`
([README → Wire capture](./README.md#wire-capture)). Each router streams its own
socket links to the host over TZSP. Evidence, all 7.26beta5 x86 CHR on a Linux KVM
host, 2026-11-14:

- [wire.json](./evidence/7.26beta5/wire.json): the `wire` study, 3 boots × 8 trials.
- [wire-first-run.json](./evidence/7.26beta5/wire-first-run.json): the same study,
  1 boot × 8 trials. Its capture predates the retransmission fix in `dedupe()`, so
  its SYN counts are too low; every other field is right.
- [demo-probe-sniff.json](./evidence/7.26beta5/demo-probe-sniff.json): the
  four-router demo with `--probe --sniff`, which passed. Two routers sniffed
  `ether2,ether3` at once, and the transit router forwarded the remote's CMR
  session. Both re-arms received traffic: 466 frames on the controller after
  its backup-restore reboot, and 31 on the remote after its restart.

In both `wire` files, `mndpIntervals` was recomputed from the saved rows after
review: one series per router lifetime, split where the header counter restarts.
The first version measured gaps across boots, giving maxima of 84–125 s.

The `wire` study's trials each start from a client the controller has never seen.
The controller's CMR is off. A trial sets the method: `address`
(`controller-addresses=192.0.2.1`) or `discovery` (no address, so the client finds
the controller through MNDP). It enables the controller, waits 0, 5, 30 or 75 s,
enables the client, then runs the single credentialed `pair` that half-pairs.

### MNDP

| Claim | beta5 |
|---|---|
| Announcements follow `/ip/neighbor/discovery-settings discover-interval` | yes: default `30s`. Within one boot no gap exceeded 30.0 s, and the client's median gap was 30.0 s; the controller's is shorter because each CMR enable/disable adds an announcement (lab, `mndpIntervals`) |
| A CMR state change is announced at once, not on the next tick | yes: 7–49 ms after each controller `/cmr set enabled=…`, for all 32 enables and 28 disables in the two `wire` runs (lab). Off-cycle announcements also followed identity and address changes at boot, and the controller announced `02` again after its backup-restore reboot (demo) |
| A CMR controller announces itself in a new TLV 18 | yes: 1 byte, `00` normally, `02` while `/cmr` is enabled, back to `00` when disabled. The neighbor's `/ip/neighbor` row then shows `running=cmr` (lab). Probably a bitmask; no other bit was seen |
| A client's CMR state is in MNDP | no: a client's TLV 18 stayed `00` while enabled, pending, half-paired and paired (lab) |
| Pairing state is in MNDP | no: nothing in either router's announcements changed during pairing (lab) |
| TLV 19 | 1 byte, `79` on every router, CMR or not (lab). It is the entry TTL, `min(discover-interval × 4 + 1, 255)`: `0x79` = 121 for the default 30 s ([m2ir grounding](https://github.com/tikoci/m2ir/blob/d0b13b5e87c75db8be3592de7530c9c0effaade6/work/2026-11-mndp-grounding/FINDINGS.md), in the `routeros-mndp` skill). The same neighbor rows show `system-caps=bridge,router` and `system-caps-enabled=router`, but `discovered-by=lldp,mndp`, so those may come from LLDP |
| Header byte 0 is a per-interface counter | yes: +1 per announcement on that interface; bytes 1–3 were `00 00 00` (lab). m2ir's grounding reads all 4 bytes as one counter in the sender's byte order (little-endian on x86), so byte 0 is its low byte |
| A discovering client connects from its neighbor table | yes: its SYN left 11–35 ms after `enabled=yes`, with no MNDP announcement in between, in all 16 discovery trials (lab). The neighbor row had `running=cmr` each time |
| CMR uses another discovery protocol on the link | no: only MNDP, LLDP, CDP, ARP, ICMPv6 and TCP/54321 in the pair lab; the demo adds OSPF, IGMP and IPv6 multicast listener reports (hop-by-hop header) (lab) |

Raw MNDP payloads are in each report's `wire.mndp[].payloadHex`, whenever an
announcement differs from the sender's previous one.

### First connect: the 85 s

The first trial of each fresh boot is the `address` method with no delay, which is
what `createPairLab()` and the pairing study do. On all 4 boots:

1. About 1 s after `enabled=yes`, the client sent a SYN to `192.0.2.1:54321`
   **from 10.0.2.15**, its user-mode `ether1` address, out of `ether2`.
2. Every quickchr router's user-mode `ether1` is 10.0.2.15, the controller's
   included, so no reply to that address can reach the client. It retransmitted
   at +2, +6, +15, +31 and +64 s.
3. At about 84 s the client gave up and connected again from 192.0.2.2, which
   worked at once. Pending followed within a second (85.4 s in total).

Later trials on the same boot, and the four-router demo, connected from the link
address within 35 ms. The timeout itself is a lab artifact: on a network where the
management address is unique, a SYN from it might reach the controller and be
answered, and the session would run from that address. That case is untested. The lab's `ether1` reset rule cannot catch this SYN,
because it leaves through `ether2`. Why the first connect picks 10.0.2.15 is not
established. In the pair lab, the client is enabled within a second of its
`ether2` address being added. The fleet lab enables clients minutes later.

So the 85 s is a TCP connect timeout behind a source-address choice, not a CMR
retry interval. It is the same trap as the OSPF case in the
[README](./README.md#what-it-does), with a different trigger.

### Discovery method, delay and the half-pair

| Run | Boot | `address` committed | `discovery` committed |
|---|---|---|---|
| first run | 1 | 0/4 | 3/4 |
| wire.json | 1 | 2/4 | 0/4 |
| wire.json | 2 | 1/4 | 0/4 |
| wire.json | 3 | 0/4 | 0/4 |
| **total** | | **3/16** | **3/16** |

Both methods committed 3 of 16, and the delays showed no consistent pattern:
committed trials came at 0, 30 and 75 s. Boot 3 of `wire.json` was a "bad boot"
(0/8). The first run looked like discovery helped; the next 24 trials did not
repeat that. Sixteen trials per method cannot rule out a smaller effect, but
neither variable separated the outcomes here.

### The half-pair on the wire

Every connect is the same exchange: segments of 145, 539, 499 B and so on,
identical across methods. A credentialed `pair` then starts the same way every
time, with a 97 B message from the controller, 88 B from the client and 87 B from
the controller. The **client's** next message matched the outcome in every trial:

| Client's reply | Then | Outcome |
|---|---|---|
| one 108 B segment | controller sends 69 B and 57 B, then nothing | **half-paired**, 26/26 |
| 71 B, then 66 B | controller sends 57 B, 46 B, then about 2 KB (2031 B in every trial); client replies with about 1 KB | **paired**, 6/6 |

Counts are the 24 `wire.json` trials, each with an `exchange` field, plus the
first run's 8, read from their `cmr` segments. This morning's ad hoc capture
matched too. After that:

- A **half-paired** session carries only TCP keepalives (bare ACKs both ways,
  about every 15 s). This is the idle session the pairing claims describe.
- A **paired** session gets a controller message of about 1452 B every 10 s, and
  the client answers with about 5 segments.
- A later bare `/cmr/device/pair` on a half-paired session makes the controller
  send about 1.5 KB at once, and the 10 s polling starts (ad hoc capture).

The payload is not plain text, so what the 108 B message says is unknown, and a
matching message size is a correlation, not a cause. It does show where the two
outcomes first differ on the wire: in a client message, after which the
controller either stops or continues. The single
credentialed `pair` sends the client login to the client while the client is in
`device:password required`. That fits a client-side race between its own
approval and the controller's, but that reading is unproven.

### For other projects

These are the facts to take from this section. Their trackers keep the follow-up
work:

- **m2ir#3 (MNDP grounding):** TLV 18 = `running` (`02` = CMR controller). m2ir's
  own labs since settled TLV 19 (TTL) and the header (32-bit counter). The bytes
  are in `wire.json`, and three captured datagrams are in
  `test/unit/examples-cmr-tzsp.test.ts`.
- **centrs `discover`:** decode TLV 18 as `running`, and keep the raw bytes of TLVs
  it cannot name (today it keeps type and length only). A controller can be found
  by MNDP alone, but MNDP says nothing about pairing. Keep checking the `pair`
  output and `run-script` selection.
- **`routeros-mndp` skill:** done. It has the 30 s `discover-interval`, the
  header counter and TLVs 18 and 19 (tikoci/routeros-skills#60 and tikoci/routeros-skills#70).
- **`routeros-cmr` skill:** discovery uses the neighbor table (`running=cmr`); the
  85 s first connect is a SYN from the wrong source address. The half-pair matched
  the client's fourth pairing message in 32/32 trials, under either discovery
  method (3/16 committed each).
- **A TZSP package:** [README → Wire capture](./README.md#wire-capture) lists what
  `tool/tzsp.ts` covers and what it does not.

## run-script and policy

`/cmr/device/run-script` runs one line on each selected client. The manual
says it runs "with the `read`, `write`, `test`, and `reboot` policies, without
a user session".

### Which controller logins may send a script

| Controller login | beta1 | beta3 | beta4 | beta5 |
|---|---|---|---|---|
| Group without `write` or `reboot` dispatches `run-script` | yes, a write went through (centrs CMR15, [#456](https://github.com/tikoci/centrs/issues/456)) | no: `not enough permissions (9)` over the native API; REST drops the connection (centrs, [#527](https://github.com/tikoci/centrs/issues/527)) | no (centrs) | no: `read`, `read+write` and `read+reboot` groups all get `not enough permissions (9)`; `read+write+reboot` runs it (lab, REST `/execute`) |
| `/cmr/alert/test` needs `write` | — | — | log: "require write policy to run the alert test command" | needs more than `write`: a `read+write` group is refused, and `read+write+reboot` runs it (lab) |
| A `read`-only group can still list `/cmr/device` | yes (centrs) | yes (centrs) | — | yes (lab) |

The refusal arrived with beta3, the first published build after beta1.
[Vendor](https://forum.mikrotik.com/t/7-26beta-development-is-released/273582/139)
placed the fix in beta2, which was never published.

### What a script may do on the client

Policy study, 7.26beta5
([evidence/7.26beta5/policy.json](./evidence/7.26beta5/policy.json)). Each line
was sent with `/cmr/device/run-script` twice: once from the full `admin` login
and once from the smallest login that may send a script (`read,write,reboot,
test,api,rest-api`, no `policy` or `sensitive`). Side effects were read back
over the client's REST API. **Both logins gave identical results.**

| Script line | Manual says | beta5, either login (lab) |
|---|---|---|
| `:put [/system/identity/get name]` | ok | ok |
| `/file/add name=… contents=x` | ok | ok, file created |
| `/system/script/add … policy=read,write,test,reboot,policy,sensitive` | ok, saved as `policy=reboot,read,write,test`, owner `*sys` | ok, owner `*sys`, but **saved with all six requested policies** |
| `/ping … count=1` | ok | ok |
| `/user/add … group=read` | fail, `not enough permissions (9)` | **ok, user created** (centrs: since beta4) |
| `/user/add … group=full` | fail, `not enough permissions (9)` | **ok, full user created** |
| `/user/group/add … policy=read` | fail, `not enough permissions (9)` | **ok, group created** |
| `/ppp/secret/add … password=abc` | ok (sensitive values can be set) | ok |
| `:put [/ppp/secret/get … password]` | shows `*` | **prints `abc`** |
| `:put [/cmr/client/get local-id]` | not documented | full ID (centrs: masked before beta4) |
| `/tool/sniffer/start` | fail, `not enough permissions (9)` | **ok** (side effect not read back) |
| `/system/backup/save … dont-encrypt=yes` | fail, `not enough permissions (9)` | **ok, `.backup` file created** |
| `/export file=…` | `/export` works | **fail, `not enough permissions (9)`** |

What this means:

- **The controller account is the gate.** RouterOS requires `write` and
  `reboot` on the controller login to send a script. A tool should follow
  that (centrs does: it uses the RouterOS policy of the login it was given).
- **On the client, a script is not bounded by the sender's policy**, nor by the
  manual's `read,write,test,reboot`. A sender without `policy` or `sensitive`
  created a `group=full` user and read a secret on the client. In practice, a
  `write`+`reboot` controller login has close to full control of every
  client it can select.
- Only `/export file=` was refused, by either login.

This is candidate report #6 in [SUPPORT-REPORTS.md](./SUPPORT-REPORTS.md):
either the client should apply the documented policies (or the sender's), or
the manual should say what a CMR script may do.

## Export, backup, identity

| Claim | beta1 | beta3 | beta4 | beta5 |
|---|---|---|---|---|
| `/cmr/export` includes the server settings (`/cmr set …`) | no (lab) | log: "fix /cmr configuration missing from the export" | — | yes: `/cmr set` with every value that was set (lab) |
| `/cmr/device/export` exists | no (lab; the demo skips its check there) | log: "fix missing device export command" | — | yes: `add identity= ids= pairing-requirement=` per row; `/cmr/export` includes it (lab) |
| Device labels are exported | no (lab) | — | — | yes: `labels=` on the device `add` line (lab) |
| Binary backup restores controller settings, labels and pairing IDs | yes (lab) | — | — | yes (lab, `--probe`) |
| `/cmr/device/set identity=` renames the client | — | log: "fix device identity changes not syncing with the server" | — | yes, both ways: the controller renames the client, and a client rename updates the row (lab) |
| `/cmr/print` shows only values that were set | — | log (beta4): "fix configuration display not showing effective values for unset fields" | — | `/cmr/print` lists only set values: a fresh controller prints only `enabled: yes`; REST `/cmr` returns the set values plus `local-id` and `self-client-id` (lab) |
| `packages-directory` must exist and end in `/` | yes (lab) | — | — | yes: without the slash, `input does not match any value of packages-directory` (lab) |

## Alerts

| Claim | beta1 | beta3 | beta4 | beta5 |
|---|---|---|---|---|
| The first `interface-change=added` on a device with no interface of that type fires | no: missed on three devices; the second fires (lab) | log: "fix the first interface-change alert not firing" | — | yes, 2/2 runs where the rule already covered the client (`ruleCovered`, `devices=1`). In an earlier run with the rule 5 s old, the first bridge was missed and the second fired, but that run did not confirm the rule covered the client yet. The study now records `ruleCovered` (lab) |
| Log-regex, bridge-added, connected, disconnected-more-than, rebooted alerts and HTTP webhooks | yes (lab) | — | — | yes, `action-failures=0` (lab, [demo-probe.json](./evidence/7.26beta5/demo-probe.json)) |
| `rebooted=no` / `unpaired-device-connected=no` create no condition | — | log | — | — |

## Upgrade rules

| Claim | beta1 | beta3 | beta4 | beta5 |
|---|---|---|---|---|
| A dynamic `default` rule (`channel=stable`) covers unclaimed devices and cannot be edited | yes (lab) | — | — | yes: `failure: can't edit default rule` (lab) |
| On a development build, the default rule offers an older stable as `available-version` | yes: 7.24.5 on 7.26beta1 (lab) | — | — | not seen: no `available-version` within 60 s of pairing; a version check was not awaited (lab). Vendor: intended; manual: "Can be earlier than installed" |
| A labelled rule claims matching devices first | yes (lab) | — | — | yes (lab, [demo-probe.json](./evidence/7.26beta5/demo-probe.json)) |
| A rule pinned to an older version marks devices `U` and fires `upgrade-available` | — | — | — | yes: `channel=7.26beta1` on 7.26beta5 devices gave `available-version=7.26beta1`, `upgrade-available=true`, and the `upgrade-available` rule fired (lab, demo-probe.json). Manual: "a pinned channel can downgrade devices" |

## VLAN, WiFi, application traffic

Not grounded by this lab (CHR has no radios; VLAN provisioning can cut the
lab's own CMR link). Known from elsewhere:

| Claim | Source |
|---|---|
| beta4+: `/cmr/vlan/add` without `port-labels` is refused (`missing =port-labels=`) | centrs CMR17; log (beta4) "fix VLAN rules being applied to all ports when port-labels is not set" |
| An empty or unset port selector can include the uplink | [vendor](https://forum.mikrotik.com/t/7-26beta-development-is-released/273582/188) |
| Server or VLAN-rule disable/enable rebuilds `cmr-bridge` with a new ID | [vendor](https://forum.mikrotik.com/t/7-26beta-development-is-released/273582/232) |
| A later beta will reuse an existing enabled bridge | [vendor](https://forum.mikrotik.com/t/7-26beta-development-is-released/273582/248), announced, not shipped in beta5 |

## Open questions

- What makes one boot half-pair often and another never? Not timing after the
  row appears, not time since boot, not the controller's version check
  (centrs, #527). Unknown.
- Does the half-pair need the client's `password` requirement, or does any
  single command that satisfies both sides at once trigger it? The study only
  covers the beta5 defaults.
- Why does the client's fourth pairing message differ (108 B vs 71 B + 66 B,
  [Wire](#the-half-pair-on-the-wire))? Client-side CMR debug logging around
  the `pair` is the next thing to try.
- Why is a fresh client's first connect sourced from `ether1`'s 10.0.2.15
  ([Wire](#first-connect-the-85-s))? Waiting after adding the link address
  would test the timing guess.
- Push-button pairing, DNS-SRV discovery (`_cmr._tcp`), IPv6, NAT between
  client and controller, arm64 CHR.

## Re-grounding a new build

1. Read the build's `CHANGELOG` for `cmr` lines; add a column note to each
   matching claim as **log**.
2. Run the studies on it, keeping each report:

   ```sh
   v=7.26beta6
   mkdir -p evidence/$v
   bun run cmr.ts --version $v --study pairing --boots 3 --trials 12 --report evidence/$v/pairing.json
   bun run cmr.ts --version $v --study policy --report evidence/$v/policy.json
   bun run cmr.ts --version $v --study recheck --report evidence/$v/recheck.json
   bun run cmr.ts --version $v --study wire --boots 3 --report evidence/$v/wire.json
   bun run cmr.ts --version $v --probe --report evidence/$v/demo-probe.json
   ```

3. Add the build's column here. Change `DEFAULT_VERSION` in
   [`tool/lab.ts`](./tool/lab.ts) once the default demo passes on it.
4. Tell consumers: centrs' lab pin and version splits
   (`test/integration/chr.ts`), and the `routeros-cmr` skill.

A study records; it does not assert. It fails only when the lab breaks. The
default demo and `--probe` do assert, and a beta that breaks them is a finding
to record here before it is a bug to fix in the lab.
