# quickchr Design

> Architecture and rationale. For the user-facing reference (every CLI
> command, every library API, provisioning, channels, networking, errors)
> see **[MANUAL.md](./MANUAL.md)**.

## Architecture

quickchr is a TypeScript/Bun CLI + importable library to manage MikroTik CHR virtual machines via QEMU.

### Layers

```text
CLI (src/cli/)          ← Arg parsing, wizard, formatting
    ↓
Library API (src/lib/quickchr.ts)  ← QuickCHR class, ChrInstance
    ↓
Modules (src/lib/)      ← qemu, images, versions, network, state, ...
```

- **CLI** — git-style subcommands + interactive wizard. Thin layer over the library.
- **Library** — `QuickCHR` class with static methods: `start()`, `add()`, `list()`, `get()`, `doctor()`. Returns `ChrInstance` handles with `stop()`, `remove()`, `rest()`, `exec()`, `monitor()`, etc.
- **Modules** — Pure functions for QEMU arg building, image download, port allocation, state persistence.

### Key Design Decisions

1. **JSON state, not SQLite** — Portable to Windows without native deps. Each machine gets a `machine.json` file in `~/.local/share/quickchr/machines/<name>/`.

2. **Port block allocation** — 10 ports per instance (base + 0-9). Default starts at 9100. Avoids conflicts by scanning existing machines and probe-binding.

3. **No shell scripts** — QEMU args built entirely in TypeScript. Enables Windows support and testability.

4. **Optional qcow2** — Default boot disk uses raw `.img` (MikroTik provides them). Users can opt into `qcow2` format for boot resize and QEMU snapshot/restore support. Requires `qemu-img` when enabled.

5. **ARM64 VirtIO rule** — Never use `if=virtio` on aarch64 `virt` machine. Always explicit `-device virtio-blk-pci,drive=drive0`.

6. **Class-based API** — `QuickCHR` is a class with static methods for clean namespacing. `ChrInstance` is an interface implemented as a plain object with closures.

7. **Running-only connection descriptors** — `ChrInstance.descriptor()`, `quickchr inspect`, and `quickchr env` are live connection handoff surfaces, not stale state readers. They intentionally fail with `MACHINE_STOPPED` when the VM is not running, because ports/auth/status are only safe to consume when the machine is active. Descriptor/env output includes auth material by design for subprocess handoff; callers must treat it as credential-bearing output.

8. **Boot respawn-once on hardware accel** — When `QuickCHR.start()` boots a fresh machine in background mode and `waitForBoot` exhausts its budget under `kvm`/`hvf`, it stops the QEMU process, clears its `server=on` socket files, and respawns **once** before raising `BOOT_TIMEOUT` (see `start()` in `src/lib/quickchr.ts`, gated on `accel`). This targets an observed CI flake: on GitHub's nested-KVM runner a single boot among many occasionally never reaches REST while siblings boot in ~30-45s — a *wedged* process that a longer timeout would not rescue, only a fresh one. Gated to hardware accel because TCG boots are legitimately long and doubling buys nothing.

   ⚠️ **Watch-item / scope caveat.** The root cause is **unconfirmed** — the respawn is a pragmatic mitigation that keeps CI green, not a proven diagnosis; the trigger could be something else (runner CPU-steal, a SLiRP stall, image-specific timing). Two deliberate limits to revisit if it recurs:
   - **Not applied to `_launchExisting`** (the restart-existing-machine path) — that path also spawns + `waitForBoot`s but has never been observed to flake. Extend the same respawn there only with evidence.
   - **Timeout factor left at 1.5×** (`accelTimeoutFactor`, `src/lib/platform.ts`) rather than inflated further — the respawn is the recovery mechanism, not a bigger ceiling.

   How to tell it's firing: grep CI `qemu.log`/run logs for `respawning QEMU once`. A frequent occurrence, or a `BOOT_TIMEOUT` that *survives* the respawn (or appears on the `_launchExisting` path), is the signal to stop treating it as a flake and find the real cause. Tracked as a watch-item in [#45](https://github.com/tikoci/quickchr/issues/45).

