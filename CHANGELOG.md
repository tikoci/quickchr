# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Even minor versions (0.2.x, 0.4.x) are releases; odd minors (0.3.x, 0.5.x) are pre-releases.

## [Unreleased]

## [0.4.8] — 2026-09-21

### Added

- `ChrInstance.hostGatewayIp` — the QEMU user-mode (SLIRP) gateway `10.0.2.2`, the
  host's address as seen from inside the guest. Same value the instance has always
  carried; the point is the name. (#26)

- Tips: a one-line pointer on stderr at the moment a better-suited tool applies,
  suppressible with `QUICKCHR_NO_TIPS=1`. `exec --help` and a bare `quickchr exec`
  now name `centrs retrieve|execute --quickchr <name>`, which validates a
  RouterOS-shaped command before running it and has per-verb help — `quickchr exec`
  is a raw `/rest/execute` pipe and always was. Tips go to stderr, never stdout,
  so `--json` output stays parseable.

- `QuickCHR.listOrphans()` and `QuickCHR.removeOrphan(name)` — half-created machine
  directories are now addressable from the public API, not just by `rm -rf` on the
  data dir.

- `QuickCHR.listUnreadable()` — the machines `list()` skipped, each with the reason it
  could not be loaded: the file would not read, the JSON is invalid, or it parsed into
  something that is not machine state. `list()` no longer aborts on a corrupt
  `machine.json`, so this is where what it skipped stays visible. (#165)

- `quickchr cache add` and the public `cacheAdd()` API resolve and prefetch one
  CHR image without requiring QEMU or creating a machine. `quickchr cache key`
  and `cacheKey()` expose the actual cache directory, concrete architecture,
  and resolved version; pinned versions skip the network and offline channel
  resolution degrades to the documented `unresolved` sentinel.

- `quickchr networks sockets create` takes `--mode dgram|listen-connect|mcast`,
  `--port` and `--group`. The registry has always modelled more than one transport;
  until now the CLI could only reach UDP multicast. Creating an `mcast` link prints
  the caveat that it is broken on macOS and in UDP-blocked sandboxes, and that it
  fails silently in both. (#158)

- `quickchr start` names the transport each named socket resolved to, and
  `quickchr networks sockets` lists it. Nothing about a named socket now requires
  opening a file under the data dir. (#158)

- `bun run check` parses every `--add-network` specifier printed in the docs through
  `parseNetworkSpecifier`, so a spelling the CLI does not accept fails lint. A block
  documenting syntax that does not exist yet opts out with
  `<!-- specifier-lint: skip — reason -->`, and the reason is required. (#157)

### Changed

- **A named socket now defaults to a pair of unix datagram sockets** (`--mode dgram`)
  on macOS and Linux, and to a TCP pair (`--mode listen-connect`) on Windows, which
  has no AF_UNIX datagram socket. The previous default, UDP multicast, is the only
  N-way transport but fails *silently* on macOS and wherever UDP is blocked —
  interfaces up, addresses assigned, 100% packet loss, nothing logged. `dgram` needs
  no host port and no UDP syscall, and either machine may start first. Use
  `--mode mcast` for more than two machines on one segment. Requires QEMU 7.2+, which
  is checked before spawn, and Windows is checked too — a `dgram` entry carried over
  from a POSIX host is refused there with the command to recreate it.

  A named socket you created yourself keeps the mode recorded in its
  `networks/<name>.json` and is unaffected. One that `start` auto-created for you is
  removed when its last member stops, as it always has been, so it comes back with
  the new default the next time — and `start` now names the transport, so the change
  is visible rather than silent. (#158)

- A third machine joining a two-machine named socket is refused, naming the machines
  that hold the ends and pointing at `--mode mcast`. It is checked before any image
  download. This is not a cosmetic cap: a second QEMU binding the same unix path
  unlinks the first's socket and takes the link over with nothing logged on either
  side, and a third peer on a TCP pair connects successfully and then receives
  nothing. (#158)

- `createNamedSocket()` rejects an `mcastGroup` on a non-`mcast` link, and a `port` on
  a `dgram` link, rather than dropping either silently. A `dgram` entry now carries no
  `port` at all — it addresses its ends by filesystem path, so a number there was a
  field that looked meaningful and was not. (#158)

- A named-socket option given without its value (`--mode`, `--port`, `--group` with
  nothing after it) is rejected instead of silently taking the default, and a `--port`
  with trailing characters (`4000abc`) is rejected instead of parsing as `4000`. (#158)

- A machine that is not running no longer holds an end of a named link. A foreground
  run that has exited, and `clean()`, both reached "stopped" without going through
  `stop()`, so they kept their endpoint and could block a third machine or the link's
  removal. (#158)

- Automatic socket port allocation is serialized registry-wide. It reads every entry to
  pick `max + 1`, so a per-entry lock did not help when the contenders were different
  names: three `mcast` links created at once all took port 4000, silently collapsing
  three segments into one shared group. Allocation also reads the registry from disk
  and unions it with the in-memory cache, so a link another process has changed since
  this one cached it cannot be handed out twice. (#158)

- `quickchr networks sockets remove` refuses a link its machines are still using.
  Removing the entry also unlinks the endpoint sockets, so the peer's `remote.path`
  stops naming anything and a running link dies silently. (#158)

- Joining a named socket is serialized with a registry lock and written atomically.
  Two machines started concurrently (`quickchr start a & quickchr start b &`) both read
  the same free endpoint and one overwrote the other, handing both QEMUs the same
  socket path — which on a `dgram` link means the second silently takes the link over.
  A truncating write could also leave a concurrent reader seeing invalid JSON and
  reporting the socket as missing. A start that claims one link and then fails on a
  second, full one releases the first claim too. (#158)

- `createUser()` now resolves only once the credentials it created are actually
  accepted, instead of once the user record is visible in `/rest/user`. Callers
  that use a new user immediately — which is every caller — were relying on the
  stronger fact while the function only promised the weaker one. A new
  `waitForAuth()` in `src/lib/provision.ts` polls for the stronger one — a
  module export alongside `createUser()`, not part of the `@tikoci/quickchr`
  barrel — and reports
  `{ attempts, elapsedMs }`; `QUICKCHR_DEBUG=1` logs one line per created user.
  Hardening for #69, not a proven fix for it: the Windows 401 that prompted this
  did not reproduce locally, where every fresh user was accepted on the first
  attempt under both TCG and HVF. The wait applies to the `full` group only:
  RouterOS separates authentication from authorization, and a valid user in a
  limited group answers the probe with 401 (no `rest-api`) or HTTP 500 (no
  `read`/`web`), so gating those would fail a correctly created user.

- CI owners now prefetch and verify a declared image-and-package manifest in a
  named, separately timed step, then save the immutable v5 cache before tests.
  Restore-key extras are reconciled away so old targets cannot accumulate until
  auto-prune evicts fixed fixtures. Product-test failures no longer leave a
  platform cold, and declared external downloads no longer inflate per-file
  timing. Raw images are checked against their partition extents, package sets
  carry an atomic extraction manifest, and each leg boots the exact version
  named by its cache key.

- **`npm i @tikoci/quickchr@next` no longer serves an old package.** A stable release
  now also moves the `next` dist-tag onto itself. There is no separately maintained
  pre-release line — a quickchr bug is fixed on `main` and ships in the next stable — so
  `next` had sat at `0.3.1` while `latest` advanced through all of `0.4.x`. A
  pre-release still publishes to `next` only and never becomes `latest`.

- **The tested Bun runtime is pinned.** `.bun-version` (currently `1.4.2`) is the single
  source of truth, and every workflow installs Bun through
  `setup-bun`'s `bun-version-file`. `bun run check` fails if a `setup-bun` step
  omits it or if the pin is not an exact `x.y.z`. Previously each CI run installed
  whatever Bun was newest, so a runtime upgrade could land — and break the build —
  without any repository change to review (#148).

### Deprecated

- `ChrInstance.tzspGatewayIp` — renamed to `hostGatewayIp`. The value was never
  TZSP-specific: it is the host as seen from the guest, and it carries any guest→host
  UDP (remote syslog, NetFlow, a plain socket) with no forward and no extra NIC. The old
  name invited readers to assume a sniffer-only primitive and skip the recipe that
  covers their case. The alias is still populated with the identical value — a unit test
  asserts the two cannot drift — and will be removed no earlier than `0.5.0`.
  Migration is a rename at the call site. (#26)

### Removed

- `--vmnet-shared` and `--vmnet-bridge <iface>` are gone from `add` and `start`. Both
  were exactly expressible as `--add-network shared` / `--add-network bridged:<iface>`,
  and both were broken: `--vmnet-shared` alone applied no network at all (it was read
  with `flag()`, which returns `undefined` for a boolean), and `--vmnet-shared lab`
  "worked" only by eating the machine name. Typing either now fails with
  `INVALID_ARGUMENT` naming the replacement, rather than being silently ignored. The
  `vmnet-shared` *netdev* and the legacy `machine.json` migration keep the name and are
  untouched — only the CLI flag was removed. (#164)

### Fixed

- **A backgrounded QEMU now leaves the caller's process group on macOS and Linux**, so
  it survives a signal aimed at the CLI rather than the VM. `spawnQemu()` called
  `unref()` on the POSIX path, which lets the parent exit *voluntarily* — QEMU is
  adopted by init/launchd — but left QEMU in the caller's process group, where a group
  signal reaches it: Ctrl-C in the terminal, a shell `timeout`, a CI step teardown, an
  agent harness killing a stuck command. A multi-CHR lab hit exactly this and worked
  around it by wrapping every start in `nohup`. Windows already spawned with
  `detached: true` for its own reason (escaping the Job Object), with a comment
  describing this hazard; both platforms now take that one path. Killing a run's VMs
  deliberately is by QEMU process name, not by group, so nothing that intends to sweep
  QEMU loses its reach. (#159)

  `start` still waits for REST readiness before it returns — `--bg` has always been the
  default and only controls where the serial console goes, never whether the CLI blocks.
  An opt-out (`--no-wait`) is the other half of #159 and is not in this release.

- `quickchr list` survives one corrupt `machine.json`. `loadMachine()` parsed with no
  guard, so a single truncated file — the realistic outcome of a disk-full or power
  loss during `saveMachine()` — aborted the whole listing with a raw parse trace and
  took every healthy machine's state with it. The enumeration now skips what it cannot
  read — a failed read, invalid JSON, or valid JSON that is not machine state — and
  shows it as a row instead: named, marked `unreadable`, with
  `quickchr remove <name>` attached, and exit 0 because the listing succeeded. Nothing
  is hidden — a machine that vanished from `list` is exactly the failure that does not
  look like one. `QuickCHR.get(name)` still throws for that machine, because a lookup
  by name is not an enumeration, and it now throws `STATE_ERROR` naming the file and
  the remedy rather than a `SyntaxError`. (#165)

- A boolean flag no longer swallows the argument after it. `parseFlags` had no notion
  of arity and guessed from the shape of the next argument — *if it does not start with
  `--`, consume it* — so `quickchr start --vmnet-shared lab` set `vmnet-shared="lab"`
  and lost the machine name. Arity now comes from the flag registry
  (`src/cli/flags.ts`), and a test checks every flag read in the CLI against it — the
  helpers and direct `flags[...]` access both — so the audit that found this one is no
  longer someone's eyesight. That test immediately caught `quickchr cache prune
  --older-than` / `--max-age` / `--max-size`, whose values the arity change would
  otherwise have started dropping. (#164)

- `--help` is handled before any side effect, for every subcommand. `quickchr add --help`
  used to generate a machine name and download 43 MB while printing nothing, and
  `quickchr networks sockets create --help` used to persist a named socket called
  `--help` on the default start port. The guard lives in the dispatcher, so a new
  subcommand cannot miss it; everything after a bare `--` is left alone as the
  caller's payload. (#156)

- `quickchr add` and `quickchr start` reject an unrecognised flag instead of
  ignoring it, with a "did you mean" suggestion for a near miss. A typo that
  downloads 43 MB and creates a machine is not a good default. (#156)

- `quickchr remove ..` deleted the entire data directory — every machine, the image
  cache and the socket registry — and reported success. `join(machinesDir, "..")`
  normalizes to the data dir, which exists and holds no `machine.json`, so the orphan
  check took it for a half-created machine. Names that are not usable path segments
  (empty, `.`, `..`, or containing a separator) are now rejected before any path is
  derived from them, at every site that deletes. Introduced with the orphan recovery
  below and caught in review before release.

- `quickchr networks sockets remove ../<name>` deleted a `.json` file outside the
  socket registry, and a longer prefix reached outside the data dir entirely. The
  traversal guard now sits in `socketPath()`, the one place a named socket becomes a
  path. Pre-existing; found while auditing the deletion paths after the `remove ..`
  fix above.

- A known flag given without its value is an error rather than a silent default, in
  both spellings: `quickchr add --name --version 7.24.3` parsed `--name` as `true` and
  `quickchr add --no-name` parsed it as `false`, and either way the machine got an
  auto-generated name. `--no-device-mode` remains a supported negation. (#156)

- `quickchr remove` no longer deletes a machine directory whose create is still in
  flight. Between `ensureDir()` and `saveMachine()` an active `add`/`start` looks
  exactly like an orphan, so removal now takes the same start-lock: a live creator
  makes it fail with `MACHINE_LOCKED`, while a lock whose owner is gone is still
  recoverable.

- Machine and named-socket names are validated before anything is written: no
  leading `-`, and letters, digits, dot, underscore and hyphen only. Both become a
  path segment under the data dir, so this also closes a path-traversal hole in
  `socket::<name>`. Existing machines created under the older, looser rules stay
  able to start. (#156)

- A failed `quickchr add` no longer leaves a machine directory behind. One with no
  readable `machine.json` was invisible to `list`, unremovable by `remove`, and
  still blocked re-add with `MACHINE_EXISTS` — recoverable only by knowing the data
  dir exists. `add` now removes the directory it created when it fails, `remove`
  clears a stranded one, `MACHINE_EXISTS` says which case it is, and `doctor` points
  at `quickchr remove <name>` rather than `rm -rf`. (#155)

- A named socket in `listen-connect` mode is no longer a guaranteed dead link. The
  listener role came from `members.length === 0` at resolve time, but members are
  registered *before* networks are resolved, so the starting machine had always added
  itself and `isFirst` was never true — every member resolved to `connect=` and nobody
  listened. The two ends are now held in persisted slots, so the role survives a stop
  and start instead of silently demoting the listener to a second connector. (#158)

- `quickchr list` and `quickchr info` print `socket::<name>` for a named socket
  instead of the raw specifier object. `format.ts` tested for a `socket-named` type
  the parser never emits, so the branch could not match. (#158)

- The `MANUAL.md` and `docs/networking-recipes.md` specifier tables listed
  `socket-listen:<port>` / `socket-connect:<port>` / `socket-mcast:<group>:<port>`.
  Those are the internal `NetworkSpecifier` type names; the CLI takes
  `socket:listen:<port>`. Both now show the CLI spelling, with the TypeScript form
  noted beside it. (#157)

- Every NIC now carries a stable, locally-administered MAC (`02:` plus five
  octets derived from the machine name and NIC index) instead of QEMU's default
  `52:54:00:12:34:56` sequence. That default is per-NIC-index within a guest, so
  NIC *N* held the same address in every machine — invisible with `user`-only
  NICs, but two machines sharing an L2 segment (named socket, listen/connect
  pair, TAP, or a RouterOS bridge on a hub VM) collided, and the resulting
  half-broken forwarding read as a RouterOS or overlay fault rather than a
  launcher one. Addresses are persisted in `machine.json` and derived rather than
  randomized, so a lab rebuilt under the same names presents the same addresses.
  **Machines created before this release keep QEMU's defaults and must be
  recreated to get a stable address** — a MAC is assigned at creation only and is
  never changed on an existing machine, because RouterOS ties its persisted
  interface identity to it and a changed address leaves the guest with no IP.
  (#154)

- **Green unit gates on Bun 1.4.** Two tests pinned runtime-synthesized HTTP behavior
  rather than quickchr's own, and went red when CI moved from Bun 1.3.14 to 1.4.2:
  a bodyless `DELETE` no longer asserts a `Content-Length: 0` that quickchr never set
  (verified against live CHR 7.24.2: RouterOS accepts the absent header, returning `204`),
  and the malformed-`content-length` test now asserts quickchr's invariants —
  `DOWNLOAD_FAILED`, nothing published, no bogus size in the diagnostic — instead of a
  message string Bun 1.4 produces at a different layer. No production behavior changed (#148).

## [0.4.7] — 2026-08-04

### Added

- **Boot-failure reports.** A `BOOT_TIMEOUT` now writes a self-contained
  `boot-failure-<machine>-<timestamp>.json` under `<dataDir>/failures/`, holding the
  REST-probe tally, a TCP probe of the forwarded port, QEMU monitor `info status` /
  `info block`, process liveness, the QEMU argv, the machine-dir listing, and the full
  `qemu.log` / `serial.log` text. It is written outside the machine directory so
  cleanup cannot delete the evidence, and a condensed version is appended to the thrown
  error message. `serial.log` is deliberately **not** inlined into that message — only
  into the report — because the message reaches console and CI job logs and the log can
  carry provisioning credentials. The directory keeps the 20 newest reports.
- **`QUICKCHR_SERIAL_LOG=1`** tees the guest serial console to
  `<machineDir>/serial.log`. Opt-in by design: serial-console provisioning types the
  generated password in cleartext, so the log is secret-bearing. Off by default.
- **`QUICKCHR_PRESERVE_ON_FAILURE=1`** keeps a failed machine's directory instead of
  removing it (QEMU is still stopped, so the port block is released). Off by default —
  a failed `start()` still cleans up. Mainly useful locally; the failure report itself
  survives cleanup without it.
- **Boot-failure reports now localize the drop, not just record it.** Three additions
  (#105): a `forwardProbe` table classifying every forwarded TCP port as
  `served`/`refused`/`dropped`/`not-forwarded` from slirp's own `info usernet` view —
  all ports dropped points at the guest RX path, one dropped port at that service; a
  read-only `guest` snapshot taken over the serial console, which stays reachable while
  REST is dead (`/log`, `/ip/address`, `/ip/service`, `/ip/firewall/filter`,
  `/interface` stats, connection tracking, `/system/resource`); and an opt-in
  `countingRule` probe that says whether the guest received the packets at all. Guest
  payloads stay in the report — only credential-free shapes reach the thrown error.
- **`QUICKCHR_DEEP_BOOT_DIAGNOSTICS=1`** allows the counting-rule probe, the one
  capture that writes to the guest (a mangle `passthrough` rule plus a burst of host
  probes). Off by default, on in CI, and always skipped when
  `QUICKCHR_PRESERVE_ON_FAILURE=1` asks for the failure state to be left untouched.
- **Post-readiness failure reports.** A request that fails *after* a machine has been
  declared REST-ready now gets the same instrument set as a boot timeout, written as
  `post-readiness-failure-<machine>-<timestamp>.json` in the same `<dataDir>/failures/`
  directory and under the same 20-report cap. The machine is left running and untouched.
  Because a boot that worked explains nothing on its own, these reports lead with a
  `trigger` block naming the failed operation, the error with its `code`/`errno`, the
  time since REST-ready, and the credential transition that preceded the request — the
  #69 signature, which until now surfaced as a single line of `ECONNRESET`.

### Changed

- CI: the CHR image cache is keyed by the **resolved** RouterOS version, and exactly one
  configuration writes it. The `plan` job resolves each channel target to a concrete
  version once per dispatch (`scripts/ci-cache-key.ts`, shared with the library's own
  `resolveVersion()`), so the key is `chr-images-v3-{platform}-{version}` — no run id,
  no channel alias — and an exact hit correctly means the entry already holds what the
  leg needs. Only a full unfiltered integration leg writes; filtered/smoke legs and the
  examples-smoke job restore read-only, because an entry's content must stay a function
  of its key. The previous per-run rotation wrote a fresh 250-520 MB entry on every leg
  of every run (~1 GB per push to main, 11.49 GB against a 10 GB quota, #104) and left
  cold download an uncontrolled variable in every timing measurement (#106). Each leg
  logs `Cache OWNER`/`Cache READER` with its key.
- CI: the integration test step now carries its own `timeout-minutes`, 10 minutes under
  the job budget. A *job* timeout tears the runner down before any `if: always()` step
  runs, so the artifact upload is skipped and the leg produces no evidence at all — the
  reason the `macos-x86` leg resisted diagnosis for weeks (#76). A *step* timeout leaves
  the job alive to reap QEMU, assemble metrics, and upload its logs.
- CI: corrected the `macos-x86` accelerator classification. `macos-15-intel` is a
  bare-metal Intel runner where `detectAccel()` returns **hvf**, but the platform table
  hardcoded `tcg`, and the "Accel hint" summary line printed that hardcoded value one
  row below the `detectAccel` line contradicting it. The table now records the expected
  accelerator separately from the empirical run-time budget, the summary reports the
  *detected* accelerator, and a mismatch raises a `::warning::` so the table cannot
  drift silently again. No leg's timeout or smoke eligibility changes.
- `BOOT_TIMEOUT` messages now report *what the REST probe saw* rather than only that it
  gave up — connection refusals, resets, and hung connections are counted separately,
  and the report adds QEMU's `info usernet` so a guest that booted but is unreachable
  is distinguishable from one that never booted. (Under the default `user`/slirp
  network mode the host port accepts regardless of guest state, so the probe tally and
  the slirp connection table — not a live host port — are what carry the answer.)
  `ChrInstance.waitForBoot()` takes an optional second argument to collect that tally;
  existing calls are unaffected.
- `Monitor command timed out` now names the command and reports where the round-trip
  stalled — connect / first byte / prompt / command written / response first byte, plus
  bytes received — instead of failing with no detail.
- Integration tests derive their own timeout from `defaultBootTimeout()` via
  `bootTestTimeout()` instead of hardcoding it. Hardcoded literals were *shorter* than
  the same-arch TCG boot budget (300 s vs 480 s), so on TCG legs bun killed the test
  before `waitForBoot()` gave up and the boot-failure report was never written — the
  reason several #79 reproductions carried no evidence. The budget itself is unchanged;
  retuning it is #106.
- Integration tests reach CHR's REST API through one client — `test/integration/chr-rest.ts`,
  wrapping the same `src/lib/rest.ts` (`node:http`, `agent: false`, `Connection: close`)
  the library itself uses. Bun `fetch()` and, in `anchor.test.ts`, a hand-rolled
  `node:http` copy of `restGet` are both gone. This removes a confound rather than
  fixing anything: run 30507484030 reset through `restGet` too, and `test/lab/bun-pool/`
  never reproduced the pooling bug (#69).

### Fixed

- **One refused connection to `upgrade.mikrotik.com` failed a whole `quickchr start`**
  (#121). `resolveVersion()` had no retry at all: `fetchResilient()` is one attempt per
  transport (system resolver, then a public-DNS IPv4 fallback), and if the fallback also
  threw, the error propagated. #116/#119 gave the *download* path a retry policy and left
  version resolution — which sits on the critical path of `start()`, the wizard and the
  CLI — with a single shot. Observed on a `platforms=all` run: `Integration
  (windows/x86_64 · testing)` went red on one `ConnectionRefused`, on a leg where nothing
  about RouterOS, QEMU or the platform was involved. `resolveVersion()` now retries a
  connection-class failure up to 3 times with the same backoff shape as `downloadToFile`,
  and reports the attempt count plus the host when it exhausts them. An HTTP status is
  still terminal on the first attempt — a 404 for a bad channel stays fast.
- **The version-resolution error named an IP address nobody configured** (#121).
  `fetchResilient()` discarded the direct attempt's error whenever the IPv4 fallback
  itself threw, so the surfaced message read `path: "https://159.148.147.251/routeros/…"`
  with no hostname — leaving "the system resolver was broken", "the host refused us" and
  "public DNS handed back a bad address" indistinguishable, which is exactly the question
  the log has to answer. That fallback fires routinely on hosted runners (their stub
  resolver fails slowly, 2–26 s), so its error was often the only one visible. Both
  failures are now raised together as a `ResilientFetchError` naming the URL, each
  transport's error, the address the fallback used and which resolvers produced it, with
  the direct failure kept as `cause`.
- **Every PowerShell example was a silent false green** (#102). A `ParserError` in
  `examples/common.ps1` took out the entire file — PowerShell parses `$LASTEXITCODE:` as
  a scope-qualified variable reference — so every helper it defines was undefined for the
  caller and `quickstart.ps1` ran no quickchr command at all. It exited 0 having printed
  one line, and the smoke harness (`code === 0` and `out.length > 0`) reported `(pass)`
  for months. The parse itself was fixed in #101; the false-green *class* is closed here:
  the smoke harness now asserts per-example output markers — substrings only a working
  run produces, including one from the end of the script and one the CLI itself emitted —
  and each `.ps1` sets `$ErrorActionPreference = 'Stop'` **before** dot-sourcing
  `common.ps1`, so a `common.ps1` that fails to load can no longer leave the example
  running past it. Reproduced locally against the real files (pwsh 7.4.6, Intel macOS):
  with #102's defect reinstated, rc=0 unguarded and rc=1 guarded. `validate-examples`
  enforces the guard.
- **`examples/mndp/mndp.py` exited 0 when no MNDP announcement arrived.** The failure
  branch used a bare `return`, which leaves `main()` through the `finally` and never
  reaches the trailing `sys.exit(rc)` — the same false green as #102, in a different
  language. It now raises `SystemExit`; cleanup still runs. Measured with the identity
  match forced to fail: rc=0 before, rc=1 after.
- **A healthy large download was reported as a timeout** (#116). Both download paths
  bounded a transfer by *total duration*: `images.ts` aborted at a flat 120 s per
  attempt and retried three times, `packages.ts` had no deadline and no retries at all.
  A total-duration deadline cannot tell "slow" from "stuck" — it fires on a healthy
  transfer whose only sin is being large, and the retry then re-downloads from zero,
  turning one slow transfer into three. The old deadline sat *inside* the natural
  variance of a healthy transfer, which is why it was intermittent: measured locally
  against `download.mikrotik.com`, the same 52.2 MB all-packages zip took **118.4 s,
  94.2 s, 123.5 s and 82.2 s** on four consecutive attempts over the same link (and
  129.4 s on a fifth). All completed, but **one in four exceeded the flat 120 s** and
  another cleared it by 1.6 s — so an unchanged healthy download passed or failed on
  link jitter alone. CI's cold ~0.35 MB/s sits below that entire range, which is why a
  hosted runner hit it far more often. A transfer
  is now bounded by two deadlines and reports which one ended it — a **resettable stall
  deadline** (30 s of silence, reset on every chunk, so a moving transfer is never
  aborted for being slow) and an **outer transfer budget** derived from `content-length`
  and a named floor throughput of 120 000 B/s (so a trickle still terminates; 465 s for
  that same zip). Both paths now share one helper with one retry policy. Two new error
  codes carry bytes/expected/elapsed/throughput: `DOWNLOAD_STALLED` (retriable — a
  wedged socket usually moves on the next attempt) and `DOWNLOAD_TOO_SLOW` (terminal by
  design — the budget is already ~3× the slowest throughput ever measured, so retrying
  just spends it again on a link known to be slower than the floor). Downloads stream to
  `<dest>.part` and are renamed only after a length-verified transfer, so an interrupted
  download can no longer leave a truncated file that a later run treats as cached.
- **The guest snapshot in a failure report could never log in.** Its per-query budget
  was sized on the ~0.3 s cost of a command on an already-open serial session, leaving
  the ~11.4 s RouterOS login unbudgeted — and the executor then divided that budget
  across credential candidates, so no attempt could finish one. No credential was ever
  marked working, every later query repeated the same split, and the snapshot burned
  its full 60 s to report `console unreachable` about guests that were answering serial
  in 10 ms. It read as a broken console, which is why it survived on the boot path,
  where the guest usually *is* unreachable. Queries now carry a login allowance until
  one of them answers. Measured locally: a capture went from 61.1 s with 0 of 7 queries answered to
  14.4 s with 7 of 7. The 60 s snapshot budget and the 180 s forensics budget are
  unchanged, so no test timeout moves (#69).
- **`clean()` left credentials naming an erased user** (#79). `clean()` replaces the
  disk with a fresh image, but `machine.json` kept `user`, `managedSshKey`, and
  `disableAdmin` from the machine that disk used to hold — and nothing recreates
  them, because a post-`clean()` `start()` does not re-provision. Credential
  resolution kept preferring `state.user`, so every subsequent `rest()`, `exec()`,
  and SCP authenticated as a user RouterOS had deleted, and `inspect` advertised
  that dead account as the machine's login. Those three fields are now cleared with
  the disk, along with the stored instance credentials (already) and the managed
  keypair under `<machineDir>/ssh/`, leaving resolution on the factory fallback a
  fresh image actually answers to — `admin` with an empty password. Provisioning
  *intent* (`packages`, `deviceMode`, `secureLogin`) is not guest state and
  survives.
- **Serial console: large replies could come back empty** (#109). `consoleExec`
  ended a reply at the first prompt that had been followed by 150 ms of quiet, but
  RouterOS repaints prompt+command *before* emitting output — so on a guest that
  paused before the payload, the **redraw** terminated the read and the output was
  sliced away. It hit the biggest replies only: in the #79 forensics the `/log` and
  `/ip/service` queries returned `empty console reply` while the five smaller ones
  succeeded, blanking the field that investigation needed. Each command is now
  framed by a nonce sentinel the guest assembles itself
  (`:put ("QCHR" . "<nonce>" . "END")`), sent as its own console line so it still
  runs when the command fails — a `;` chain aborts and never reaches it. The prompt
  heuristic survives only as a fallback, and now requires the prompt to be
  *trailing* as well as stable, which rejects a redraw regardless of timing.
  `consoleExec` returns `framed`, so an empty reply that was framed ("RouterOS
  printed nothing") is no longer indistinguishable from one the reader lost.
- Serial console: output from a **long** command leaked its own echo. RouterOS
  scrolls a long input line horizontally instead of wrapping it, so the redraw does
  not contain the start of the command and the text-matching echo stripper gave up
  early. Echo removal is now structural.
- Boot forensics: the counting-rule probe discarded its own answer. A `packetsAfter`
  above zero proves the guest received the SYNs — the rule is created seconds
  earlier, so its counter necessarily starts at 0 — but an unreadable *pre*-probe
  reading forced the verdict to `inconclusive` anyway.
- CI: the CHR image cache never re-saved. `actions/cache` skips its post-job save on an
  exact key hit, so the static `chr-images-{OS}-{arch}-v1` key meant any RouterOS
  version resolved after the cache was first populated re-downloaded on *every* run.
  (The first fix rotated the key per run; see the cache-key entry under Changed for
  what replaced that.)
- CI: the examples smoke harness buffered child output until exit, so an example that
  hung until the per-test timeout produced no output at all. Output now streams with a
  per-example prefix, and both streams are printed on a non-zero exit.
- CI: every Linux and macOS integration artifact had been silently dropping
  `boot-log.ndjson`, `machine.json` and `qemu.log`. The POSIX data root lives under
  `~/.local/share/quickchr`, and `actions/upload-artifact` excludes hidden paths unless
  `include-hidden-files` is set — while the four non-hidden `~/*.txt` files kept
  matching, so `if-no-files-found: warn` never fired and the artifact looked healthy.

## [0.4.6] — 2026-07-27

> **Apple Silicon users: we would like your help confirming this.** The arm64 HVF
> panic below is grounded in a reporter's M4 diagnostics plus QEMU/Linux source, but
> nobody has reproduced it on a physical Apple Silicon Mac we control, and CI cannot
> — hosted macOS runners report `kern.hv_support=0` and never exercise HVF at all.
> `quickchr start --arch arm64 --accel hvf` is the one-command check. Whether it
> panics with `No working init found` **or boots**, please say so on
> [#97](https://github.com/tikoci/quickchr/issues/97) — a successful boot would be
> just as valuable, and would mean this fallback is scoped too broadly.

### Added

- **`--accel <auto|tcg|hvf|kvm>` on `start`/`add`, plus a matching `accel` setting
  and `QUICKCHR_ACCEL` env var.** Anything other than `auto` (the default) is passed
  to QEMU verbatim and bypasses accelerator detection entirely — including the
  arm64-on-Apple-Silicon TCG fallback below. Precedence follows the usual chain:
  flag > env > `quickchr.env` > built-in. This is the escape hatch for testing HVF
  against a future AArch64-only arm64 CHR image without a code change; forcing
  `--accel hvf` for an arm64 guest on Apple Silicon still prints the panic caveat.
  Issue #97.

### Fixed

- **arm64 CHR no longer kernel-panics on Apple Silicon** — `detectAccel("arm64")` now
  returns `tcg` on **every** Apple Silicon generation, and a one-line note at launch
  explains why. The cause is the shipped CHR image, not the accelerator: arm64 CHR
  (7.20.8 – 7.23beta5 verified) pairs an AArch64 kernel with a **32-bit ARM userspace**
  — the appended initramfs `/init` is `ELF 32-bit LSB ARM, EABI5`, and the 7.22.1
  `system` package holds 101 more ARM32 executables. Apple Silicon implements no
  AArch32 at any exception level and HVF passes the hardware `ID_AA64PFR0_EL1` through
  unmodified, so the guest kernel never sets `ARM64_HAS_32BIT_EL0`, `execve("/init")`
  returns `-ENOEXEC`, and Linux panics at t≈0.076 s with `No working init found`.
  TCG's emulated models do provide AArch32 EL0, so the same image boots.

  This **supersedes and widens** the unreleased `FEAT_SSBS`-based fallback: SSBS was a
  coincident marker of the M4 host that first reported the panic, not the mechanism
  (Linux 5.6 treats SSBS as optional and boots without it). That predicate left
  M1/M2/M3 on HVF and panicking. Because no macOS VMM can present a feature the
  silicon lacks, a QEMU-version floor is not a valid restore signal either — the
  restore signal is a future arm64 CHR image whose required userspace is AArch64
  throughout. Root-cause chain in `docs/m4-hvf-arm64-investigation.md`; originally
  reported in tikoci/mikropkl#11. Issue #97.

- **x86 CHR now also auto-selects TCG on Apple Silicon**, including when quickchr
  runs under Rosetta. HVF cannot virtualize an x86 guest on a physical arm64 host;
  `sysctl.proc_translated` distinguishes Rosetta from an Intel Mac. Explicit
  accelerator overrides still bypass this policy.

## [0.4.5] — 2026-07-18

### Changed

- Release CI now publishes from the committed `package.json` version instead of
  bumping `package.json`/`CHANGELOG.md` and pushing a release commit to protected
  `main` (issue #94). Maintainers promote the changelog and version before
  dispatching `release.yml`; the workflow gates that state, creates the GitHub
  Release/tag, and publishes npm.

### Fixed

- **Descriptor v1 now advertises the plain forwards (plain-first), not the TLS ones**
  (issue #95). 0.4.4's secure-preferred order pointed `services["rest-api"]` /
  `services["native-api"]` at endpoints that are not dialable on a stock CHR:
  `www-ssl` is disabled by default and `api-ssl` is certificate-less (TLS handshake
  alert 40; grounded on CHR 7.23.2). The descriptor now picks `http`/`api` — the same
  ports `restUrl` has always used — falling back to `https`/`api-ssl` (with
  `tls: true`) only when the plain forward is excluded. First surfaced by the first
  real consumer, `tikoci/centrs#134` `--quickchr` CHR acceptance.

## [0.4.4] — 2026-07-18

### Added

- Provisioning now verifies the managed SSH key with a real host-OpenSSH batch login
  (`BatchMode=yes`, `PasswordAuthentication=no`) and persists the result on the machine
  as `managedSshKey` (`{ privateKeyPath, algorithm, batchVerified }`). Best-effort: a
  failed verification never aborts provisioning. Settles the managed-key algorithm as
  `ed25519` (grounded from RouterOS 7.12+; issue #74).

### Changed

- **`ChrInstance.descriptor()` / `quickchr inspect` restructured to descriptor v1**
  (issue #71) — **breaking change** to the `MachineDescriptor` public type, accepted
  pre-1.0 since no external consumers depend on the old shape yet. The flat
  `ports`/`urls`/`auth`/`env` blob is replaced by `Descriptor`: a versioned
  (`descriptorVersion: 1`), per-service `services` map (`rest-api`, `native-api`, `ssh`)
  with `tls`, availability, and provenance, plus optional `customForwards` (e.g.
  `winbox`) and topology-only `networks`. This is the structured contract
  `tikoci/centrs#134` (`--quickchr <name>`) resolves connection facts through — full
  shape and mapping rules in [`docs/centrs-interface.md`](docs/centrs-interface.md).
  The `env` field is dropped from the descriptor entirely: `quickchr env` now calls
  `ChrInstance.subprocessEnv()` directly instead of reading `descriptor().env`
  (`subprocessEnv()` itself is unchanged).
- `installSshKey` failures now surface RouterOS's console rejection output and throw a
  typed `QuickCHRError` instead of a plain `Error`.
- Managed SSH key verification now matches the generated key's RouterOS row by
  comment/fingerprint and runs OpenSSH with `IdentitiesOnly=yes` plus an ignored
  ssh_config (`-F` to the platform null device), preventing older user keys or
  agent/config identities from producing a false verified result.

### Fixed

- Linux/arm64 TCG managed SSH key provisioning no longer reports a false install
  failure when the first `/rest/user/ssh-keys` listing takes longer than 5 seconds.
  The listing check now has one 30-second convergence budget and reports its attempt
  count and elapsed time when the cold path is slow.
- Windows: the managed SSH key's batch-login verification (`batchVerified`) no longer
  fails 100% of the time. `ssh -F <null-device>`, used to suppress `ssh_config`,
  isn't honored by Win32-OpenSSH's config-file loader (`Can't open user config file
  NUL`); it now points `-F` at a real empty file instead, which works identically on
  every platform. The failed probe's `ssh` output is also now logged instead of
  collapsing to a bare `false` (issue #87).

## [0.4.3] — 2026-07-06

### Added

- **Boot-history log + boot timing fields** (issue #30) — every successful boot appends
  `{ts, name, version, arch, accel, bootMs, host}` to `<dataDir>/boot-log.ndjson`
  (rotated at 1000→500 lines), and `machine.json` gains `lastAccel`/`lastBootMs`.
  Feeds the CI metrics scheme (`ci-data` branch); locally useful to answer
  "how slow are my boots" per accel/version.
- **`quickchr settings` command** (issue #46) — a small user-scoped settings framework for 5
  previously-hardcoded defaults: `default-channel`, `default-arch`, `cache-max-size`,
  `timeout-extra`, `secure-login`. Stored in `~/.config/quickchr/quickchr.env` (dotenv-style).
  Precedence: CLI flag > `QUICKCHR_<KEY>` env var > `quickchr.env` > built-in default.
  `add`/`start`, the setup wizard's channel/arch selection, and the post-boot cache
  auto-prune cap all now consult these. Never mutates `machine.json`; refuses to hold
  credential-shaped values (mirrors `tikoci/centrs`'s `settings` precedent). New
  `quickchr settings print|get|set|reset` verbs; see MANUAL.md §3/§11/§14.
- **`routeros-quickchr` agent skill** (in `tikoci/routeros-skills`) — a pointer-heavy guide for
  AI agents (and anyone) on grounding RouterOS config/scripts/API against a real router with
  quickchr: the apply→read-back loop, the by-goal networking decision table, the harness
  connection-surface, and grounding gotchas. Cross-linked from `routeros-qemu-chr`.
- **Three runnable examples** — `examples/grounding/` (apply config via `exec()` → read back via
  `rest()` → assert; re-run-safe via a per-run nonce), `examples/harness/` (drive an external
  child process against a live CHR via `subprocessEnv()`/`descriptor()`), and `examples/dude/`
  (install the `dude` package and ground its config, x86). All verified on real CHR (7.23.1).
- **UDP port-range forwarding** (issue #18) — `--forward name:hostStart-hostEnd[:guestStart-guestEnd][/proto]`
  expands to one `hostfwd` per port, for L3 peers with dynamic data ports (e.g. btest).
  New `expandForwardSpec()` export (range-aware; `parseForwardSpec()` stays single-port)
  plus `FORWARD_RANGE_MAX`. Host range is required and capped at 64 ports.
- **Networking recipes guide** (`docs/networking-recipes.md`) — a "which mechanism for
  which traffic shape" decision table, linked from README/MANUAL and surfaced in JSDoc.
- **Guest→host UDP gateway recipe** — receiving UDP a CHR *sends* (syslog, NetFlow, TZSP,
  or a server reply) needs no forward: the guest targets `10.0.2.2` and the host binds an
  *unconnected* loopback socket. Verified end-to-end (`test/lab/gateway-udp/REPORT.md`),
  with a runnable example (`examples/udp-gateway/`). Generalizes the existing
  `ChrInstance.tzspGatewayIp` primitive beyond TZSP.

### Changed

- **CI system refactored end-to-end** (issue #29) — one reusable integration workflow
  (`integration.yml`, dispatchable per platform × RouterOS target × test filter) replaces
  the old `verify-extended.yml`/`publish.yml` duplication. Integration tests moved off
  PRs onto every push to `main`, with a required PR "Integration freshness" gate; weekly
  all-platform sweep; daily new-RouterOS-version check that auto-tests never-seen
  versions; boot/test timing collected to the `ci-data` branch; releases are now a
  one-click `release.yml` dispatch (replacing `bun run release`/`scripts/release.ts` —
  the `release` package script is gone). Repo is squash-merge-only. Contributor-facing:
  see CONTRIBUTING.md "Pull Requests & Merging" and "Releasing".
  Follow-up round: TCG platforms (windows-x86, macos-x86) now run the **full suite by
  default** on dispatches — `platforms=all` really means everything (the old implicit
  anchor-smoke narrowing reported green on ~2-minute legs); smoke is opt-in via the new
  `tcg-smoke` input (the weekly sweep uses it to cap cost). `tested-versions.json` now
  credits exactly a run's target version — never versions booted incidentally by
  upgrade/pinned-channel tests — and `ci-metrics refold` rebuilds the rollup from the
  per-run files. Manual dispatches collect metrics by default.
- **Wizard channel default** (issue #46) now resolves the same way `add`/`start` do (`stable`
  when not configured, or the `default-channel` setting) instead of a hardcoded `long-term`,
  fixing a pre-existing inconsistency between the two entry points. The "recommended for
  provisioning" hint on `long-term` is unchanged. The wizard's architecture prompt and login
  prompt now similarly reflect the `default-arch`/`secure-login` settings.
- **`quickchr start --timeout-extra 0`** is now honored as an explicit zero instead of being
  silently treated as if the flag were omitted (incidental fix while wiring the new
  `timeout-extra` setting; issue #46).
- **`DESIGN.md`/`MANUAL.md`** storage-layout diagrams corrected: the documented-but-never-
  implemented `$QUICKCHR_DATA_DIR/quickchr/config.json` is replaced with the real
  `~/.config/quickchr/quickchr.env` (issue #46).
- **JSDoc parity** on the networking option types (`StartOptions.networks`/`extraPorts`,
  `NetworkSpecifier`, `PortMapping`, `tzspGatewayIp`) — maps specifiers to goals, documents
  UDP/range forwards, and notes the CLI↔library equivalence, so consumers don't have to read
  `network.ts` to discover capabilities (issue #18).
- Tightened `qemu-args` anchor assertions (single `-M`, `-m`/`-smp` values, `-drive` +
  headless `-display none`, indexed `-netdev`/`-drive` lookup, TCG-branch coverage) and added
  an empty-body `resolveVersion` → `INVALID_VERSION` case. Folds in the sound parts of the
  closed AI-findings PRs (#6/#8/#9).

### Fixed

- **arm64 snapshots never worked — savevm failed silently, loadvm wedged the guest**
  (issue #31). QEMU refuses `savevm` while the EFI-vars pflash is a writable raw file;
  the per-machine vars are now a qcow2 pflash (legacy machines migrate in place, NVRAM
  preserved), so `snapshot.save()/load()` genuinely work on arm64. Three masking layers
  fixed alongside: monitor responses are cleaned of command echo/ANSI so `Error:` lines
  reach the error checks, `snapshot.save()` throws instead of fabricating an entry when
  the snapshot is absent from `info snapshots`, and a failed `loadvm` issues `cont` so
  the guest is never stranded in `paused (restore-vm)`. Full evidence chain in
  `test/lab/arm64-rollback/REPORT.md`.
- **`secureLogin` was silently dropped when starting an already-`add()`-created machine**
  (issue #46) — `QuickCHR.start()`'s "first boot of an add()-created machine" path computed
  its own `hasPending` provisioning check without `secureLogin`, and didn't fall back to the
  value stored in `machine.json` the way sibling fields (`user`, `disableAdmin`, etc.) already
  did. This meant `--secure-login` (and the new `secure-login` setting/`QUICKCHR_SECURE_LOGIN`
  env var) had no effect at all for the standard `add` then `start <name>` workflow — only a
  single combined `add --secure-login` immediately followed by boot worked. Found via the new
  `secure-login` setting's integration test; fixed by including `secureLogin === true` in the
  pending-provisioning check and adding the missing `?? existing.secureLogin` fallback.
- **Wizard "quickchr managed login" never actually provisioned the managed account**
  (issue #46) — the wizard's `userChoice === "managed"` branch only set `disableAdmin: true`,
  never `secureLogin: true`, and `provision()` only auto-creates the replacement `quickchr`
  account when `secureLogin` is explicitly `true`. Choosing the recommended "managed login"
  option in the wizard could disable the default admin account with no replacement login
  provisioned at all. Fixed by setting both fields together; the decision logic is now a pure,
  directly unit-tested `resolveUserChoiceOptions()` export in `src/cli/wizard.ts`.
- **`quickchr start --all` ignored `timeout-extra`/`secure-login` entirely** (issue #46) — the
  bulk-restart path called `QuickCHR.start({ name, background: true })` directly, bypassing
  the settings/env/flag resolution the single-target path used. Both bulk and single-target
  restarts now share the same `resolveTimeoutExtraMs()`/`resolveSecureLoginFlag()` helpers.
- **An invalid `--timeout-extra` value silently became `NaN`** (issue #46) — e.g.
  `--timeout-extra abc` flowed through as `StartOptions.timeoutExtra: NaN`, serializing as
  `null` in `--dry-run` output and potentially causing an immediate boot-timeout cleanup on a
  real start. The flag is now validated with the same non-negative-integer rule the
  `timeout-extra` setting itself uses (shared `parseTimeoutExtraSeconds()`), while an explicit
  `--timeout-extra 0` is still correctly honored as zero, not "omitted."
- **`-T` (the documented short alias for `--timeout-extra`) never actually worked** (issue #46,
  found while adding test coverage for the previous fix) — `parseFlags()` only recognizes `--`
  prefixed flags; a bare `-T 15` fell through entirely into positional args and was silently
  ignored. Fixed with a small `applyTimeoutExtraShortFlag()` helper (same pattern `cmdLogs`
  already uses for its own `-f`/`-n` single-dash aliases), with unit coverage.
- **`quickchr settings print` crashed on a single malformed value** instead of showing the rest
  of the table (issue #46) — the all-keys path resolved each key with the strict
  `resolveSetting()` rather than the already-tested tolerant `settingsPrint()` helper. Now uses
  `settingsPrint()`, with CLI-level regression coverage (`test/unit/cli-settings.test.ts`).
- **`cache-max-size`/`timeout-extra` settings metadata contradicted their own documented
  defaults** (issue #46) — `quickchr settings print` showed `(unset)` for both even though
  MANUAL.md and the CLI's own help text documented concrete defaults (`2G`/`0`). Both now have
  a real `builtinDefault` (`DEFAULT_CACHE_MAX_BYTES` / `0`) — every consumer already treated
  "unset" and these exact values identically, so this is display-only, not a behavior change.
  `secure-login` intentionally keeps no `builtinDefault`: the wizard needs to distinguish "not
  configured" from "explicitly false" to know whether to still recommend managed login.

### Security

- All workflows now declare least-privilege `permissions: contents: read`
  (`ci.yml`, `publish.yml`, `verify-extended.yml`); the publish job keeps its per-job
  `id-token: write`. Clears the CodeQL `actions/missing-workflow-permissions` findings.
- The `test/lab/mndp/*` probes no longer pass network-derived data (`srcMac(frame)`) as a
  `console.log` format string (CodeQL `js/tainted-format-string`), and `ethToUdpPayload` now
  guards `udpLen >= 8`.

## [0.4.2] — 2026-06-21

### Added

- Public version/channel API for CI consumers (issue #3). The package entry
  (`@tikoci/quickchr`) now re-exports `resolveVersion`, `resolveAllVersions`,
  `parseVersionParts`, `compareRouterOsVersion`, `isValidVersion`,
  `isProvisioningSupportedVersion`, `CHANNELS`, and the `Channel` type — no more
  blocked deep `src/lib/...` imports.
- Recency-aware channel API: `resolveChannelStatuses()` / `classifyChannels()`
  classify each channel by `maturity` (`released` | `prerelease`) and
  `aheadOfStable`; `resolveActiveChannels()` / `selectActiveChannels()` return the
  channels currently worth booting — every released channel plus any pre-release at
  or ahead of a reference channel (default `stable`). The pure `classifyChannels` /
  `selectActiveChannels` take a `Record<Channel, string>` for network-free use.
  This answers "what's worth booting," never "what must pass" — gate policy stays
  with the consumer.
- `quickchr version --json` emits a `{ channel: version }` object (offline → `{}`).
- `quickchr doctor --json` emits `{ ok, checks, staleImages }`; exit code still
  reflects `ok`.

### Fixed

- `compareRouterOsVersion` now orders RouterOS pre-release suffixes:
  `7.24beta2` < `7.24rc1` < `7.24` < `7.24.1` (previously the `beta`/`rc` suffix was
  stripped, so those compared **equal**). **Behavior change** for callers that
  compared pre-release versions; release-vs-release comparisons (cache-prune,
  doctor stale-image check) are unaffected.

## [0.4.1] — 2026-06-17

### Fixed

- Downloads now resolve MikroTik's `upgrade`/`download` hosts via public DNS
  and connect over IPv4, so `resolveVersion()` and image/package downloads work
  on GitHub-hosted CI runners. Those runners' system resolver returns
  `ESERVFAIL` (slowly, 2–26 s) for `*.mikrotik.com` via both `getaddrinfo` and
  c-ares-over-`resolv.conf`, which made a plain `fetch` time out or fail with
  `errno: 0` before any CHR booted. New `fetchResilient()` (`src/lib/net.ts`)
  queries `1.1.1.1`/`8.8.8.8` directly (3 s timeout), connects to the IPv4
  literal with `Host` + TLS SNI preserved, and falls back to a normal `fetch`
  when public DNS is blocked. Consuming projects (e.g. centrs) need no
  `/etc/hosts` workaround. See DESIGN.md decision #9.

## [0.4.0] — 2026-06-07

First stable release on the `latest` track since 0.2.0 — rolls up the 0.3.x
pre-release line (`waitFor`, `captureInterface`, `tzspGatewayIp`, `portBase`)
plus the changes below.

### Added

- `StartOptions.noAuth` — convenience alias for `secureLogin: false`. Skip the
  managed `quickchr` user provisioning and leave admin password-less. Self-
  documenting alternative for callers who found `secureLogin: false` cryptic.
  When both are set, an explicit `secureLogin` value wins.
- `MachineState.secureLogin` is now persisted (was silently dropped in
  `start()` and add() state construction). Pre-0.3.1 machines are unaffected
  — the field is optional and defaults to undefined on read.
- `ChrInstance.exec()` JSDoc — documents the single-command-per-call rule
  (`/rest/execute` runs the input as one statement; multi-line `\n` strings
  may execute only the first line) and the soft-error pattern (RouterOS may
  return HTTP 200 with an error string in `output`, e.g. `/dude/agent/add`).
- `MANUAL.md` — new "ChrInstance at a glance" table grouping every method
  by purpose (identity, capture, lifecycle, comms, provisioning, files,
  snapshots, diagnostics). The reference block also now lists `portBase`,
  `captureInterface`, `tzspGatewayIp`, `waitFor()`, `upload()`, `download()`
  which had been added without a docs update.

### Changed

- `QuickCHR.start()` / `QuickCHR.add()` now warn (via the progress logger)
  when a channel name (`"stable"`, `"long-term"`, `"testing"`, `"development"`)
  is passed in the `version` field. Behavior is unchanged — the value still
  resolves as a channel — but the warning steers callers toward the
  self-documenting `channel:` field. JSDoc on `StartOptions.version` updated
  to call out the lenient acceptance.

## [0.3.0] — 2026-04-23

### Added

- `ChrInstance.waitFor(condition, timeoutMs?)` — polling helper that calls an
  async condition every 2 s, swallows errors, and resolves `true` when the
  condition passes or `false` on timeout. Replaces ad-hoc polling loops in lab
  scripts.
- `ChrInstance.captureInterface` — `"lo0"` on macOS, `"any"` on Linux; the
  correct `-i` value for `tshark` when capturing TZSP in QEMU user-mode
  networking. Previously callers had to hardcode the platform-specific value.
- `ChrInstance.tzspGatewayIp` — always `"10.0.2.2"` (QEMU slirp host gateway);
  the correct target for RouterOS `/tool/sniffer` streaming and RouterOS
  routing-server addresses to reach the host.
- `ChrInstance.portBase` — convenience alias for `state.portBase`, exposing the
  instance's collision-free port block base without requiring callers to access
  `state` internals.

## [0.2.0]

- Shell completions for bash, zsh, and fish (`quickchr completions`)
- Snapshot support: save, load, delete, list (`quickchr snapshot`)
- Disk management: `--boot-size`, `--add-disk`, `quickchr disk`
- Multi-NIC networking: `--add-network user|shared|bridged:<iface>|socket::<name>|tap:<iface>`
- Named virtual sockets for L2 inter-VM tunnels (`quickchr networks sockets`)
- `quickchr exec` — run RouterOS CLI commands via REST, QGA, or serial console
- `quickchr console` — attach to serial console of a running instance
- `quickchr get` — query live machine config (license, device-mode, credentials)
- `quickchr logs` — tail QEMU log with optional `--follow`
- Device-mode provisioning (`--device-mode`, `--device-mode-enable`, `--device-mode-disable`)
- CHR trial license provisioning (`--license-level`)
- Managed login with auto-generated credentials (`--no-secure-login` to opt out)
- Package install from `all_packages.zip` (`--add-package`, `--install-all-packages`)
- Provisioning version guardrails: post-boot provisioning requires RouterOS ≥ 7.20.8
- `quickchr clean` — reset disk to fresh image
- `quickchr status` — detailed instance info with credentials and connection tips
- CI: Linux x86_64 + aarch64 integration tests, macOS runners via dispatch
- CI: Windows unit tests on `windows-latest`
- CI: coverage enforcement (75% functions / 60% lines, warn-only)
- Library API: `QuickCHR.start()`, `ChrInstance` with `stop/remove/rest/exec/qga/snapshot/serial`
- `ChrInstance.upload()` / `.download()` — first-class SCP push/pull to a running CHR (uses instance credentials, no `sshpass` needed)
- `StartOptions.arch` now accepts `"auto"` as an explicit synonym for omission — both resolve to `hostArchToChr()`

### Fixed

- `arch: "auto"` silently falling through to arm64 (qemu-binary selector is a two-way switch). `resolveArch()` now normalizes `"auto"` and `undefined` to the host arch; agents no longer hit 480s TCG boot timeouts when they spell out the default.
- Bun connection pool stale-response bugs (all CHR REST now uses `node:http` + `agent: false`)
- Bun `req.destroy()` not emitting error event (timeout pattern with `done` flag)
- License error classification: `"ERROR: ..."` in HTTP 200 body now throws immediately
- Boot timeout auto-cleanup: failed boots remove QEMU process + state automatically
- `secureLogin` default changed to `false` (explicit opt-in, not surprise provisioning)

## [0.1.1] - 2026-04-20

- First GitHub release as `tikoci/quickchr`. Pre-release per the odd/even
  policy above: GitHub Actions CI has not yet run end-to-end against the
  hosted repo. Promote to `0.2.0` only after a green CI run on `main`.
- Not yet published to npm. Install from the GitHub repo (`bun add github:tikoci/quickchr`)
  or by cloning. The npm publish workflow exists (`.github/workflows/publish.yml`)
  but is gated on tagging `v0.2.0`.
