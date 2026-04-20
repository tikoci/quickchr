# quickchr Manual

> Audit-style reference for what quickchr actually does today. README is the
> elevator pitch and quickstart; DESIGN.md is the architecture rationale;
> this MANUAL is the complete, source-checked map of every CLI command,
> library API, and provisioning step.

## Table of Contents

1. [What quickchr is](#1-what-quickchr-is)
2. [Install & doctor](#2-install--doctor)
3. [CLI command reference](#3-cli-command-reference)
4. [Library API reference](#4-library-api-reference)
5. [Provisioning pipeline](#5-provisioning-pipeline)
6. [Channels — REST, monitor, serial, QGA, console](#6-channels--rest-monitor-serial-qga-console)
7. [Networking](#7-networking)
8. [Storage layout](#8-storage-layout)
9. [Port layout](#9-port-layout)
10. [Acceleration & timeouts](#10-acceleration--timeouts)
11. [Auth, secrets, environment variables](#11-auth-secrets-environment-variables)
12. [Exec — running RouterOS commands](#12-exec--running-routeros-commands)
13. [Disks & snapshots](#13-disks--snapshots)
14. [Errors & recovery](#14-errors--recovery)
15. [Cross-references](#15-cross-references)

---

## 1. What quickchr is

A **CLI plus importable library** for managing MikroTik CHR (Cloud Hosted
Router) virtual machines on macOS, Linux, and (experimentally) Windows.
quickchr wraps QEMU directly — it is **not** an orchestrator. Each
invocation manages one CHR instance; multi-router topologies are composed
by the user (or their AI agent) using `quickchr` as a building block.

**Scope boundary** (see DESIGN.md §Scope Boundary):

- ✅ Download CHR images, manage QEMU lifecycle, expose REST/SSH/WinBox
  ports, persist machine state, run RouterOS CLI commands, install
  packages, apply trial licenses, switch device-mode.
- ❌ Multi-router topology orchestration, test-matrix runners,
  configuration-as-code DSLs. Use `examples/` as references and compose
  yourself.

**Two ways to use it:**

- `quickchr <command>` — the CLI. Git-style subcommands plus an interactive
  setup wizard (`quickchr setup`).
- `import { QuickCHR } from "@tikoci/quickchr"` — the library. Returns
  `ChrInstance` handles for programmatic control.

---

## 2. Install & doctor

### Prerequisites

| Component | Required for | Install |
|---|---|---|
| Bun ≥ 1.1 | runtime | <https://bun.sh> |
| `qemu-system-x86_64` | x86 CHR | brew/apt/dnf/pacman/winget |
| `qemu-system-aarch64` | arm64 CHR | brew/apt/dnf/pacman/winget |
| `qemu-img` | `--boot-size`, `--add-disk`, snapshots | usually packaged with QEMU |
| UEFI firmware (edk2) | arm64 CHR | `qemu-efi-aarch64` (apt), `edk2-aarch64` (dnf), bundled with `qemu` (brew) |
| `socket_vmnet` (optional) | rootless `shared`/`bridged` networking on macOS | `brew install socket_vmnet` |
| `socat` (optional) | piping serial console externally | brew/apt |
| `sshpass` (optional) | future SSH exec transport | brew/apt |

### Install quickchr

The first GitHub release is **0.1.1** — pre-release per the changelog's
odd/even policy. Not yet on npm.

```bash
# Library
bun add github:tikoci/quickchr

# CLI from source (until npm publish)
git clone https://github.com/tikoci/quickchr
cd quickchr
bun install
bun run dev -- doctor
```

Once `0.2.0` is published to npm:

```bash
bun install -g @tikoci/quickchr
```

### `quickchr doctor`

Reports prerequisite status, accelerator availability, image cache
size, machine count, free disk space, and shell-completion install
state. Exit code is `0` when no checks return `error` (warnings are OK).

```bash
quickchr doctor              # human-readable
```

Use this whenever a `start` fails — the diagnostic almost always points
at a missing dependency, missing firmware, or insufficient disk.

---

## 3. CLI command reference

The dispatcher lives in `src/cli/index.ts` (lines 121–194). Help text is
available for every command via `quickchr help <command>`.

### Lifecycle

#### `add [name]`

Create a machine without starting it. Materializes the machine
directory, downloads the RouterOS image (cached), and writes
`machine.json` with all provisioning options stored for later.

| Flag | Default | Notes |
|---|---|---|
| `--name <s>` | auto | `host-arch-N` if omitted |
| `--version <ver>` | latest in channel | e.g., `7.22.1` |
| `--channel <ch>` | `stable` | `stable`, `long-term`, `testing`, `development` |
| `--arch <a>` | host native | `arm64` or `x86` |
| `--cpu <n>` | `1` | vCPU count |
| `--mem <mb>` | `512` | RAM (cross-arch TCG bumps to `1024`) |
| `--boot-disk-format <f>` | `qcow2` | `qcow2` or `raw` |
| `--boot-size <size>` | — | Resize boot disk; needs `qemu-img`; auto-converts to qcow2 |
| `--add-disk <size>` | — | Extra blank qcow2 disk; repeatable |
| `--add-package <pkg>` | — | Provisioning, repeatable, ≥ 7.20.8 |
| `--install-all-packages` | false | Provisioning, ≥ 7.20.8 |
| `--add-user <user:pass>` | — | Provisioning, ≥ 7.20.8 |
| `--disable-admin` | false | Provisioning, ≥ 7.20.8 |
| `--secure-login` / `--no-secure-login` | unset | Provisioning, ≥ 7.20.8 |
| `--license-level <l>` | — | `p1`, `p10`, `unlimited`, ≥ 7.20.8 |
| `--license-account <a>` | env `MIKROTIK_WEB_ACCOUNT` | MikroTik.com email |
| `--license-password <p>` | env `MIKROTIK_WEB_PASSWORD` | |
| `--device-mode <m>` | — | `rose`, `advanced`, `basic`, `home`, `auto`, `skip`, ≥ 7.20.8 |
| `--device-mode-enable <f,...>` | — | Repeatable, comma-separated |
| `--device-mode-disable <f,...>` | — | Repeatable, comma-separated |
| `--add-network <spec>` | `user` | See §7. Repeatable. |
| `--no-network` | false | Headless, no NICs |
| `--no-winbox` | false | Exclude WinBox port |
| `--no-api-ssl` | false | Exclude API-SSL port |
| `--port-base <n>` | auto from 9100 | First port of the 10-port block |

`--vmnet-shared` and `--vmnet-bridge <iface>` are deprecated aliases for
`--add-network shared` / `--add-network bridged:<iface>`.

#### `start [name]`

Boot a stopped machine, or create-and-boot in one command. Blocks until
REST is ready (background mode, default), or attaches QEMU stdio to your
terminal (`--fg`). Accepts the same provisioning flags as `add`.

Additional flags:

| Flag | Notes |
|---|---|
| `--all` | Start every stopped machine in background |
| `--bg` / `--background` | (default) detach QEMU; return after boot |
| `--fg` / `--foreground` (alias `--no-bg`, `--no-background`) | Serial console on stdio |
| `--install-deps` | Auto-install missing host deps (calls package manager) |
| `--timeout-extra <s>` / `-T <s>` | Add extra seconds to computed boot timeout |
| `--dry-run` | Print resolved options and QEMU command, exit |

Foreground mode shortcuts (QEMU mux):

| Key | Action |
|---|---|
| `Ctrl-A X` | Quit QEMU |
| `Ctrl-A C` | Toggle monitor (`quit` to force-stop from monitor) |
| `Ctrl-A H` | Help |

When `--fg` is combined with provisioning options, quickchr boots
**background** first, runs provisioning, then **stops** and re-launches
foreground with stdio attached. This is observable as a brief stop in
machine state.

#### `stop [name | --all]`

Graceful shutdown via QEMU monitor. Updates `state.status = "stopped"`
and unregisters socket-named networks. Listing-mode if no name and not
`--all`.

#### `remove [name | --all]` (alias `rm`)

Stops if running, deletes the machine directory, and clears per-instance
credentials from the secret store.

#### `clean <name>`

Resets the machine to a fresh image: stops QEMU, re-copies the boot
image from cache, recreates extra disks per the saved config, deletes
EFI vars (UEFI re-initializes), and clears per-instance credentials.
Provisioning options remain in `machine.json` and re-run on next `start`.

### Inspection

#### `list [name]` (alias `ls`, `status`)

Without a name: tabular summary of every machine. With a name: detailed
view including credentials and connection tips. `--json` for
machine-readable output.

#### `get <name> [license | device-mode | admin] [--json]`

Live REST query. Hits the running CHR and returns the requested group
(or all if no group specified). Requires the machine to be running.

#### `disk [name]`

Shows stored disk layout. With `qemu-img` installed, also reports
virtual + actual sizes for each disk.

#### `logs <name> [--follow] [-n N]`

Tail the per-machine `qemu.log`. `--follow` streams new output;
`-n` limits to last N lines.

#### `networks` (alias `net`)

`networks` enumerates host interfaces and their alias resolution
(`wifi`, `ethernet`, `auto`). `networks sockets` lists registered
named L2 sockets; `networks sockets create <name>` reserves a port for a
new tunnel.

#### `version`

Print quickchr version (matches `package.json`).

### Interaction

#### `exec <name> <command> [--via=auto|rest|qga|console|ssh] [--user u] [--password p] [--timeout=ms]`

Run a RouterOS CLI command. See §12 for transport details and JSON
output trick.

#### `console <name>`

Attach to the QEMU serial socket. Exit with `Ctrl-A X` (or `Ctrl-]` if
the underlying transport is socat). Requires the machine to be running.

#### `qga <name> <subcommand> [args...]`

Direct QEMU Guest Agent commands (`ping`, `info`, `osinfo`, `hostname`,
`time`, `timezone`, `network-interfaces`, `fsfreeze-status`, `exec`,
`file-read`, `file-write`, `shutdown`).

QGA is **x86 only and KVM only**. ARM64 CHR doesn't ship the agent;
macOS HVF and any TCG fallback don't initialize the virtio channel
(see `docs/qga-x86-macos-qemu10-investigation.md` for the QEMU bug).

### Configuration

#### `license <name> [--level p1|p10|unlimited]`

Apply or renew a CHR trial license on a running instance. Resolves
MikroTik.com credentials from `--license-account`/`--license-password`,
the env vars, or the secret store. Requires RouterOS ≥ 7.20.8.

#### `set <name> <subcommand>`

Currently exposes a small surface for in-place changes (e.g.,
`set <name> license …`). The `set/get` architecture is still being
designed; expect additions.

#### `snapshot <name> <list | save [snapname] | load <snapname> | delete <snapname>>` (alias `snap`)

Internal qcow2 snapshots. `save` requires the machine running (`savevm`
goes through QEMU monitor). `list` and `delete` work in either state
(uses `qemu-img info` when stopped). Requires `bootDiskFormat: qcow2`.

### Meta

#### `setup`

Interactive wizard (`@clack/prompts`) that walks through machine
creation, network selection, user/admin setup, optional license, and
device-mode. Loops with a main menu so users can create multiple
machines or tweak settings. Runs by default when `quickchr` is invoked
with no command and stdout is a TTY.

The wizard never sets `secureLogin: true` directly — the "managed login"
choice sets `disableAdmin: true` and the provisioning step auto-creates
the `quickchr` user from that signal.

#### `completions [bash|zsh|fish]`

Print or install shell completions. With no arg, detects current shell.

### Global behavior

| Env var | Effect |
|---|---|
| `QUICKCHR_DATA_DIR` | Override the data root (defaults to `$XDG_DATA_HOME/quickchr` or platform equivalent — see §8) |
| `QUICKCHR_NO_PROMPT` | Force non-interactive mode (skips all wizards) |
| `QUICKCHR_DEBUG` | Emit `[debug]` lines from the progress logger |
| `QUICKCHR_INTEGRATION` | Required to run `test/integration/` |
| `MIKROTIK_WEB_ACCOUNT`, `MIKROTIK_WEB_PASSWORD` | License credentials fallback |
| `NO_COLOR` | Disable ANSI styling |

`--json` is honored on `list`, `status`, `get`, `snapshot`, and a few
others — check `quickchr help <command>`. Errors are caught at the top
level and exit `1` with a `[code] message` line plus the install hint
when present.

---

## 4. Library API reference

Public exports are in `src/index.ts`. The two surfaces you use are the
`QuickCHR` class (machine lifecycle) and the `ChrInstance` interface
(per-instance operations).

### Static methods on `QuickCHR`

```ts
QuickCHR.start(opts?: StartOptions): Promise<ChrInstance>
QuickCHR.add(opts?: StartOptions): Promise<MachineState>
QuickCHR.list(): MachineState[]
QuickCHR.get(name: string): ChrInstance | null
QuickCHR.doctor(): Promise<DoctorResult>
QuickCHR.resolveVersion(channel: Channel): Promise<string>
```

`start()` creates the machine if needed, downloads the image, allocates
a port block, spawns QEMU, waits for REST readiness, and runs all
provisioning steps before returning. It auto-cleans the machine if boot
times out (calls `stop()` then `remove()`). It acquires `start-lock` to
serialize concurrent starts of the same machine.

`add()` is the same minus the QEMU spawn — useful when you want to
materialize a machine and start it later (or hand the config to another
process).

`get()` returns `null` if the machine doesn't exist; otherwise it
loads `machine.json`, refreshes PID liveness, and returns a runtime
handle. `list()` is `get()` for everything in `machines/`.

### `ChrInstance`

```ts
interface ChrInstance {
  name: string;
  state: MachineState;        // full persisted config
  ports: ChrPorts;            // {http, https, ssh, api, apiSsl, winbox, ...}
  restUrl: string;            // http://127.0.0.1:{ports.http}
  sshPort: number;

  waitForBoot(timeoutMs?: number): Promise<boolean>;
  stop(): Promise<void>;
  remove(): Promise<void>;
  clean(): Promise<void>;
  destroy(): Promise<void>;   // stop + remove

  rest(path: string, opts?: RequestInit): Promise<unknown>;
  exec(cmd: string, opts?: ExecOptions): Promise<ExecResult>;

  monitor(cmd: string): Promise<string>;
  serial(): { readable: ReadableStream; writable: WritableStream };
  qga(cmd: QgaCommand, args?: object): Promise<unknown>;

  license(opts: LicenseOptions): Promise<void>;
  setDeviceMode(opts: DeviceModeOptions, log?: ProgressLogger): Promise<void>;
  availablePackages(): Promise<string[]>;
  installPackage(pkgs: string | string[]): Promise<string[]>;

  snapshot: {
    list(): Promise<SnapshotInfo[]>;
    save(name?: string): Promise<SnapshotInfo>;
    load(name: string): Promise<void>;
    delete(name: string): Promise<void>;
  };

  queryLoad(): Promise<ChrLoadSample | null>;
  subprocessEnv(): Promise<Record<string, string>>;
}
```

`rest()` retries up to 3 times with 2s backoff on `ECONNRESET` (RouterOS
transiently resets connections post-boot/reboot). HTTP errors and
`QuickCHRError` from the REST layer are NOT retried.

`subprocessEnv()` returns env-var keys (`QUICKCHR_NAME`,
`QUICKCHR_REST_URL`, `QUICKCHR_REST_BASE`, `QUICKCHR_SSH_PORT`,
`QUICKCHR_AUTH`, plus legacy `URLBASE`/`BASICAUTH`) so child processes
can hit the CHR without re-resolving auth.

### `StartOptions` (selected)

| Field | Type | Default | Notes |
|---|---|---|---|
| `name` | string | auto | Must not start with `-` |
| `version` | string | — | Mutually exclusive with `channel` |
| `channel` | Channel | `"stable"` | |
| `arch` | `"arm64" \| "x86"` | host | |
| `cpu` | number | `1` | |
| `mem` | number | `512` (1024 cross-arch TCG) | MiB |
| `background` | boolean | `true` | |
| `bootDiskFormat` | `"raw" \| "qcow2"` | `"raw"` (auto-`qcow2` if `bootSize`) | |
| `bootSize` | string | — | e.g., `"512M"`, `"2G"`. Needs `qemu-img` |
| `extraDisks` | string[] | `[]` | Each entry is a size string |
| `networks` | NetworkSpecifier[] | `["user"]` | See §7 |
| `portBase` | number | auto | First of 10 ports |
| `excludePorts` | ServiceName[] | `[]` | e.g., `["winbox"]` |
| `extraPorts` | PortMapping[] | `[]` | Custom forwards |
| `packages` | string[] | `[]` | Provisioning |
| `installAllPackages` | boolean | `false` | Provisioning |
| `user` | `{ name, password }` | — | Provisioning |
| `disableAdmin` | boolean | `false` | Provisioning |
| `secureLogin` | boolean | `false` | **`true` is the explicit trigger** for managed-account creation |
| `license` | `LicenseInput` | — | `"p1"` / `"p10"` / `"unlimited"` or `LicenseOptions` |
| `deviceMode` | `DeviceModeOptions` | — | `{mode?, enable?[], disable?[]}` |
| `installDeps` | boolean | — | Auto-install missing OS deps |
| `dryRun` | boolean | `false` | Print QEMU command and exit |
| `timeoutExtra` | number | `0` | Extra **milliseconds** added to boot timeout |
| `onProgress` | `(msg) => void` | `console.log` | `[debug]` lines only when `QUICKCHR_DEBUG=1` |

Provisioning fields trigger a version check at the top of `start()` /
`add()`: any provisioning option on RouterOS < 7.20.8 throws
`PROVISIONING_VERSION_UNSUPPORTED`.

See `src/lib/types.ts` for the full type surface (ChrPorts, MachineState,
NetworkConfig, NetworkSpecifier, PortMapping, ExecOptions, ExecResult,
DeviceModeOptions, LicenseInput/Level/Options, DoctorResult,
SnapshotInfo, ChrLoadSample, ErrorCode, plus QGA result types).

The barrel also re-exports utility functions from `auth.ts`, `disk.ts`,
`exec.ts`, `qga.ts`, `console.ts`, `license.ts`, `credentials.ts`,
`packages.ts`, `network.ts`, `log.ts`. Use them when the high-level
class doesn't fit (typically not needed).

---

## 5. Provisioning pipeline

Everything below the boot wait runs in **background** mode regardless of
the user's `--fg` choice; if foreground was requested, quickchr stops
QEMU after provisioning and re-launches with stdio attached.

**Version gate:** RouterOS ≥ 7.20.8 (first long-term baseline). Any
provisioning option on an older image throws
`PROVISIONING_VERSION_UNSUPPORTED` upfront. Boot, disk, networking, and
port mappings work on any 7.x.

**Order of operations** (`_provisionInstance` in `src/lib/quickchr.ts`):

1. **Packages** — `installAllPackages` or `packages[]` triggers SCP
   upload of `.npk` files to the SSH port, then `/system/reboot`.
   quickchr waits 2× the normal boot timeout (package init takes
   longer). Persists the installed list to `state.packages`.
2. **Device-mode** — applies `deviceMode.mode` / `enable[]` / `disable[]`
   via REST. RouterOS requires a hard power-cycle to confirm; quickchr
   kills QEMU and restarts it. The blocking REST call returns
   ECONNRESET when QEMU is killed — this is suppressed and treated as
   success after the verification read-back. Persisted to
   `state.deviceMode`.
3. **License** — `/system/license/renew` with `account`, `password`,
   `level`, `duration=10s` so the server-side wait fits in a single
   call. Read-back confirms the actual applied level and persists it
   to `state.licenseLevel`. Errors come back inside HTTP 200 bodies as
   `status: "ERROR: …"` strings — quickchr classifies these as
   immediate failures (no retry).
4. **User & admin** — only runs when `user` is set OR `disableAdmin` is
   true OR `secureLogin === true`. Creates the custom user and/or the
   auto-generated `quickchr` managed account, optionally disables admin,
   stores the password in the per-instance secret file, and writes the
   user's name to `machine.json` (real password is NEVER written there).
   Disabling admin **does not** lock the REST API — RouterOS's `expired`
   flag only gates CLI/SSH/Winbox login, not REST.

Each step is independent. A failure in step N stops further steps but
does not roll back N–1. Re-running `start` re-applies pending
provisioning from `machine.json` only if the machine had not been fully
provisioned previously.

**Always read back what we wrote.** This catches version-specific drift
in REST responses and surfaces actionable errors instead of silent
state corruption.

The post-boot REST race (early endpoints can return wrong/empty bodies
even after `waitForBoot` returns) is handled per-endpoint: license,
device-mode, identity, and user reads each poll for field presence
with 15–30s deadlines. `waitForBoot` itself uses a two-consecutive-OK
guard on `/system/resource`.

---

## 6. Channels — REST, monitor, serial, QGA, console

Every running instance exposes five host-facing channels. Names map to
absolute file paths under `<machineDir>/`; on Windows they are named
pipes (`\\.\pipe\…`).

| Channel | Purpose | Transport (POSIX) | Transport (Windows) |
|---|---|---|---|
| REST | RouterOS HTTP API | TCP `127.0.0.1:{ports.http}` | same |
| QEMU monitor | `info cpus`, `quit`, `savevm`, etc. | Unix socket `monitor.sock` | named pipe |
| Serial | RouterOS serial console | Unix socket `serial.sock` | named pipe |
| QGA (x86 only) | guest agent commands | Unix socket `qga.sock` | named pipe |
| QEMU log | stdout/stderr of QEMU itself | file `qemu.log` | same |

**REST** is what `chr.rest()` and `chr.exec({via: "rest"})` use. It
**must** go through `src/lib/rest.ts` (which uses `node:http` with
`agent: false`) — Bun's `fetch()` connection pool reuses sockets after
machine restarts and returns stale responses. See
`.github/instructions/bun-http.instructions.md`.

**Monitor** is for QEMU itself, not RouterOS. `instance.monitor("info
cpus")` returns the raw text. quickchr uses it internally for
`stop()`, `snapshot.save/load/delete`, and `queryLoad()`.

**Serial** is a bidirectional byte stream to the RouterOS console. Both
`chr.serial()` (returns streams) and `quickchr console <name>` (attaches
stdio) use it. Serial-based `exec` (`--via=console`) does prompt
detection plus buffer-offset tracking; works in restricted environments
where REST is unavailable, slower than REST.

**QGA** uses a JSON-line protocol (`guest-sync-delimited` first, then
`guest-exec`, etc.). Available **only** on x86 CHR running under KVM.
ARM64 CHR doesn't ship the agent; macOS HVF (and any TCG run) don't
initialize the virtio-serial channel correctly — that's a QEMU 10.x
behavior documented in `docs/qga-x86-macos-qemu10-investigation.md`.

**QEMU log** captures everything QEMU itself writes, including boot
panics, EFI errors, and signal traces. `quickchr logs <name>` tails it.

---

## 7. Networking

Each `--add-network <spec>` adds one NIC. Without any flag, you get a
single user-mode NIC (SLiRP) on `ether1`. Order matters: `user` should
always be `ether1` because RouterOS auto-creates a DHCP client only on
the first interface, and SLiRP's built-in DHCP needs the
`10.0.2.15` address to make `hostfwd` work (see DESIGN.md
§SLiRP-must-be-ether1 and `test/lab/slirp-hostfwd/`).

### Specifiers

| Spec | What it does | Root needed? | Cross-VM? | Host-visible? |
|---|---|---|---|---|
| `user` | SLiRP user-mode NAT, hostfwd port mapping | no | no | via hostfwd ports only |
| `socket::<name>` | L2 socket pair between two VMs sharing the name | no | yes | no |
| `socket-listen:<port>` / `socket-connect:<port>` / `socket-mcast:<group>:<port>` | low-level QEMU socket netdevs | no | yes | no |
| `shared` | NAT'd L3 with DHCP from the host | yes (or `socket_vmnet` rootless) | yes | yes |
| `bridged:<iface>` | L2 bridged onto host iface | yes (or `socket_vmnet` rootless) | yes | yes |
| `tap:<iface>` | pre-created TAP, no quickchr setup | depends | yes | yes |
| `wifi`, `ethernet`, `auto` (alias) | resolves to detected host iface | as above | | |

Resolution chains:

- **`shared`** on macOS: socket_vmnet daemon → vmnet-shared (root-only QEMU). On Linux: pre-created TAP owned by the user, else root-created TAP+bridge.
- **`bridged:<iface>`** on macOS: socket_vmnet bridged → vmnet-bridged (root). On Linux: TAP attached to a bridge containing the named iface.

### Named L2 sockets

`quickchr networks sockets create lab-sw1` reserves a port and stores
metadata in `<dataDir>/networks/lab-sw1.json`. Two machines using
`--add-network socket::lab-sw1` form an L2 tunnel: the first to start
listens on the port; the second connects.

quickchr unregisters socket members on `stop`/`remove`/`clean` so port
allocation can recycle.

For platform internals (vmnet quirks, TAP creation, bridged-mode
restrictions, half-open SLiRP under TCG), see `docs/networking.md`.

---

## 8. Storage layout

### macOS / Linux (XDG)

```text
$XDG_DATA_HOME/quickchr/  (defaults to ~/.local/share/quickchr/)
├── cache/                       Downloaded RouterOS images
│   ├── chr-7.22.1.img.zip
│   ├── chr-7.22.1.img
│   └── chr-7.22.1-arm64.img
├── machines/
│   └── <name>/
│       ├── machine.json         Persisted MachineState
│       ├── disk.img | disk.qcow2
│       ├── extra-disk-*.qcow2
│       ├── efi-vars.fd          arm64 only (UEFI vars)
│       ├── monitor.sock         QEMU monitor
│       ├── serial.sock          serial console
│       ├── qga.sock             QGA (x86 only)
│       ├── qemu.pid
│       ├── qemu.log
│       ├── start-lock           start serialization
│       └── ssh/id_ed25519[.pub] SSH key (if managed user provisioned)
├── networks/                     Named L2 socket reservations
│   └── <name>.json
└── config.json                   Global config (rare)
```

`$XDG_DATA_HOME` defaults to `~/.local/share/quickchr/`. Override the
whole tree with `QUICKCHR_DATA_DIR=/some/path`.

### Windows

```text
%LOCALAPPDATA%\quickchr\
├── cache\
├── machines\<name>\
│   ├── machine.json
│   ├── disk.img
│   ├── monitor (named pipe handle, no on-disk file)
│   └── …
└── …
```

Falls back to `%USERPROFILE%\AppData\Local\quickchr\` if `LOCALAPPDATA`
is unset.

### Credentials (separate from data dir)

- **Per-instance CHR credentials**: file in the user config dir
  (`~/.config/quickchr/secrets.json` on POSIX; not the OS keychain — a
  Keychain dialog hangs in non-TTY contexts like tests and CI).
- **MikroTik.com web account** (for license operations): tries
  `Bun.secrets` (OS keychain) when interactive, falls back to the same
  config-file store otherwise.

Both honor explicit CLI flags / env vars first.

---

## 9. Port layout

Each instance reserves a contiguous **block of 10 ports** starting at
`portBase`. Default base is `9100`; auto-allocator scans existing
machines and TCP-probes for a free block.

| Offset | Service | Guest port |
|---|---|---|
| +0 | HTTP / REST / Webfig | 80 |
| +1 | HTTPS | 443 |
| +2 | SSH | 22 |
| +3 | API | 8728 |
| +4 | API-SSL | 8729 |
| +5 | WinBox | 8291 |
| +6 | (reserved — QEMU monitor TCP, when used) | — |
| +7 | (reserved — serial TCP, when used) | — |
| +8 | (reserved — QGA TCP, when used) | — |
| +9 | (spare — `extraPorts`) | — |

Defaults map the first six offsets. `--no-winbox`, `--no-api-ssl`, and
`excludePorts: ["…"]` skip individual mappings. `extraPorts:
[{name,host,guest,proto}]` adds custom forwards in offsets 6–9.

If port `9100` is in use, the next instance gets `9110`, etc. Manual
override via `--port-base`.

---

## 10. Acceleration & timeouts

`detectAccel()` selects the fastest available accelerator for each
arch:

| Host | Guest | Accel |
|---|---|---|
| macOS x86_64 | x86 | HVF |
| macOS x86_64 | arm64 | TCG |
| macOS arm64 (native bun) | arm64 | HVF |
| macOS arm64 (native bun) | x86 | TCG |
| macOS arm64 (Rosetta bun) | arm64 | TCG |
| Linux x86_64 + `/dev/kvm` writable | x86 | KVM |
| Linux aarch64 + `/dev/kvm` writable | arm64 | KVM |
| any other combo | any | TCG |

`Bun` running under Rosetta on Apple Silicon reports `process.arch ===
"x64"`, so HVF for arm64 is skipped (architecture mismatch). Run with
native arm64 Bun to get arm64 HVF.

### Boot timeout

```text
base = ceil(120s × accelTimeoutFactor(accel, isCrossArch))
withPackages ? base × 2 : base
final = base + (timeoutExtra ms)
```

Native (HVF/KVM): factor ~1 → 120s base.
Cross-arch TCG: factor ~15 → up to 1800s.
Package install adds a 2× multiplier (extra reboot cycle).

If boot times out, the machine is **automatically stopped + removed**.
Use `--timeout-extra` to add a buffer if you know your host is slow.

---

## 11. Auth, secrets, environment variables

**Threat model:** quickchr is a test/dev harness. The privilege boundary
is "any process running as the user that owns the data dir." We protect
against:

- Off-box access via bridged/NAT'd interfaces (RouterOS ships with empty
  admin password by default; managed login mitigates this).
- Accidental credential leakage in commits, CI logs, CLI output.

We **don't** protect against same-user code reading
`secrets.json`, `ps`-visible CLI args, or memory inspection.

### Auth resolution (`resolveAuth`)

Priority order, used by `chr.rest()`, `chr.exec()`, and
`subprocessEnv()`:

1. Explicit `--user` / `--password` (or `opts.user` / `opts.password`).
2. `state.user.name` from `machine.json` + password from secret store.
3. CHR default `admin` with empty password.

`disableAdmin: true` does NOT block REST API access — the `expired`
flag only gates CLI/SSH/Winbox login (and even there it's bypassable
with Ctrl-C). Don't add workarounds for the "expired admin" myth.

### Secret stores

- **Per-instance CHR creds**: config-file only (~/.config/quickchr/`).
  Bun.secrets triggers a Keychain dialog in headless contexts that
  never resolves.
- **MikroTik.com creds**: Bun.secrets when TTY is available; same
  config file otherwise.

### Environment variables consumed

| Var | Where |
|---|---|
| `QUICKCHR_DATA_DIR` | `state.ts` — overrides data root |
| `QUICKCHR_NO_PROMPT` | CLI dispatcher — forces non-interactive mode |
| `QUICKCHR_DEBUG` | progress logger — emits `[debug]` lines |
| `QUICKCHR_INTEGRATION` | `bun:test` gate for `test/integration/` |
| `MIKROTIK_WEB_ACCOUNT` | license-renewal account (fallback) |
| `MIKROTIK_WEB_PASSWORD` | license-renewal password (fallback) |
| `NO_COLOR` | disable ANSI styling |
| `LOCALAPPDATA`, `USERPROFILE`, `HOME` | data-dir base resolution |

### Environment variables `subprocessEnv()` sets

For child processes you want to point at the CHR:

```text
QUICKCHR_NAME       machine name
QUICKCHR_REST_URL   http://127.0.0.1:{ports.http}
QUICKCHR_REST_BASE  same plus /rest
QUICKCHR_SSH_PORT   ports.ssh
QUICKCHR_AUTH       user:password
URLBASE             legacy alias for QUICKCHR_REST_URL
BASICAUTH           legacy header value
```

---

## 12. Exec — running RouterOS commands

`quickchr exec <name> <command>` and `chr.exec(command, opts)` both
funnel through the same transport selector.

### Transports

| `--via` | Source | Notes |
|---|---|---|
| `auto` (default) | tries REST, falls back to **console** on network errors (not auth errors) | Best general choice |
| `rest` | `POST /rest/execute` with `{"script": "…", "as-string": ""}` | RouterOS 7.1+. Synchronous (any value for `as-string` enables sync mode; presence is what counts). 60s server-side timeout. |
| `console` | serial socket with prompt detection + buffer offset tracking | Fallback for restricted environments. Uses `\r` (not `\r\n`) on PTY. |
| `qga` | QGA `guest-exec` | x86 + KVM only. Throws `QGA_UNSUPPORTED` on ARM64. |
| `ssh` | reserved | Currently throws `EXEC_FAILED`; planned. |

### Output formatting

`exec` does NOT have a `--json` flag. Use the RouterOS-native trick:

```bash
quickchr exec my-chr ":put [:serialize to=json [/ip/address/print]]"
```

`:serialize` accepts `json`, `yaml`, `dsv`, `tsv`, `csv`. Wrap any CLI
command in it to get structured output. The exec result body is the
literal stdout — no quickchr processing.

### Authentication

Same `resolveAuth()` chain as REST. Override on the CLI with
`--user u --password p`, or in the library with `{user, password}` in
`ExecOptions`.

### Timeouts

`opts.timeout` defaults to 30s for QGA/console and 10s for REST when
running under `auto` (so the fallback to console kicks in quickly).
On explicit `--via=rest`, the 60s server-side `as-string` cap is the
ceiling.

---

## 13. Disks & snapshots

### Boot disk

Default format is **raw** (the image MikroTik ships). `--boot-size`
auto-converts to **qcow2** before the first boot and resizes to the
requested size. Requires `qemu-img` on the host.

`--boot-disk-format=qcow2` (without `--boot-size`) just keeps the
default size but enables snapshots.

### Extra disks

`--add-disk <size>` (repeatable) creates blank qcow2 images and attaches
them as additional virtio-blk-pci devices. RouterOS sees them as
`ether2`/`disk2`/etc. depending on whether you've also added NICs.
`quickchr disk <name>` shows the layout; with `qemu-img` it also reports
virtual + actual sizes.

### `clean`

`quickchr clean <name>` re-copies the boot image from cache and
recreates extra disks per `machine.json`. Snapshots are gone (they live
inside the qcow2 file). Per-instance credentials are wiped so the next
boot re-provisions them.

### Snapshots

Use the QEMU monitor via `instance.snapshot`:

```ts
await chr.snapshot.save("before-upgrade");
await chr.snapshot.load("before-upgrade");
await chr.snapshot.list();
await chr.snapshot.delete("before-upgrade");
```

CLI:

```bash
quickchr snapshot my-chr save before-upgrade
quickchr snapshot my-chr list
```

Constraints:

- Boot disk must be qcow2.
- `save` and `load` need the machine running (uses `savevm`/`loadvm`).
- `list` and `delete` work either way (`qemu-img info` when stopped).
- Snapshots live inside the qcow2 file, so `remove` deletes them all.
- QEMU's practical cap is 16 snapshots per disk.

---

## 14. Errors & recovery

Every library throw is `QuickCHRError(code, message, installHint?)`.
The CLI catches it and prints `[code] message` plus the install hint if
present, then exits `1`.

### Codes

| Code | Likely cause | First check |
|---|---|---|
| `MISSING_QEMU` | host arch QEMU binary not on PATH | `quickchr doctor` |
| `MISSING_FIRMWARE` | edk2 UEFI firmware not installed (arm64) | install `qemu-efi-aarch64` / `edk2-aarch64` |
| `MISSING_UNZIP` | image extraction needs `unzip` | install OS package |
| `PORT_CONFLICT` | no free 10-port block | stop a machine or set `--port-base` |
| `BOOT_TIMEOUT` | CHR didn't respond within timeout | check `qemu.log`; under TCG, raise `--timeout-extra`; machine is **auto-removed** |
| `DOWNLOAD_FAILED` | image fetch failed | retry; check connectivity to MikroTik download server |
| `INVALID_VERSION` / `INVALID_ARCH` / `INVALID_NAME` / `INVALID_DISK_SIZE` | argument parse | fix the value |
| `MACHINE_EXISTS` | name already in `machines/` | choose another name or `QuickCHR.get(name)` |
| `MACHINE_NOT_FOUND` | name not in `machines/` | `quickchr list` |
| `MACHINE_RUNNING` / `MACHINE_STOPPED` | wrong lifecycle state | `start` or `stop` first |
| `MACHINE_LOCKED` | another `start` in progress | wait or pick another name |
| `EXEC_FAILED` | RouterOS rejected the command (auth, syntax) | check creds, command syntax |
| `PROCESS_FAILED` | QEMU spawn / reboot / verify failed | check `qemu.log`, host resources |
| `SPAWN_FAILED` | exec/spawn of host binary failed | check binary exists + executable |
| `QGA_UNSUPPORTED` | QGA on ARM64 | use `--via=rest` or `--via=console` |
| `QGA_TIMEOUT` | QGA daemon unreachable | KVM-only; not on macOS HVF or TCG |
| `NETWORK_UNAVAILABLE` | provisioning needs `user` NIC, none present | add `--add-network user` |
| `INVALID_NETWORK` | unknown alias / unresolvable iface / dead socket daemon | `quickchr networks` |
| `PROVISIONING_VERSION_UNSUPPORTED` | provisioning option on RouterOS < 7.20.8 | use `--channel long-term` or pin a `7.20.8+` version |
| `INSUFFICIENT_DISK_SPACE` | host data dir full | free space or move via `QUICKCHR_DATA_DIR` |
| `STATE_ERROR` | snapshot on raw boot disk | recreate with `--boot-disk-format=qcow2` |

### Auto-cleanup on boot timeout

If `start()` hits `BOOT_TIMEOUT`, quickchr automatically calls
`stop()` then `remove()` on the failing instance. You'll see a
diagnostic and the machine will be gone from `quickchr list`. This
prevents orphan disks accumulating across attempts.

### Where to look

1. `quickchr doctor` — prerequisites, accelerator, disk space.
2. `quickchr logs <name>` — QEMU's own stderr/stdout, including boot
   panics, EFI errors, signal traces.
3. `<machineDir>/machine.json` — last-known state, ports, options.
4. `bun run check` — type/lint regressions if you've been editing.
5. `.github/instructions/` — agent-facing rules with deeper
   troubleshooting matrices for QEMU, RouterOS REST, provisioning,
   testing, CI, and Bun HTTP quirks.

---

## 15. Cross-references

- **README.md** — quickstart, install, simple examples.
- **DESIGN.md** — architecture, layers, port/storage tables, design
  principles (scope boundary, networking philosophy, SLiRP-must-be-ether1,
  exec transport design, examples philosophy).
- **CHANGELOG.md** — release history; `[Unreleased]` is the working
  set, `[0.1.1]` is the first GitHub release.
- **CONTRIBUTING.md** — dev setup and `bun run check`.
- **docs/networking.md** — platform-specific QEMU networking
  internals (vmnet, TAP, socket netdevs).
- **docs/qga-x86-macos-qemu10-investigation.md** — root cause for the
  QGA-on-macOS-arm64 limitation.
- **`.github/instructions/`** — agent-facing rules (testing, qemu,
  routeros-rest, provisioning, ci, bun-http, general).
- **`examples/`** — runnable references (`vienk` single-CHR smoke,
  `matrica` parallel version matrix).
- **BACKLOG.md** — open work and design questions still under
  discussion. Completed items are git history.