9. **Resilient downloads: normal `fetch` first, public-DNS IPv4 as a failback** — All fetches to MikroTik's `upgrade`/`download` hosts go through `fetchResilient()` (`src/lib/net.ts`), never bare `fetch()`. The intent is narrow: a **plain `fetch` is the path** — dual-stack (happy eyeballs), on par with curl/most tools, and honoring local DNS (`/etc/hosts` pins, VPN/split-horizon, mirror redirects, IPv6-only egress) — and we layer one **failback** beneath it to ride out *DNS misconfiguration somewhere in the environment*, wherever it comes from. We deliberately do **not** invert this (public-DNS+IPv4 first) — that would override local DNS on every machine and could introduce its own failures (e.g. an IPv4-only connect on an IPv6-only network). Normal first keeps us on par with most tools; the failback only adds smarts when the normal path actually breaks.

   The trigger is precise: only when the normal `fetch` throws a **connection-class error** (`isConnectionFailure()` — the `ConnectionRefused`/`FailedToOpenSocket`/`ECONNREFUSED`-family codes, or a `TypeError` carrying Bun's `errno: 0` connect-failure marker; *not* aborts or any HTTP response) does `fetchResilient` retry. It resolves the A record by querying public DNS **directly** (a `dns.Resolver` with `setServers([1.1.1.1, 8.8.8.8, 1.0.0.1])`, bounded by a 3 s timeout so a blocked resolver doesn't stall), then connects to the IPv4 literal preserving the `Host` header and TLS SNI so certificate validation still passes. If public DNS also has no answer it surfaces the original failure. HTTP responses (incl. 5xx) and aborts (`AbortError`, e.g. from `AbortSignal.timeout`) pass through unchanged, never retried; a `TypeError` retries only with Bun's `errno: 0` connect-failure marker, so an unrelated `TypeError` (a real bug) surfaces immediately.

   *Motivating incident (don't over-fit to it):* the failback was prompted by GitHub-hosted runners whose system resolver returned `ESERVFAIL` for `*.mikrotik.com` — slowly (2–26 s) — via *both* `getaddrinfo` and c-ares-over-`resolv.conf`, so a plain `fetch` either timed out resolving or (when the stub handed back only the unreachable AAAA) failed with Bun's `errno: 0` `ConnectionRefused` / `FailedToOpenSocket`; a direct public-resolver query answered in ~10 ms. That was one observed symptom of a broken resolver, and its deeper root cause is still unknown — so the design is framed as *generic resilience to a misconfigured/transient resolver*, not a CI-specific patch. The earlier "IPv6 happy-eyeballs" theory was a red herring (the symptom was DNS, not IPv6 egress). On-runner probe (2026-06-16): `lookup({family:4})` → `ESERVFAIL` ~9 s; `lookup({all})` → `ESERVFAIL`/`ETIMEOUT` 22–26 s; `resolve4` (resolv.conf) → `ESERVFAIL` 2–22 s; `Resolver([1.1.1.1,8.8.8.8]).resolve4` → OK ~10 ms.

   **Sister-project routing.** Because `fetchResilient` already absorbs a flaky resolver, a download/version-resolve failure should not be papered over downstream with `/etc/hosts` pins or IPv6 toggles in a consuming repo's workflow — fix it (or extend the failback) here in quickchr. The historical `getent ahostsv4` `/etc/hosts` workaround was both in the wrong layer and non-functional (it hit the same broken stub resolver, returning empty). The failback is best-effort, not a guarantee: it recovers connection-class DNS failures, not arbitrary network breakage. Covered by `test/unit/net.test.ts`.

## Port Layout

| Offset | Service    | Guest Port |
|--------|------------|------------|
| +0     | HTTP/REST  | 80         |
| +1     | HTTPS      | 443        |
| +2     | SSH        | 22         |
| +3     | API        | 8728       |
| +4     | API-SSL    | 8729       |
| +5     | WinBox     | 8291       |
| +6—9   | Custom     | —          |

On Windows, the monitor/serial/QGA channels use TCP localhost at `portBase+6/+7/+8` (Winsock can't bind `\\.\pipe\` paths), so the `+6..+8` "Custom" slots are effectively reserved there.

### Allocation rationale & open questions

Ports are assigned in fixed 10-port blocks from `DEFAULT_PORT_BASE` (9100), scanning existing machines and probe-binding to avoid collisions. Two rough edges are **maintainer decisions, not yet settled** — don't "fix" them unilaterally, since they change the persisted-state / port contract (tracked as `needs-decision` work):

1. **Base 9100 is a poor default** — collides with JetDirect/PDL (printers) and trains agents to memorize "quickchr = 9100 for REST", which only holds for the *first* instance (the second gets 9110). Open: random base in a clean high range (persisted per machine) vs caller-requested range vs both; and whether that's a breaking change or a setting with 9100 as the default. → [#56](https://github.com/tikoci/quickchr/issues/56)
2. **Fixed blocks are overfit** — extras bolt on at `+6..+9` and collide with the Windows IPC offsets above (one slot before spilling); manual `extraPorts` bypass collision checking. Open: dynamic variable-size blocks vs a fixed core pool + a separate extras pool. → [#57](https://github.com/tikoci/quickchr/issues/57)

Current consumers are all first-party tikoci projects (centrs, donny, restraml), so a port-scheme migration can be coordinated across them — but `@tikoci/quickchr` is published and public, so a change to the persisted port contract still needs an issue, a CHANGELOG/docs note, and (for the `ChrInstance`/`StartOptions` surface) a deprecation/migration path, not a silent break.

## Storage Layout

```text
~/.local/share/quickchr/
├── cache/                     # Downloaded images
│   ├── chr-7.22.1.img.zip
│   ├── chr-7.22.1.img
│   └── ...
├── machines/
│   └── 7.22.1-arm64-1/
│       ├── machine.json       # Config + state
│       ├── disk.img           # Working copy
│       ├── efi-vars.qcow2     # UEFI vars (arm64; qcow2 so savevm works — #31)
│       ├── monitor.sock       # QEMU monitor
│       ├── serial.sock        # Serial console
│       ├── qga.sock           # QGA (x86 only)
│       ├── qemu.pid           # PID file
│       └── qemu.log           # Output log
```

**Global settings** live separately, under the XDG **config** tier (not the data tree
above): `~/.config/quickchr/quickchr.env`, dotenv-style (`QUICKCHR_KEY=value` lines).
Managed via `quickchr settings get|set|print|reset`. Precedence per key: CLI flag >
`QUICKCHR_<KEY>` env var > `quickchr.env` > built-in default. The 5 managed keys:
`default-channel`, `default-arch`, `cache-max-size`, `timeout-extra`, `secure-login`.
See MANUAL.md's CLI reference and environment-variables sections for the full surface.

## Platform Support

| Platform               | x86 CHR | arm64 CHR | Notes |
|------------------------|---------|-----------|-------|
| macOS x86_64           | HVF     | TCG       | Intel Mac |
| macOS arm64 (native)   | HVF     | HVF       | Apple Silicon, bun is arm64 |
| macOS arm64 (Rosetta)  | HVF     | TCG       | bun is x86_64; arm64 HVF skipped |
| Linux x86_64           | KVM     | TCG       | KVM requires `/dev/kvm` writable |
| Linux aarch64          | TCG     | KVM       | x86 TCG on arm64 Linux |
| Windows x86_64         | TCG     | TCG       | HVF/KVM not available |

**Acceleration detection** (`detectAccel`):
- macOS: checks `kern.hv_support` via sysctl; for arm64 guest additionally checks `process.arch === "arm64"` (native bun = Apple Silicon).
- Linux: checks `/dev/kvm` writability.
- Falling back to TCG is always safe, just slower (~20s x86 TCG boot on Apple Silicon; ~2 min arm64 TCG on Intel).

## CI System

**Workflows**: `.github/workflows/{ci,main,sweep,integration,release,ros-versions,lint-powershell}.yml`.
Full artifact map, dispatch recipes, and failure-diagnosis guide live in
`.github/instructions/ci.instructions.md` — this section is the high-level rationale only.

**The 2026-07 refactor (#29)** replaced the organically-grown scheme (integration on every
PR push, three parallel copies of the runner logic, `continue-on-error` green-washing)
with a layered design:

- **`ci.yml`** — fast PR/push gate (~3-5 min, no QEMU): lint ∥ unit+coverage ∥ Windows
  unit ∥ `Integration freshness` (PR-only, required). Integration left the PR path
  because a 25-minute CHR suite per PR push bought little signal per minute; the quality
  bar moved to main.
- **`main.yml`** — full integration suite + examples smoke (+ PowerShell lint) on
  linux/x86_64 + linux/aarch64 (KVM) on every push to `main`; examples are part of the
  default flow, not a weekly extra. The **freshness gate** (`scripts/ci-freshness.ts`) makes this honest:
  PRs merge only while the latest completed main run is green, so a red main visibly
  blocks everything instead of rotting in the Actions list. Superseded push runs cancel;
  cancelled runs carry no signal (the gate skips them).
- **`sweep.yml`** — weekly all-platform sweep (+ examples smoke). A separate file from
  main.yml *by design*: its TCG legs (macos-x86, windows-x86 — bounded to the anchor
  smoke subset via `tcg-smoke: true` to cap weekly cost) may red without blocking PRs,
  but are never green-washed — red is red. On manual `integration.yml` dispatches TCG
  legs run the FULL suite by default (`tcg-smoke` defaults off): `platforms=all` means
  all platforms, full set — smoke is opt-in, never an implicit narrowing.
- **`integration.yml`** — the single reusable integration unit (`workflow_call` +
  `workflow_dispatch`). A plan job resolves **`platforms` × `routeros-targets`** (both
  comma lists; `gating`/`all` platform aliases) into one cross-OS matrix — one dispatch
  can cover e.g. gating platforms × three RouterOS versions, no wrapper jobs or repeat
  dispatches. `test-filter` narrows; `run-examples` defaults ON. Each runner boots its
  native CHR arch — `detectAccel()` picks KVM/HVF/TCG. Agents dispatch this to ground
  platform hypotheses without waiting for a PR cycle.
- **`release.yml`** — one-click release: freshness gate (no suite re-run — main is kept
  continuously release-able) + non-empty CHANGELOG `[Unreleased]` →
  `scripts/release-prep.ts` bump/rollover → tag + GitHub Release + `npm publish
  --provenance` (odd minor → `next`, even → `latest`).
- **`ros-versions.yml`** — daily: new RouterOS versions (per channel) with no linux-x86
  record in `ci-data/tested-versions.json` ride the `routeros-targets` matrix of a
  single integration dispatch.

**Metrics as byproduct (#30)**: the library appends every successful boot to
`<dataDir>/boot-log.ndjson` (and stamps `lastAccel`/`lastBootMs` into machine.json);
integration jobs assemble that + per-file timing into `metrics.ndjson`
(`scripts/ci-metrics.ts`); collect-metrics callers push per-run files + the
`tested-versions.json` rollup to the orphan **`ci-data`** branch. Never a second test
run; never affects pass/fail — the aggregate job is best-effort by contract (fold/push
failures warn and stay green, because a red there would trip the PR freshness gate over
side-band data). A full run marks exactly **its target's resolved version** tested —
never every version it happened to boot (upgrade/pinned-channel tests boot others
incidentally; crediting those suppressed the scheduler for versions no full suite ever
targeted). The per-run files are the source of truth; `ci-metrics refold` rebuilds the
rollup after fold-logic changes.

**Merge policy**: squash-only, PR title → main commit subject (write PR titles as
conventional commits), PR body → commit body, branches auto-delete. Review threads must
be resolved before merge (`required_conversation_resolution`) and automated reviews must
have actually posted — see CONTRIBUTING.md "Pull Requests & Merging".

**Coverage**: `unit-tests` parses `bun test --coverage` output and compares against thresholds
(default 75% functions, 60% lines). Failures emit `::warning::` annotations but do NOT block
merges (`continue-on-error: true`). Thresholds are overridable via dispatch inputs
`min-funcs` / `min-lines`.

**Artifacts**:
- `coverage-report` — full per-file coverage table (14 days)
- `{integration|main|sweep}-logs-<platform>` — bun test output + timing + metrics.ndjson +
  machine.json + qemu.log (7 days); durable timing lives on the `ci-data` branch

## Design Principles

### Scope Boundary — QEMU Expert, Not Orchestrator

quickchr manages individual CHR instances. Multi-router topologies, test matrices, and workflow orchestration are **out of scope** for the CLI and library. Provide `examples/` as runnable scripts (a `bun run`-able `<name>.ts` plus `.sh`/`.ps1`/`.py` siblings; `grounding/` is the one `bun:test` reference) to inspire, but don't build a framework. The example convention lives in `.github/instructions/examples.instructions.md`; Python examples prefer `uv run` over a venv. Users (and their AI agents) compose quickchr instances into whatever topology they need — we give them reliable building blocks.

### Networking — Discover, Don't Configure

For advanced networking (TAP interfaces, bridges), quickchr **discovers and presents options** but does not manage OS-level network configuration. On macOS, vmnet is straightforward (root + a QEMU flag). On Linux, TAP requires editing system files that vary by distro and network manager — that's the user's domain. quickchr will enumerate available interfaces, generate the correct QEMU flags, and link to tikoci docs for setup guides.

#### SLiRP hostfwd — Why User-Mode Must Be ether1

QEMU SLiRP (`-netdev user`) hostfwd **requires** the guest to have an IP address (default `10.0.2.15`) on the SLiRP-connected interface. Without it, `hostfwd` accepts TCP connections on the host side (creating a half-open state) but the guest never receives data — HTTP requests hang until timeout.

RouterOS auto-creates a DHCP client only on ether1. SLiRP includes a DHCP server that assigns `10.0.2.15`. Therefore **SLiRP must be ether1** for zero-config provisioning. This is why `user` is always the first network in multi-NIC configurations.

When adding shared/bridged as ether2+, a manual DHCP client is needed:
```
POST /rest/ip/dhcp-client/add
{"interface":"ether2","use-peer-dns":"yes","add-default-route":"yes","default-route-distance":"2"}
```

The `default-route-distance=2` ensures the shared route is backup — SLiRP ether1 remains the primary gateway, avoiding ECMP dual-gateway side effects.

**TCG hazard:** SLiRP half-open connections (TCP connect succeeds, data never flows) burn the full per-probe HTTP timeout in `waitForBoot`. Under cross-arch TCG where TCP round-trips are slow, this compounds badly. Lab: `test/lab/slirp-hostfwd/`.

#### Host-Side L2 Capture (MNDP, MAC-Telnet)

A caller can receive the guest's raw Layer-2 frames — RouterOS MNDP (UDP/5678
broadcast) being the first use case — without root or a native helper, using the
TCP `socket` netdev: the host runs a TCP server, the CHR gets a `socket-connect`
NIC, and QEMU streams every guest frame to the host length-prefixed (4-byte BE
length + raw Ethernet). Loopback-only, cross-platform. Writing a frame back over
the same connection injects L2 into the guest (the MAC-Telnet primitive). Recipe:
`docs/mndp.md`; example: `examples/mndp/`.

**Discovered constraint (2026-06-06):** the `socket-mcast` netdev — the documented
multi-VM L2 path — is **broken on macOS**. QEMU's mcast socket sets only
`SO_REUSEADDR`, while macOS/BSD need `SO_REUSEPORT` on every socket sharing a
multicast port; two CHRs on one group don't discover each other and host capture
gets nothing. mcast still works on Linux/CI. Prefer `socket-connect` for host
capture on any platform. Evidence: `test/lab/mndp/REPORT.md`.

#### Guest→Host UDP via the Gateway — No Forward (discovered 2026-06-25)

The dual of `hostfwd`: SLIRP's gateway `10.0.2.2` *is* the host from inside the
guest, so guest-originated UDP to `10.0.2.2:<port>` reaches a host socket bound on
loopback `<port>` with **no forward and no extra NIC**. This generalizes the TZSP
path (`tzspGatewayIp`/`captureInterface`) — it is not TZSP-specific and reaches an
ordinary bound socket, not just a `tshark`/pcap capture. The host socket **must be
unconnected**: SLIRP re-emits from a rewritten loopback source
(`127.0.0.1:<ephemeral>`), which a `connect()`-ed socket would filter. This closed
centrs' btest UDP-coverage gap (issue #18) with no new quickchr feature — it was a
discoverability gap. Recipe: `docs/networking-recipes.md`; evidence:
`test/lab/gateway-udp/REPORT.md`.

#### Port-Range Forwards — Explicit-Host-Only

`--forward`/`extraPorts` accept a range (`name:hostStart-hostEnd[:guest…][/proto]`)
that expands to one `PortMapping`/`hostfwd` per port — QEMU has no native range.
**Design choice:** range host ports must be *explicit*. Auto-allocation draws from
the per-instance 10-port block, which cannot guarantee a contiguous run; requiring
explicit host ports keeps the change additive (the existing
`validateExplicitExtraPorts` collision check covers them) and avoids reworking the
port-block contract. A 64-port cap bounds the generated `hostfwd` string. For
guest-chosen *unpredictable* ports, the gateway path (above) is the better fit for
the guest→host direction. `expandForwardSpec` is the range-aware entry point;
`parseForwardSpec` stays single-port for backward compatibility.

### Platform Priority

macOS → Linux → Windows. Mac and Linux share most code paths with minor `#ifdef`-style branches. Windows is tracked but lower priority — larger RouterOS admin audience there, but fewer recipes and harder to test. Windows CI runner planned after the existing macOS/Linux matrix is stable.

### CLI Design

Tighten before expanding. New subcommands (`logs`, `exec`, `console`) wait for a full command tree review. The CLI should be discoverable without paging `--help` — shell completions help more than a long command list. Use multipass and virsh as reference points for symmetry, not to copy.

**Command-surface principles** (locked — these shape every new subcommand):

- **Interactive prompts are confined to `setup`.** Every other command is non-interactive — no selectors. Without a `<name>` argument, print the list + a tip; don't prompt.
- **`start`/`stop` are pure operations** — no wizard, no creation. `add` creates; `setup` is the wizard.
- **`set`/`get` are for machine config, not re-provisioning.** After first provisioning, don't add commands that re-provision — the surface grows and each post-provision capability needs its own RouterOS edge-case testing. A drifted machine is recreated, not mutated (see *Out of Scope*).
- **`--json` on read commands only** — same content as console output (richer metadata OK), pipe-friendly for `jq`. No `--yaml`/`--serialize`/TSV/CSV; callers pipe `--json` through `jq`/`yq`. For `exec`, `--json` wraps the quickchr response — the RouterOS result stays a string (use `:serialize` in-script for structured RouterOS output).

### RouterOS Verification

Always read back what we write. One extra REST API call after a provisioning action (license, user, package) catches version-specific command drift early. Surface errors with actionable hints rather than silent failures.

### Provisioning Scope

quickchr provisions at first boot and (optionally) on restart:
- **User creation** — create user, set password, optionally disable admin
- **Package install** — SCP `.npk` files, reboot to activate
- **License** — `/system/license/renew` for trial
- **Device-mode** — `/system/device-mode/update mode=rose container=yes ...` for restricted features (containers, traffic-gen, routerboard). Opt-in: not configured unless explicitly requested via CLI `--device-mode` or API `deviceMode` option. CHR ships with `mode=advanced` which is sufficient for most use cases. Device-mode requires a hard QEMU power-cycle to confirm changes — this is the MikroTik-mandated confirmation mechanism (physical button press on real hardware, cold reboot on VM). The wizard defaults to `rose` when the user opts in, since it enables containers. See: https://help.mikrotik.com/docs/spaces/ROS/pages/93749258/Device-mode
- **Config import** — planned: load `.rsc` or `.backup` at creation time

Provisioning via REST API is preferred (simple HTTP calls). Serial console provisioning (prompt detection + buffer tracking, as in chr-armed) is a fallback for locked environments. Key lessons from chr-armed serial work: use `\r` not `\r\n` on PTY; accumulate buffer with offset tracking to prevent re-matching; detect prompts dynamically, don't use fixed delays.

### Exec Transport Design

`quickchr exec` supports multiple transports via `--via=auto|ssh|rest|qga`:
- **auto** (default) — currently REST only; future: try SSH first, fall back to REST `/execute`
- **rest** (implemented) — POST to `/rest/execute` with `{"script": "<command>"}` (RouterOS 7.1+). No SSH needed. 60-second server-side timeout. Uses `resolveAuth()` for smart credential resolution.
- **ssh** (planned) — full RouterOS CLI, supports interactive commands, requires `sshpass`
- **qga** (implemented) — QEMU Guest Agent commands (x86 only today, ARM64 pending MikroTik fix)

**Credential resolution** (`src/lib/auth.ts`): Priority order is (1) explicit `--user`/`--password` override, (2) provisioned user from `machine.json` (`state.user`), (3) CHR default `admin:` (empty password). Both `exec()` and `rest()` on ChrInstance use this.

Output formatting via `--json` flag. RouterOS trick for structured output: wrap commands in `[:serialize to=json [<routeros-cmd>]]` to get JSON from any CLI command. For REST-to-CLI mapping, see tikoci/restraml `lookup.html`.

### Examples Philosophy

`examples/` is **load-bearing agent-onboarding surface** — agents (and humans) open
it before `src/lib/`, so a *wrong* example is worse than none: it teaches the wrong
lesson and costs a later code-review to unwind. Examples are therefore held to the
same bar as the code, and a broken one **gates** extended verification.

Each `examples/<name>/` is a **runnable artifact that does something real** against a
CHR, in the canonical shape (full rules in
[`.github/instructions/examples.instructions.md`](.github/instructions/examples.instructions.md)):

- **`<name>.ts`** — the **primary**: a `bun run`-able script using the library API,
  with `runExample()` guaranteeing teardown (success *or* failure). Not a test.
- **`<name>.sh` / `<name>.ps1`** — the **CLI** mirror (POSIX `sh` + PowerShell),
  sourcing `examples/common.{sh,ps1}`. New examples ship both; existing ones add
  `.ps1` where the CLI flow is simple.
- **`<name>.py`** — optional CLI driver for a non-TS audience, run with `uv run`.
- **`grounding/` is the one `bun:test` example** — kept as a test on purpose, because
  there the *assertions are the documentation* (it's the "how to write CHR
  integration tests" reference). Everywhere else, an agent can wrap a script in
  `test()` trivially, so a runnable script is the better teaching surface.

Makefiles were the old convention and are now **disallowed** in `examples/`
(`scripts/validate-examples.ts` enforces this) — they mixed CLI orchestration with
raw `scp`/`curl`/`ssh`, the opposite of "one example teaches one capability."

Building examples early is a form of "anchor testing" for the CLI surface — it finds
ergonomic issues before we commit to new commands, and each gap surfaced gets a
"friction found" note in the example's README plus a GitHub issue rather than
being papered over (this pass surfaced the missing `quickchr cp`, #23). Coverage of
the CLI/library surface is tracked in
[`examples/COVERAGE.md`](examples/COVERAGE.md).

### Agent-Friendliness — Discoverability Over Features

A recurring lesson from downstream agents (donny, centrs, restraml): the friction is usually **finding** an existing capability, not a missing one. Issue #18 (centrs) nearly rebuilt UDP forwarding, `socket-connect` L2, and the guest→host gateway — all of which already existed — because the only way to choose among them was reading `src/lib/network.ts`. Rule: **every CLI-documented capability also needs a library-facing, by-goal surface** — JSDoc at the call site, a by-goal recipe (`docs/networking-recipes.md`), and coverage in the `routeros-quickchr` skill — or agents won't find it. Connection handoff for harnesses goes through `ChrInstance.descriptor()` / `quickchr inspect` / `quickchr env` (credential-bearing by design), never by reading `machine.json`.

### Out of Scope (decided)

Explicitly rejected, with rationale, so they aren't re-proposed:

- **Cloud deployment** — `tikoci/chr-armed` already does OCI + AWS; revisit only once local CHR is solid and provisioning/image layers can be reused.
- **Multi-CHR orchestration** — building blocks + `examples/`, not a framework (see *Scope Boundary*). Users/agents compose topologies.
- **`quickchr upgrade <name>` / post-provisioning mutation** — replaced by a future *config audit/verify* report (flags drift; user recreates). Re-provisioning has too many failure modes (version bumps, rotated creds, changed deps).
- **Packaging (Homebrew/Deb)** and **service management (launchd/systemd)** — lower priority than core; optional later.
- **Machine templates** — CLI flags are the template, API objects are reusable, the wizard always prompts. No separate template system.
- **`--no-ansi` flag** — ANSI is fine in text output (`grep`/`jq` cope); the real discipline (separate presentation from content) belongs in a centralized error-message surface instead.
- **`machine.json` → YAML** — staying JSON (pretty-printed) for `jq` users; YAML adds complexity without a matching benefit.
- **Separate multi-version/arch matrix runner** — the CI matrix + `examples/version-matrix` cover it.

### Document Maintenance

DESIGN.md is the living home for design decisions and rationale. At the end of any significant work session, agents should review whether new implementation details, design decisions, or discovered constraints belong here. Open/close work in **GitHub Issues** — not BACKLOG.md (see CONTRIBUTING.md "Tracking work"); record grounded RouterOS/QEMU behaviour facts in the narrowest scoped doc (`.github/instructions/*.md`, `docs/`, or `test/lab/<topic>/REPORT.md`); add a CHANGELOG.md entry for user-facing changes. Treat this as a lightweight checklist, not a gate.
