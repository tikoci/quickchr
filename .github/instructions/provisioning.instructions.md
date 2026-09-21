---
applyTo: "src/lib/provision.ts,src/lib/provisioning-window.ts,src/lib/exec.ts,src/lib/qemu.ts,src/lib/license.ts,src/lib/device-mode.ts,src/lib/console.ts,src/lib/guest-snapshot.ts,test/integration/**"
---

# Provisioning & RouterOS Debugging Instructions

## RouterOS "expired admin" is NOT a REST API Blocker

The `expired: true` flag on the admin account only triggers a password-change prompt
at CLI/Winbox/SSH login (bypassable with Ctrl-C). **RouterOS REST API and API sockets
are completely unaffected.** Authenticated requests with `admin:""` succeed on a fresh
CHR image regardless of the expired flag.

Do NOT add workarounds for `expired: true` on REST paths. If early REST responses
return unexpected data, the root cause is a **startup timing race** — not the expired
flag. Identify the actual condition (timing, RouterOS version, specific endpoint) and
fix that specifically.

## The provisioning window closes at first boot — and nothing may drop an option silently

`provision()` and everything `_provisionInstance` calls assume the guest holds
RouterOS' default configuration: the first account, a factory device-mode, a package
set nobody has touched. That assumption is only sound before the guest has booted, so
provisioning runs inside a **window** that closes at first boot — not at `add`. A
machine created with no provisioning flags can still take them on its first `start`.

