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
| 7.26beta5 | 2026-10-30 | **Lab default.** Studies below: [evidence/7.26beta5/](./evidence/7.26beta5/). |

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
| One credentialed `/cmr/device/pair … username= password=` (the manual's path for server `confirm` + client `password`) can end **half-paired** | no: `state` cleared on first pair (centrs) | yes (centrs, #527) | yes (centrs) | yes: 7/9 trials on three boots (lab); 0–100% per boot (centrs). See [the pairing study](#pairing-study-726beta5) |
| The half-paired `pair` command still prints success | — | — | — | yes: its last table ends `device:ok, cmr:ok`, not `paired` (lab, centrs) |
| A half-paired session is idle | — | — | — | yes: a client tcp-reset rule saw 0 packets in 60 s, so it never disconnects (lab) |
| A half-paired pairing is not committed | — | — | — | yes: after a controller CMR restart the row is `pending`, `state="pair: device:ok, cmr:waiting confirmation"` (lab, centrs) |
| A bare `/cmr/device/pair` finishes a half-paired client | — | yes (centrs) | yes (centrs) | yes, before or after the restart (lab, centrs) |
| Committing the controller's approval first (bare `pair`, then credentialed) avoids the half-pair | works: 3/3 clients paired, demo passed ([demo-2026-11-12.json](./evidence/7.26beta1/demo-2026-11-12.json)); centrs suite passed | — | — | yes, 9/9 committed (lab); centrs 3/3 |
| A client-side `/cmr/client/pair`, then a bare controller `pair`, avoids it | — | — | — | yes, 9/9 (lab); centrs 7/7 |
| Client `pairing-requirement=none`, then a bare controller `pair`, avoids it | — | — | — | yes, 9/9 (lab); centrs 3/3 |
| Client `pairing-requirement=confirm` accepted | no: syntax error at column 37 (lab) | — | — | **yes**: accepted, and the paired client drops to `waiting-for-pairing` with `device:waiting confirmation` until approved locally (lab). Vendor said it was [frozen before release](https://forum.mikrotik.com/t/claude-and-codex-try-out-cmr-in-7-26beta-mostly-successful/273613/4) |
| Client `enabled=no`, `enabled=yes` clears the pairing | yes (lab) | — | — | yes: client `device:password required`, row kept with `remote-pending` (lab). Vendor: intended. The manual says enabling again "reconnects the client with its existing pairing" |
| Clean reboot, power-off or controller reboot keeps the pairing | yes (lab) | — | — | power-off of the remote and a backup-load reboot of the controller: yes, no re-pairing (lab, `--probe`) |
| In the six-combination matrix (client none/password × device none/password/confirm), only client `password` + device `confirm` half-pairs | — | — | — | yes: the same credentialed command against device `none` paired cleanly (1 run each, lab `--probe`) |
| Changing a paired client's `pairing-requirement` makes it pair again | — | — | — | yes: `confirm`, and unsetting back to the default, each left the client pending (lab) |
| A fresh client's first connect can take over a minute | — | — | — | yes: 85 s from `enabled=yes` to pending on each of 7 boots; about 1 s after a later `forget` (lab) |

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
  restored the pairing (7/7). The study did not restart again to prove the
  repaired pairing was committed; centrs saw one survive a second reconnect.
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

### Recheck of the beta1 findings (7.26beta5)

`bun run cmr.ts --study recheck` on a pair lab whose client has no bridges
([evidence/7.26beta5/recheck.json](./evidence/7.26beta5/recheck.json); the
5 s-rule run is [recheck-rule-5s.json](./evidence/7.26beta5/recheck-rule-5s.json)).
Results are in the claim tables: client `confirm` and disable/enable above,
export and identity below, the first-interface alert and the default upgrade
rule further down. Of the four beta1 reports, export is fixed and client
`confirm` now works. The first-bridge alert fired once the rule was not new.
Disable/enable still clears the pairing.

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
| The first `interface-change=added` on a device with no interface of that type fires | no: missed on three devices; the second fires (lab) | log: "fix the first interface-change alert not firing" | — | yes when the rule was ~35 s old (1/1). With a rule 5 s old, the first bridge was missed and the second fired (1/1). New rules may have a startup window; not narrowed (lab) |
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
- Is the 85 s first connect a fixed retry interval after the client's first
  attempt fails, or something in the lab? It was identical on every boot.
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
   bun run cmr.ts --version $v --probe --report evidence/$v/demo-probe.json
   ```

3. Add the build's column here. Change `DEFAULT_VERSION` in
   [`tool/lab.ts`](./tool/lab.ts) once the default demo passes on it.
4. Tell consumers: centrs' lab pin and version splits
   (`test/integration/chr.ts`), and the `routeros-cmr` skill.

A study records; it does not assert. It fails only when the lab breaks. The
default demo and `--probe` do assert, and a beta that breaks them is a finding
to record here before it is a bug to fix in the lab.
