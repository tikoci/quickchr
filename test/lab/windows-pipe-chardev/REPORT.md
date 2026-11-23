# Windows `-chardev pipe` for monitor, serial and QGA

Issue: [#57](https://github.com/tikoci/quickchr/issues/57), the spike in the
maintainer's 2026-11-21 comment.

## Verdict

**NO.** On windows-latest with QEMU 11.1.0, a `-chardev pipe` channel serves
exactly one client for the life of the VM. After that client disconnects, every
reconnect fails: 0/50 for the monitor, 0/50 for serial and 0/50 for QGA, in both
runs. The pipe chardev also stops QEMU from starting until each pipe has a
client. So `-chardev pipe` can't replace the Windows IPC ports; whether +6..+8
stays reserved on every OS is still open on #57 (see "AF_UNIX" below).

There's a separate finding that bears on the same decision. **AF_UNIX sockets
(`-chardev socket,path=…`) did reconnect on Windows**: 50/50 for the monitor and
50/50 for serial in both runs, with quickchr's own `node:net` client. That's a
second route to dropping the Windows IPC ports, but it needs its own decision
(see "AF_UNIX" below). QGA didn't reconnect on any transport on Windows,
including today's TCP (see "QGA" below).

## Setup

| | |
| --- | --- |
| Runner | `windows-latest`, image `win25-vs2026 20261116.315.1` (Windows Server 2025 Datacenter, 10.0.26100), 4 vCPU |
| QEMU | `11.1.0 (v11.1.0-12130-ge470268ff4)`, installed with `choco install qemu` (the same step as `integration.yml`'s windows-x86 leg) |
| Bun | 1.4.4 (`.bun-version`) |
| Guest | CHR 7.25.1 x86 (stable at the time), TCG, 512 MiB, 1 vCPU |
| Harness | `probe.ts` in this directory, `lab.yml` job `windows-pipe-chardev`, one leg per arm |
| Runs | [44945337412](https://github.com/tikoci/quickchr/actions/runs/44945337412) (commit `988ccfe`), [44946995156](https://github.com/tikoci/quickchr/actions/runs/44946995156) (commit `521e009`) |

Exact argv for the pipe arm (run 2, machine A). The other arms differ only in the
three `-chardev` specs. Later probe revisions bind hostfwd to `127.0.0.1`:

```text
qemu-system-x86_64 -name lab-a-b9yk -M pc -m 512 -smp 1 -accel tcg,tb-size=256
  -drive file=D:\a\_temp\lp\lab-a-b9yk\disk.img,format=raw,if=virtio
  -netdev user,id=net0,hostfwd=tcp::9300-:80 -device virtio-net-pci,netdev=net0
  -display none
  -chardev pipe,id=monitor0,path=quickchr-lab-a-b9yk-monitor -mon chardev=monitor0,mode=readline
  -chardev pipe,id=serial0,path=quickchr-lab-a-b9yk-serial -serial chardev:serial0
  -device virtio-serial-pci,id=virtio-serial-qga
  -chardev pipe,id=qga0,path=quickchr-lab-a-b9yk-qga
  -device virtserialport,chardev=qga0,name=org.qemu.guest_agent.0,id=qga-port0
```

| Arm | `-chardev` spec (monitor shown) | Client endpoint |
| --- | --- | --- |
| `pipe` (the question) | `pipe,id=monitor0,path=quickchr-<name>-monitor` | `\\.\pipe\quickchr-<name>-monitor`, the name `channelPath()` already produces |
| `tcp` (control, production today) | `socket,id=monitor0,host=127.0.0.1,port=<base+6>,server=on,wait=off` | `127.0.0.1:<base+6>` |
| `unix` (extra) | `socket,id=monitor0,path=<dir>\monitor.sock,server=on,wait=off` | `<dir>\monitor.sock` |

Every client is `node:net` `connect()`, the call `channels.ts`, `console.ts` and
`qga.ts` make. The `pipe` arm also used .NET `NamedPipeClientStream` as an
independent client.

Each trial is one fresh connection: connect (5 s timeout), run one command, then
disconnect:

- **monitor:** wait for `(qemu)`, send `info status`, and expect `running`.
- **serial:** reach the CLI prompt, logging in as admin if needed, then run
  `:put [/system identity get name]` framed by a sentinel (the same scheme as
  `consoleExec`). Expect the machine's name, which was set over serial at boot.
- **QGA:** send `guest-sync-delimited` and `guest-ping`, and wait 3 s for a
  `"return"`. That is what the runs below used. Any `"return"` passed, including
  the sync reply. No Windows trial got one, so the 0/50 results stand. The
  probe now requires the sync reply with its id, then the ping's own reply.

## Results

### Reconnect trials (machine A, 50 per channel, after the boot-time clients closed)

| Arm | Channel | Run 1 | Run 2 | Failure mode | Latency (ok trials, run 2) |
| --- | --- | --- | --- | --- | --- |
| pipe | monitor | 0/50 | 0/50 | connect timeout, 5 s, every trial | — |
| pipe | serial | 0/50 | 0/50 | connect timeout, 5 s, every trial | — |
| pipe | QGA | 0/50 | 0/50 | connect timeout, 5 s, every trial | — |
| pipe | monitor, machine B | 0/10 | 0/10 | connect timeout, 5 s | — |
| tcp | monitor | **50/50** | **50/50** | — | p50 53 ms, max 55 ms |
| tcp | serial | **50/50** | **50/50** | — | p50 78 ms, max 79 ms |
| tcp | QGA | 0/50 | 0/50 | `ECONNREFUSED` (run 2: 1 connect, then refused) | — |
| unix | monitor | **50/50** | **50/50** | — | p50 53 ms, max 54 ms |
| unix | serial | **50/50** | **50/50** | — | p50 78 ms, max 79 ms |
| unix | QGA | 0/50 | 0/50 | 4–5 connects with no reply, then `ECONNREFUSED` | — |

Latency runs from connect to the reply arriving. Run 1 timed through the client's
close instead, and every successful trial took 554–581 ms because of the
harness's 500 ms close fallback. Run 2 measures `cmdMs` separately. There were
no hangs: every failure ended at its timeout or was refused at once.

Further pipe-arm checks on machine A (both runs unless a run is named):

- **A longer wait doesn't help (run 2).** Two monitor reconnects with a 40 s
  timeout each failed after 30.0 s with `ECONNREFUSED`. The 30 s is libuv
  giving up on `WaitNamedPipe`.
- **The failure isn't specific to Bun.** Three .NET `NamedPipeClientStream.Connect(3000)`
  attempts on the monitor pipe, made after the first client closed, each failed
  with "The semaphore timeout period has expired" (`ERROR_SEM_TIMEOUT` from
  `WaitNamedPipe`).
- **The QEMU process keeps running.** It was still alive at the end, about 15
  minutes after the channels went dead. A bare `fetch()` of
  `/rest/system/identity` through hostfwd then got `HTTP 200` with each
  machine's own name, the identity set over serial at boot (run 2's log). That
  is consistent with the guest staying responsive, but it is supporting
  evidence only: the probe didn't check the body at the time, and Bun's
  connection pool can return a stale response (`bun-http.instructions.md`).
  Later probe revisions record `guestHttpResponsive` only for a 200 whose
  name matches. The channels are lost; the process isn't.

### First client and startup (pipe)

- **QEMU blocks at startup until each pipe has a client.** With no client
  connected, at 0, 2, 4, 6, 8 and 10 s after spawn only `quickchr-<name>-monitor`
  existed, and the hostfwd port wasn't listening. Connecting the monitor made the
  serial pipe appear, and connecting serial made the QGA pipe appear. Only then
  did the guest boot (`Login:` 15–21 s later).
- **Each boot-time client works.** On it, the monitor answered `info name`
  with the machine name and `info status` with `running`. Serial logged in, set
  the identity and read it back. QGA connected but never replied (see "QGA").
- **A second client is refused while the first is connected.** It got a 5 s
  connect timeout on all three channels. The first client kept working: monitor
  `info status` and serial identity still answered.

### Two machines at once (pipe)

Machines A and B ran concurrently on the same runner, with pipes named
`quickchr-<name>-<channel>`. Each machine's monitor `info name` returned its own
name, and each machine's serial identity read back its own name. REST on each
machine's port returned that same identity. **The names didn't collide.** A third
QEMU started with A's monitor pipe name failed in about 0.1 s:
`Failed CreateNamedPipe: All pipe instances are busy.` A duplicate name is
therefore a loud startup error, not a silent steal.

### tcp and unix: concurrent client

With one client connected, a second TCP or AF_UNIX connect *succeeds* (into the
listen backlog) but receives nothing. The first client keeps working. After both
close, a fresh client works again for the monitor and serial (run 2 checked this
after the trials). This is the current production behaviour on TCP.

## Why the pipe arm fails (mechanism, from QEMU source)

`chardev/char-pipe.c`, `win_chr_pipe_init()` on `_WIN32`, as of current QEMU
master. The file's 2025–2026 commits are API refactors (`.chr_open()` return
value, handler naming), not behaviour changes:

- `CreateNamedPipe(…, MAXCONNECT /* 1 */, …)` creates a single pipe instance.
- `ConnectNamedPipe` followed by `GetOverlappedResult(…, bWait=TRUE)` blocks
  chardev creation until a client connects. This explains the startup block
  above. Inferred from the observed ordering (the serial pipe appears only after
  the monitor connects, and hostfwd isn't bound until all three do): chardevs
  are created in argv order, before the netdev.
- After that, only `win_chr_pipe_poll()` (`PeekNamedPipe`) runs. Nothing ever
  calls `DisconnectNamedPipe` or `ConnectNamedPipe` again. Once the client goes
  away, the one instance stays in a disconnected state and no new client can
  attach. Clients see `ERROR_PIPE_BUSY` and time out in `WaitNamedPipe`.

The runs match this code path. Inferred: no client-side or quickchr-side change
can work around it. It would take a long-lived process holding each pipe
open, acting as a broker for every quickchr invocation, and that is a daemon
quickchr doesn't have.

## AF_UNIX on Windows (extra arm, not the question asked)

QEMU 11.1.0 on Windows accepted `-chardev socket,path=D:\…\monitor.sock,server=on,wait=off`.
Bun 1.4.4's `node:net` `connect({ path })` reached it, even though the same call
treats `\\.\pipe\…` names as named pipes. Monitor and serial passed 100/100
fresh-connection trials each across two runs, with latency the same as TCP.

If quickchr adopted this, the open points are:

- **On the tested combination, 107 ASCII bytes passed and 108 failed** (the
  client's connect got `EINVAL`), measured in run
  [45220066588](https://github.com/tikoci/quickchr/actions/runs/45220066588) (see
  "sun_path on Windows" below). A realistic quickchr path fits only with a short
  name. The longest allowed name does not fit.
- **Evidence is one runner image and one Bun version.** AF_UNIX needs Windows 10
  1803 or later. Behaviour on older Bun, and on Node consumers of the library,
  is untested.
- `channelPath()` / `channelEndpoint()` would change on Windows. That is a
  production change and out of scope for this lab.

## sun_path on Windows (#57 follow-up)

Run [45220066588](https://github.com/tikoci/quickchr/actions/runs/45220066588): windows-latest,
QEMU 11.1.0 (choco), Bun 1.4.4, `unix` arm with `--work` set to the real data-dir layout
(`C:\Users\runneradmin\AppData\Local\quickchr\machines`). It first starts a bare QEMU per
path length, with only a monitor socket at a path of exactly that many ASCII bytes, then
runs the full arm with the machine named so that its monitor socket sits at the longest
length that worked.

| path bytes | QEMU | socket file | `node:net` connect | monitor `info version` |
|---|---|---|---|---|
| 100, 104, 106, 107 | starts | created | ok | answers |
| 108 | starts | created | **`EINVAL`** | — |
| 109, 110, 130 | exits 1: `UNIX socket path '…' is too long` | — | `ENOENT` | — |

- **107 bytes was the most a client could use on this combination** (windows-latest,
  QEMU 11.1.0, Bun 1.4.4, ASCII paths). QEMU accepts 108 (it fills all 108 bytes of
  `sun_path` without a terminating NUL) but Bun's connect rejects that path with `EINVAL`.
  On Linux both QEMU and the client accept 108 (local run, QEMU 11.1.2), so Windows is one
  byte shorter. Inferred, not tested: Winsock's `connect` requires the NUL inside
  `sun_path`.
- **At 107 bytes the channels behave as on short paths.** Monitor 50/50 (p50 53 ms) and
  serial 50/50 (p50 78 ms) fresh-connection trials, a second client while the first was
  connected, and a bare `fetch()` through hostfwd at the end that got `HTTP 200` with the
  serial-set identity (supporting evidence only, as above). QGA refused as in every other Windows
  run (see the next section).
- **What fits** (arithmetic from the measured limit, not a run). quickchr's channel path is
  `C:\Users\<user>\AppData\Local\quickchr\machines\<name>\monitor.sock`: 55 bytes plus the
  user and machine names, so `len(user) + len(name)` must be at most 52 bytes. On the
  runner (`runneradmin`, 11) a name can have 41 bytes. Machine names may have 64, and
  profile folders named for domain accounts (such as `jane.doe.CORP`) are common, so the default layout
  fails for long names on many real machines. Non-ASCII user names take more than one
  byte per character (inferred; tested with ASCII only).
- **What this leaves open for #57.** Under the default layout, AF_UNIX on Windows
  doesn't fit every allowed name. The options are a shorter socket location (for
  example a hash of the machine dir under `%LOCALAPPDATA%\qc\`), a refusal at create
  time for a path over 107 bytes (as `socket-registry.ts` already does for inter-VM
  sockets), or keeping the TCP IPC ports. That choice belongs to #57, not this lab.

## QGA on Windows (all arms)

QGA never answered `guest-ping` on any arm. That fits the known limit:
RouterOS only opens the guest-agent port under KVM (`qga.ts` header, DESIGN.md).
What's new is that the host side doesn't stay connectable either. On **tcp and
unix**, QGA accepted the boot-time client plus 0–5 further clients, then refused
every later connect with `ECONNREFUSED`. This happened in both runs, including
run 2, where nothing else touched QGA before the trials. Monitor and serial on
the same QEMU kept reconnecting. On Linux with KVM (local dry-run of this
harness), 5/5 TCP and 3/3 AF_UNIX QGA trials connected and received QGA
replies. That run counted any `"return"` as a pass, so the sync reply alone
would have passed and a `guest-ping` reply wasn't verified; the probe now
requires the ping's own reply. The
mechanism on Windows is **unknown**. Inferred, unverified: the socket chardev
stops re-listening when its virtio-serial port has never been opened by the
guest. It doesn't change the verdict, because a channel that can't answer under
TCG doesn't need an endpoint that accepts reconnects. It does mean `isQgaReady()` on
Windows can see `ECONNREFUSED` as well as a silent connection.

## What this does not cover

- Windows with WHPX acceleration. The runner has none, so everything here is TCG.
  The pipe failure is in the chardev, not the accelerator; that the result
  carries over to WHPX is inferred.
- The `-chardev pipe` behaviour on other QEMU builds. Inferred from the source:
  any QEMU since the pipe backend was written behaves the same way.
- quickchr's own `monitorCommand()`/`consoleExec()` against these endpoints. The
  harness re-implements their wire protocol with the same `node:net` call, so
  that the boot-time client could be connected during QEMU startup.

## Reproduce

```bash
# Windows, QEMU on PATH
bun run test/lab/windows-pipe-chardev/probe.ts --arm pipe --trials 50
# sun_path check (Windows, as the CI unix leg runs it)
bun run test/lab/windows-pipe-chardev/probe.ts --arm unix --trials 50 \
  --work "$LOCALAPPDATA\quickchr\machines" \
  --sun-path-sweep 100,104,106,107,108,109,110,130 --monitor-path-bytes max
# tcp / unix also run on Linux/macOS (keep --work short for unix: sun_path limit)
bun run test/lab/windows-pipe-chardev/probe.ts --arm tcp --trials 5 --accel kvm
```

In CI: dispatch `lab.yml` with `lab=windows-pipe-chardev`, or push a change under
`test/lab/`. Results go to the job summary and the
`windows-pipe-chardev-<arm>` artifact (`results-<arm>.json`, `probe.log`,
`qemu.log`).