Two rules, both load-bearing (#176):

- **The gate is `isProvisioningWindowOpen()`** (`src/lib/provisioning-window.ts`), not
  `!state.lastStartedAt`. `lastStartedAt` is stamped right after `spawnQemu`, before
  the guest is known to have booted and before provisioning runs — it answers "has
  QEMU been launched", which is a different question with usually the same answer.
  `clean()` is where they diverge: the disk is factory-fresh again, so the window
  genuinely reopens. The gate therefore reads `state.provisioning` (stamped by
  `_provisionInstance` on success, with the steps that ran) and falls back to
  `lastStartedAt` for machines predating that field.
- **An option outside the window is refused, never dropped.** `start()` used to pass
  `undefined` in place of the caller's provisioning options on every path but a first
  boot, so all seven were discarded in silence: no warning, no error, normal boot
  time, and `--device-mode-enable container` left `container` false. It now throws
  `PROVISIONING_WINDOW_CLOSED` naming each option and where it can still be applied.
  An option that state already records is a no-op instead, so a script passing the
  same flags on every start is not punished for asking for what it already has.

Note what the record does **not** claim: `provisioning.steps` lists what quickchr
applied, not what is in the guest. A step absent from it was not applied *by
quickchr* — weaker than "not present", and deliberately so, since quickchr cannot read
the guest without booting it.

### Which steps may still run after the window has closed

The window is one gate standing in for seven separate judgements, and the judgements
are not the same. Whether a step may run post-boot turns on one question: **does it
unlock a capability, or does it rewrite working config?** A capability the guest did
not have cannot have been used, so turning it on later cannot clobber anything. Config
is the thing that drifts.

| step | post-boot? | why | route |
|---|---|---|---|
| `license` | yes | account-level, orthogonal to config | `quickchr set <name> --license` |
| `deviceMode` | yes | capability flag — it gates whether a feature *can* run and describes nothing about how the guest is configured. Config it was blocking could not have been applied while it was off. | `quickchr set <name> --device-mode…` |
| `packages` | probably | additive, but `installPackage()` has no install-all form | `instance.installPackage()`; #24 for the CLI verb |
| `user` | **no** | additive in principle, but it collides with a user of the same name created since, and a login is exactly the config a post-boot path must not rewrite | `clean()` + replay |
| `disableAdmin` | **no** | depends on another usable login existing — precisely the state that drifts | `clean()` + replay |
| `secureLogin` | **no** | same class as `user`: it creates a login | `clean()` + replay |

`license` is the precedent, not a proposal — it has shipped as a post-boot CLI verb for
some time. `deviceMode` is the second, and the list is meant to stay short: `set` is
not a general "apply provisioning later" verb, and the three refusals above are
refusals on purpose rather than gaps waiting to be filled.

**Preconditions any post-boot provisioning path inherits.** Both fail confusingly when
unchecked, which is why `assertDeviceModeApplicable()` exists:

- **The machine must be running with REST reachable.** `applyDeviceMode()` polls
  `waitForDeviceModeApi` before it does anything, so a stopped machine otherwise spends
  60 s to report a timeout about a guest that was never going to answer.
- **A user-mode NIC is required.** Provisioning reaches the guest over localhost REST;
  `start()` already refuses provisioning on a socket-only machine for that reason, and
  the post-boot path inherits it rather than discovering it as a timeout.
- RouterOS 7.20.8+, as for provisioning generally.

**Device-mode needs the power button, which is why it lives here.** RouterOS will not
apply a device-mode change without a power cycle, and `/system/device-mode/update`
issued from *inside* the guest never returns — it is waiting for a power cycle it
cannot perform on itself. quickchr owns that button; a tool that reaches a router over
the network does not and never will. Whatever the general "apply provisioning later"
story becomes, the part that needs a power cycle can only live in quickchr.

**Satisfaction is a subset test, not equality — because the record is cumulative and
the request is not.** A machine that took `--device-mode-enable container` and later
`--device-mode-disable smb` has a record of all three settings. Comparing the whole
record against a request then refuses the very `--device-mode-enable container` a
script has been passing on every start since before the second change, and names a
`quickchr set` command that is a no-op. `classifyProvisioningRequest()` therefore
checks every setting the request *names* against the record, and ignores the ones it
does not. This loosens what counts as equal, never what counts as applied: a setting
missing from the record, or present with the other value, is still pending, and
`applied.has("deviceMode")` still gates the whole comparison.

**A post-boot step records itself.** `setDeviceMode()` adds `deviceMode` to
`provisioning.steps` (via `recordProvisioningStep`) and folds the applied selection
into `state.deviceMode` rather than overwriting it. Both halves matter: the step record
is what makes a later `start` passing the same device-mode a recognised no-op instead
of a refusal, and the merge is what keeps `machine.json` honest, because a device-mode
update moves only the settings it names — an overwrite left the record claiming an
earlier feature had never been asked for while the guest still had it.

**Device-mode auth differs by caller, and the default is a trap for the post-boot
one.** `waitForDeviceModeApi`, `readDeviceMode` and `startDeviceModeUpdate` default to
`FACTORY_AUTH_HEADER` (`admin:`). That is correct for **first-boot** provisioning and
only there: device-mode is step 2, the user step is step 4, so factory admin is the
only credential that exists yet — and `machineState.user` is *already populated* at
that point with an account nobody has created, so resolving it would 401 the shipped
path. Post-boot the reverse holds: a machine provisioned with `--disable-admin`
answers 401 to factory admin, which is what made `quickchr set <name> --device-mode`
fail on exactly the machines the route was written for (reproduced on CHR 7.24.4).
`applyDeviceMode()` therefore takes the header from its caller instead of deciding:
`_provisionInstance` passes `FACTORY_AUTH_HEADER`, `setDeviceMode()` passes
`resolveAuth(state).header`. Any new post-boot provisioning path inherits the same
question — and `state.user` is not the answer to it until the user step has run.

**A post-boot apply takes `.start-lock`, and re-reads state under it.** `setDeviceMode()` terminates QEMU, spawns a
replacement and rewrites `machine.json` — that is a relaunch, and it holds the same
lock every other relaunch does. Without it a concurrent `start` spawns a second QEMU
into the power-cycle window and both persist over each other. The applicability check
goes *inside* the lock: it has to hold for the operation, not for the instant it was
made. So does a `refreshMachineState()` — a `ChrInstance` closes over one snapshot
taken when the handle was created, and a library consumer can hold that handle across
another process's stop/start. `state.pid` is the sharp end: stale, it is either a
process that has exited (a false `MACHINE_STOPPED`) or one the OS has since reused,
which `hardRebootMachine()` would then terminate.

**RouterOS reports device-mode as strings.** `GET /rest/system/device-mode` answers
`"container": "true"`, not `true`. A reader that tests `value === true` finds nothing
enabled however many are on — which `quickchr get <name> device-mode` did, printing a
bare mode and no feature line at all. Normalize through `isDeviceModeFeatureEnabled()`.

## RouterOS Post-Boot REST Race

`waitForBoot` polls `/rest/system/resource` with a two-consecutive-OK guard and detects
the startup race (brief period where RouterOS returns wrong/array body) for that
endpoint. However, **the race affects ALL non-resource endpoints** — `/system/identity`,
`/system/license`, `/system/device-mode`, and others can also return wrong data briefly
after boot, even after `waitForBoot` returns true.

Each caller must handle this independently. The established pattern:

```typescript
// restGet is the shared node:http + agent:false client — see "Bun Connection Pool" below
import { restGet } from "../../src/lib/rest.ts";

// Retry until the response has the expected keys (up to N seconds)
const deadline = Date.now() + 20_000;
let lastBody = "";
while (Date.now() < deadline) {
    const { status, body } = await restGet(url, auth, 5_000);
    if (status >= 200 && status < 300) {
        lastBody = body;
        const data = JSON.parse(body);
        if (data && typeof data === "object" && !Array.isArray(data) && "expected-key" in data) {
            return data; // Valid — stop polling
        }
    }
    await Bun.sleep(1_000);
}
throw new Error(`Endpoint did not return valid data within 20s (last: ${lastBody})`);
```

Callers that already implement this: `getLicenseInfo` (15s), `readDeviceMode` (30s
AbortSignal), `fetchUntilHasKeys` in anchor test (20s).

## Bun Connection Pool — Use `node:http` + `agent: false`

**Bun's `fetch()` pools TCP connections by `host:port` and ignores `Connection: close`.**
This causes silent stale-response bugs in integration tests and library code.

Symptoms:
- A test passes in isolation but fails in the full suite
- A POST returns immediately (<2ms) with data that looks like a cached GET response
- Different test runs produce inconsistent results on the same machine

Root cause: when one machine is stopped and a new machine is started on the same port
(possible when ports are recycled), Bun's pool may return responses from the prior
machine's connections. Even `Bun.sleep(500)` between calls does not drain the pool.

**The fix: use the shared client in `src/lib/rest.ts`** — `restGet`/`restPost`/
`restPatch`/`restRequest`, all `node:http` with `agent: false` and
`Connection: close`. **Do not hand-roll another one.**

```typescript
import { restGet } from "./rest.ts";                 // library code
import { basicAuth, chrGet } from "./chr-rest.ts";   // integration tests
```

Two clients is worse than one wrong client. Until #69's B10 bite, three
implementations reached CHR — `rest.ts`, Bun `fetch()` in `provisioning.test.ts`,
and a private `nodeGet` copy in `anchor.test.ts` — so every `ECONNRESET` carried
an unanswerable "was that the client or the guest?". The copies are gone; keep
them gone. Note this is confound removal, **not** a proven fix: `test/lab/bun-pool/`
never reproduced the pooling bug on Bun 1.3.11+, and run 30507484030 reset through
`rest.ts` too.

Integration tests go one step further and use `chrGet()` from
`test/integration/chr-rest.ts`, which wraps `restGet` and captures a
post-readiness forensic report when a request throws — see
`testing.instructions.md`.

Existing fixes using this pattern:
- `exec.ts`: `restExecute` (commit `0c0f1b1`) — GET polling precedes the POST
- `device-mode.ts`: `startDeviceModeUpdate` (commit `980ef4b`) — `waitForDeviceModeApi` GET loop pollutes the pool before the blocking POST

**Rule:** any integration test or library function that calls a CHR REST endpoint goes
through `rest.ts`. Do NOT use `fetch()` for CHR REST calls, and do NOT write a second
`node:http` wrapper. `fetch()` remains correct for *external* URLs (`versions.ts`,
`images.ts`, `packages.ts`).

## Collecting RouterOS Logs for Debugging

When debugging provisioning or exec behavior, enable verbose logging on the CHR:

```routeros
# Enable debug-level logging (excluding noisy packet/raw topics)
/system/logging/add topics=debug,!packet,!raw action=memory

# Query logs via REST (or exec):
/log/print where message~"<basic-regex>"
```

Log topics hierarchy: `debug` < `info` < `warning` < `error`. Adding `raw,packet`
produces trace-level output (very verbose). Use `/log/print` with `where` to filter
server-side before returning results.

For packet-level debugging: `/tool/sniffer` with TZSP streaming, or `tcpdump`/`tshark`
on the host side of the QEMU network.

## Reading structured state over the serial console

The serial console **stays reachable while REST is dead** — verified against a
synthetic stuck state (a filter `drop` on tcp/80 makes REST time out exactly as in
#79, and `consoleExec` still logs in and answers). That makes it the transport for
boot forensics (`src/lib/guest-snapshot.ts`). Rules, all measured on 7.21.5/7.23.2:

- **Always `:put [:serialize to=json [ … print as-value]]`.** A bare `print` on
  `/log` or `/ip/firewall/connection/tracking` hits a paging prompt: it blocks
  (~11 s observed) and returns empty. `without-paging` fixes the table form;
  `as-value` is better because it round-trips as JSON.
- **De-wrap before `JSON.parse`.** `:serialize` emits one line, so every newline in
  the reply is a terminal wrap — and a wrap landing inside a string breaks parsing.
  Strip `\r`, then join from the payload's first line. RouterOS repaints the input
  line, so the echoed command appears several times before the payload: search
  candidate starts **last-first** and take the first that parses.
- **Counters need `print stats`.** `/ip/firewall/{filter,mangle} print as-value`
  returns the rule *without* `packets`/`bytes`; only `print stats as-value`
  carries them.
- **`/tool/profile` does not work over serial** — it repaints instead of printing
  and returns empty in both `duration=` and `as-value` forms. Do not re-try it.
- **Credentials depend on how far the boot got.** A machine that timed out before
  provisioning, and any machine after `clean()`, is factory fresh: `admin` with an
  empty password. A provisioned relaunch needs its stored instance credentials.
  `clean()` clears the guest-side credential facts it invalidates — the stored
  instance credentials, `state.user`, `state.managedSshKey`, `state.disableAdmin`,
  and the keypair under `<machineDir>/ssh/` — so credential resolution lands on
  factory admin on its own (#79). Since #176 it also clears the **provisioning gate**
  (`state.provisioning` and `state.lastStartedAt`, recording `cleanedAt` in their
  place), so the retained provisioning *intent* is applied again on the next
  `start()`. Budget for it: a cleaned machine's next start re-provisions and costs
  what a first boot costs, not what a bare restart costs.

### A serial login costs ~11 s — budget it separately from the command

Every budget over the serial console has two parts, and they differ by ~40×.
Measured 2026-07-31 on 7.23.2 / x86 / HVF with a raw socket and timestamped
receives (#69, bite B10 of #110):

| phase | cost |
|---|---|
| banner → `Login:` | 10–25 ms |
| username → `Password:` | 54–56 ms |
| password → license `[Y/n]:` | **10,184 ms** |
| whole fresh `consoleExec()` | 11,364 / 11,360 ms |
| `consoleExec()` on an already-open session | 306 ms |

RouterOS is not slow to *answer* — it answers the banner in 10 ms. It is slow to
**complete a login**, and the whole cost sits in one phase after the password is
accepted. Note this is 7.23.2 on hardware acceleration; TCG and cross-arch guests
are slower still.

Consequences, both of which were live bugs:

- **Never size a console budget from the round-trip figure.** The ~0.3 s number is
  what a command costs on a session that is *already* logged in. `src/lib/console.ts`
  exports `CONSOLE_LOGIN_COST_MS` for the other case; budget from that.
- **Never divide a budget across credential candidates without that floor.** An
  executor that tries stored credentials → factory `admin` → `state.user` used to
  split its 15 s query budget three ways, so no attempt could finish a login. It
  therefore never marked a credential working, repeated the same split on every
  later query, and spent the entire 60 s snapshot budget to report
  `consoleReachable: false` about a guest answering serial in 10 ms. Queries now
  carry a `GUEST_LOGIN_ALLOWANCE_MS` on top of the command budget until one of
  them answers, and the per-candidate floor is `CONSOLE_LOGIN_COST_MS`.

### Where a console reply ends — use the sentinel, not the prompt

A prompt is **not** a reliable end-of-reply marker. RouterOS repaints
prompt+command *before* emitting output, so "a prompt appeared and the buffer went
quiet" fires on the redraw whenever the guest pauses before the payload. That is
#109: on a loaded 1-vCPU TCG guest the two largest guest-snapshot queries returned
`empty console reply` while every small one succeeded, blanking the field #79
needed. `consoleExec` therefore frames each reply with a sentinel.

Measured on 7.21.5 (x86/HVF, QEMU 11.0.3):

- **Build the marker in the guest.** `:put ("QCHR" . "<nonce>" . "END")` prints
  `QCHR<nonce>END`, while the echoed line only ever shows the split expression. A
  marker passed as one literal would match its own echo.
- **Send the sentinel as its own `\r`-terminated line, never `;`-chained.** A `;`
  chain aborts at the first failure and never runs the rest — confirmed for both a
  syntax error (`/bogus/nope print; :put (…)`) and a runtime one
  (`/ip/address add address=nonsense; :put (…)`). Chaining would lose the
  terminator on exactly the replies that carry an error message. Two `\r`-
  terminated lines are two separate console inputs and both run.
- **The echo is one physical line**, redrawn with bare `\r` and terminated by
  `\r\n`. A **long** command is scrolled horizontally rather than wrapped
  (`<ss=nonsense; :put (…`), so its opening characters are absent from the redraw —
  do not identify the echo by matching command text.
- **The prompt redraw shares a line with the next command's echo**, so dropping
  lines that carry the sentinel nonce removes the trailing prompt with it.
- **Fallback rule:** if a command changes console state and swallows the sentinel
  line, fall back to a prompt that is *trailing* (nothing but whitespace/ANSI after
  it) **and** stable. Trailing alone already rejects a redraw, since a redraw is
  always followed by repainted command text.
- **Report framing.** `consoleExec` returns `framed`; an empty reply that was
  framed means RouterOS printed nothing, an unframed one means the reader could not
  delimit it. Do not collapse those into one message.

### Counting packet arrivals inside the guest

To ask "did the guest receive these packets at all", use a mangle counter, not a
filter rule:

```routeros
/ip/firewall/mangle add chain=prerouting protocol=tcp dst-port=80 action=passthrough comment="quickchr-boot-diagnostic"
/ip/firewall/mangle print stats as-value where comment="quickchr-boot-diagnostic"
```

- `passthrough` is non-terminating and prerouting runs before the filter chains, so
  it counts arrivals whatever else is installed — measured: 10/10 SYNs counted that
  a filter `drop` on the same port then killed.
- A filter `accept` appended after an existing `drop` counts **zero** and reports
  the guest as unreachable when it is receiving everything.
- `place-before=0` is not the workaround: on the empty chain of a fresh CHR it
  fails with `no such item`.
- Read the delta as a boolean. slirp retransmits a SYN the guest never answers, so
  one probe can move the counter several times.
- **Only the post-probe reading is load-bearing.** The rule is created moments
  earlier, so its counter necessarily starts at 0 — an unreadable pre-probe reading
  must not throw the verdict away. #109 hit exactly that: a report carried
  `packetsAfter: 2` and still said "inconclusive".
- **Conntrack cannot answer this question.** RouterOS ships `enabled=auto`, so
  tracking is off while no filter/NAT/mangle rule exists — a fresh CHR reports
  `active-ipv4: false` and zero connections after healthy probes. Even with
  tracking forced on, a dropped packet leaves no entry: conntrack records what was
  accepted, never what was dropped.
- A newly added filter rule takes a moment to affect new connections — a REST call
  issued immediately after the `add` still succeeded, the next one (2 s later)
  hung. Wait for the effect rather than assuming it is instant.

## Timeout Rules

Boot and response times vary significantly by acceleration mode and host hardware.
**Do not rely on specific timing estimates** — they become stale and cause cascading failures when reused uncritically.

Key principles when implementing timeouts:
- **Per-probe HTTP timeout is the critical factor.** Under cross-arch TCG, a single HTTP round-trip through the emulated TCP stack can take many seconds. A 3-second curl timeout (`curl -m 3`) will time out on every probe even when CHR is fully booted.
- Native KVM/HVF (same-arch) is much faster than cross-arch TCG — but do not assume specific numbers.
- Cross-arch TCG (guest arch ≠ host arch) is the slowest scenario; plan for it but measure rather than guess.
- Provide a `--timeout-extra=<seconds>` CLI option that **adds** time (not replaces).
- Consider `detectAccel()` result to adjust retry behavior.
- Document the accel mode in timeout error messages so users know why it was slow.


## Provisioning Failure Modes

Before coding fixes to provisioning edge cases, **test locally** to understand the
actual behavior. Provisioning should be "transactional" — you either get the machine
you wanted, or you don't. Partial failures with "warnings" are errors.

Testing approach for failure modes:
1. Use `/system/logging` + `/log/print` to see what RouterOS actually does
2. Use QEMU monitor (`info status`, `info chardev`) to verify VM state
3. Test each provisioning step individually before changing the orchestration
4. Consider re-trying the entire create process as a last resort over partial recovery

## SSH Key Provisioning

For `exec --via=ssh` to work securely without passwords:
- The `quickchr` managed user path should include SSH key generation
- Store keys in the machine directory alongside other state (`<machineDir>/ssh/id_ed25519`)
- Install the public key on the CHR during provisioning
- This makes SSH work even if the password is later changed
- Important: SSH key auth means `exec` always has a reliable path to the CHR

**Algorithm: `ed25519`** — grounded as accepted by `/user/ssh-keys/add|import` from
RouterOS **7.12** onward, and login-verified on quickchr's provisioning floor (7.20.8)
and current stable (issue #74; evidence in `test/lab/ssh-keys/REPORT.md`). RSA-2048 is
the only fallback for sub-7.12 devices, which quickchr never provisions (floor 7.20.8),
so quickchr defaults `ed25519` outright. ECDSA is rejected by RouterOS.

**Verified, persisted fact (`installSshKey` → `MachineState.managedSshKey`).** Presence in
RouterOS's `/user/ssh-keys` listing is necessary but not sufficient — `installSshKey`
follows it with a real host-OpenSSH batch login (`BatchMode=yes`,
`PasswordAuthentication=no`, `IdentitiesOnly=yes`, `-F <empty config file>`) and records
`{ privateKeyPath, algorithm, batchVerified }` on `MachineState` (persisted to
`machine.json`). The REST listing check must match the generated key's comment
(`info ?? key-owner`) and fingerprint when available, not only the user, so stale keys
cannot stand in for the managed key; normalize optional trailing base64 padding in the
RouterOS fingerprint. The batch login is **best-effort** — a failed probe records
`batchVerified: false`, logs the ssh client's actual diagnostic, and never aborts
provisioning. This is the data source the #71 descriptor consumes: advertise SSH
private-key batch auth as usable **only when `batchVerified` is true**.

**`-F` needs a real file, not the null device.** `ensureEmptySshConfig()` writes a
genuinely empty file and passes its path to `-F` to suppress `ssh_config`
(so agent/config identities can't produce a false-positive `batchVerified`, per
#83). `-F <SSH_NULL_DEVICE>` looked equivalent and passed on Linux/macOS, but
Win32-OpenSSH's config-file loader doesn't special-case `NUL` and fails to open
it (`Can't open user config file NUL: No such file or directory`, exit 255) —
grounded on `windows-latest` CI, issue #87. `SSH_NULL_DEVICE` is still correct
for `UserKnownHostsFile`, which is a different code path.

**Cold listing latency under TCG.** The first `/rest/user/ssh-keys` GET on a fresh
Linux/arm64 TCG CHR took 5.2–17.8s across 15 CI artifacts (median 7.6s); local
arm64/TCG reproduced a 5s timeout followed by a 200 response containing the exact key.
`installSshKey` therefore gives the listing check one 30s convergence budget and lets
each request use the full remaining budget. Do not restore a shorter per-request cap:
repeatedly aborting the cold request recreates the false install failure.

## `createUser()` resolves on authentication, not on visibility

`createUser()` waits for two separate facts, in order:

1. the record is visible in `/rest/user` (polled as `admin`, with the group checked);
2. the new credentials are **accepted** — `waitForAuth()` polls `/rest/system/resource`
   with that user's own basic auth until it returns 2xx, and reports
   `{ attempts, elapsedMs }`.

Only the second is what callers rely on, so it is the one the function promises.
Do not "simplify" this back to the visibility check: the second wait is a no-op
whenever the guest is healthy, and the whole point is the case where it is not.

`waitForAuth()` is deliberately the inverse of `waitForBoot()`, which counts
401/403 as **ready** — correct for a liveness probe, where an auth rejection
still proves `www` is answering, and wrong here, where the 401 is the thing
being waited out. Keep both; they answer different questions.

### Only the `full` group is REST-verifiable — authentication vs authorization

The gate runs for `full` and is skipped for every other group, because outside
`full` a 2xx answer is not something a correctly created user can be expected to
produce. RouterOS treats `rest-api`, `read` and `web` as independent policies,
and a valid user in a limited group fails the probe permanently.

Measured on CHR 7.24.4 — one user per group, `GET /rest/system/resource` as that
user:

| group policy | result |
|---|---|
| `local,ssh,winbox,read` (no `rest-api`) | **401 Unauthorized** |
| `local,ssh,winbox,rest-api,write` (no `read`) | **500** `std failure: not allowed (9)` |
| `local,winbox,rest-api,read` (no `web`) | **500** `std failure: not allowed (9)` |
| default `read` / `write` / `full` | 200 |

Two consequences, both load-bearing:

- **The 401 is byte-identical to #69's symptom.** No amount of polling can
  distinguish an unauthorized user from a credential that has not propagated, so the gate
  cannot be made "smart" about it — it has to not run.
- **The 500 is permanent, and `waitForAuth()` polls through 5xx** (correct for
  the post-boot race documented above, wrong here). A gated limited user would
  burn the full budget and then fail as "not authenticating" despite having been
  created correctly.

`provision()` only ever creates `full`, so this costs nothing on the shipped
path. Note `rest-api` alone is not sufficient — the third row has both
`rest-api` and `read` and still fails; `web` appears to be required as well,
which is why the rule is "the `full` group" rather than a policy checklist.

### This is hardening and an instrument, not a proven fix for #69

The symptom is a 401 on the first request made with freshly created credentials:
four Windows legs across runs 35135008624 and 35386692051, always on the path
that passes an explicit `user:` and therefore does nothing between
`createUser()` returning and that request. The tests that happen to insert work
in that position — `disableAdmin: true`, whose lookup loop retries for up to
15 s, and the `secureLogin` path, with its `Bun.sleep(1000)` and SSH key
install — stayed green on the same legs in the same runs.

**That correlation is not evidence of a timing window, and a local attempt to
find one failed.** On an Intel host against CHR 7.24.4 (x86 guest), a freshly
added user was accepted on **attempt #1, 6/6**, under both TCG and HVF. There
was no window to lose. Whatever produces the Windows 401 is still unidentified;
`waitForAuth()` closes it if it is a timing window and produces a labelled
failure if it is not, which is strictly better than the bare 401 either way.

### Measuring this: count attempts, never elapsed time

An earlier version of this investigation reported a "250–400 ms propagation
window" on both accelerators, 8/8. It was an artifact of the measurement:

- two pollers (record-visible as `admin`, auth-accepted as the new user) ran
  **concurrently** against one emulated guest and slowed each other down;
- each recorded `Date.now()` **after** its request returned, so a first request
  that succeeded but took 350 ms was recorded as a 350 ms wait.

Re-measured sequentially and by attempt count, the "window" disappeared: one
attempt, always. The ~250 ms (HVF) / ~350 ms (TCG) figure is simply what a first
authentication with a new password costs on an emulated guest — request latency,
which scales with the accelerator exactly as observed, and which no amount of
waiting reduces.

**Rule: an attempt count cannot be inflated by request latency; an elapsed-time
figure can.** On an emulated guest, where a single round-trip can cost hundreds
of milliseconds, report attempts and treat any latency-derived "delay" as
suspect until a sequential re-measurement confirms it.

`waitForAuth()` returns `{ attempts, elapsedMs }` for exactly this reason, and
`attempts` is the load-bearing half. Running the provisioning suite with
`QUICKCHR_DEBUG=1` prints one line per created user; a full local pass recorded
`1 attempt(s)` for all 7 with elapsed figures from 7 ms to 690 ms. Those
hundreds of milliseconds are what a first authentication costs, not a wait —
which is precisely why an elapsed-only reading of the same run looked like a
600–900 ms propagation window and was not one. **Read the attempt count.**
