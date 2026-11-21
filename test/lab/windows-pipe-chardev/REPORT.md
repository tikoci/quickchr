# Windows `-chardev pipe` for monitor, serial and QGA

Issue: [#57](https://github.com/tikoci/quickchr/issues/57), the spike in the
maintainer's 2026-11-21 comment.

## Verdict

**NO.** On windows-latest with QEMU 11.1.0, a `-chardev pipe` channel serves
exactly one client for the life of the VM. After that client disconnects, every
reconnect fails: 0/50 for the monitor, 0/50 for serial and 0/50 for QGA, in both
runs. The pipe chardev also stops QEMU from starting until each pipe has a
client. Under this result, +6..+8 stays reserved on every OS.

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
three `-chardev` specs:

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
  `"return"`.

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
- **The VM keeps running.** QEMU stayed alive and REST through hostfwd answered
  `HTTP 200` at the end, about 15 minutes after the channels went dead. The
  channels are lost; the VM isn't.

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

- **The `sun_path` limit is 108 bytes.** Seen locally on Linux while building
  this lab: QEMU refused a long scratch path with `UNIX socket path '…' is too
  long`. That the same limit applies on Windows is inferred (Winsock's
  `sockaddr_un` is also 108 bytes); it wasn't tested there. A
  Windows machine dir like `C:\Users\<user>\AppData\Local\…\machines\<name>\`
  has to fit. Inferred: a short per-machine directory, or a check at create
  time as the inter-VM `dgram` code already does, would be needed.
- **Evidence is one runner image and one Bun version.** AF_UNIX needs Windows 10
  1803 or later. Behaviour on older Bun, and on Node consumers of the library,
  is untested.
- `channelPath()` / `channelEndpoint()` would change on Windows. That is a
  production change and out of scope for this lab.

## QGA on Windows (all arms)

QGA never answered `guest-ping` on any arm. That fits the known limit:
RouterOS only opens the guest-agent port under KVM (`qga.ts` header, DESIGN.md).
What's new is that the host side doesn't stay connectable either. On **tcp and
unix**, QGA accepted the boot-time client plus 0–5 further clients, then refused
every later connect with `ECONNREFUSED`. This happened in both runs, including
run 2, where nothing else touched QGA before the trials. Monitor and serial on
the same QEMU kept reconnecting. On Linux with KVM (local dry-run of this
harness), 5/5 TCP and 3/3 AF_UNIX QGA trials connected and answered. The
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
# tcp / unix also run on Linux/macOS (keep --work short for unix: sun_path limit)
bun run test/lab/windows-pipe-chardev/probe.ts --arm tcp --trials 5 --accel kvm
```

In CI: dispatch `lab.yml` with `lab=windows-pipe-chardev`, or push a change under
`test/lab/`. Results go to the job summary and the
`windows-pipe-chardev-<arm>` artifact (`results-<arm>.json`, `probe.log`,
`qemu.log`).
