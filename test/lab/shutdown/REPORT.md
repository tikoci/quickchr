# Guest shutdown through REST

Issue: [#143](https://github.com/tikoci/quickchr/issues/143), REST edge-case item in
[#43](https://github.com/tikoci/quickchr/issues/43).

## Question

Can the small shutdown operation use `/system/shutdown` through existing `exec()`
without a QGA/ACPI selection framework? Does the HTTP result indicate guest exit?

## Initial measurements

Measured 2026-10-21 on Intel macOS, Bun 1.4.2, QEMU 11.1.1, RouterOS **7.24.5**,
source `664e1b8466c00b54e9f1d20dcdf27f109b4a95e7`. One fresh machine per architecture,
`secureLogin: false`, default user-mode networking. Each got a fresh identity
marker immediately before the request. `exec('/system/shutdown', { via: 'rest',
timeout: 10000 })` ran concurrently with independent 50 ms PID polling. No stop
signal was sent before the recorded exit. `stop()` then reconciled state, the
same disk was restarted, and the identity was read back. Both machines were
removed in `finally`.

| Guest / accelerator | Request result | Request settled | QEMU exit observed | Same-disk marker |
| --- | --- | --- | --- | --- |
| x86 / HVF | HTTP 400 interrupted | 5.6 ms | 203 ms | retained |
| arm64 / TCG | HTTP 400 interrupted | 101 ms | 1,064 ms | retained |

Both responses had this body:

```json
{"detail":"interrupted","error":400,"message":"Bad Request"}
```

`restExecute()` wraps this in `EXEC_FAILED`. That response can accompany successful
shutdown. Observe the process independently; neither HTTP error nor HTTP success
establishes whether QEMU exited.

These single-run observations support a configurable 10-second default. They do
not guarantee shutdown timing under load, storage/application durability, or
behavior on other RouterOS releases, accelerators or host platforms. No QGA or
ACPI claims are made. An observed exit alone does not distinguish a clean guest
halt from a crash; the product result is deliberately named `guest-exited`.

## Reproduce

From the repository root, with QEMU installed:

```bash
bun test/lab/shutdown/probe.ts x86
bun test/lab/shutdown/probe.ts arm64
```

The pinned probe creates a uniquely named machine, records JSON events to stdout,
restarts the same disk only if process exit was observed, and removes its machine
in `finally`. It uses a 15-second observation bound to collect evidence; the
product grace default is 10 seconds. If the host process is interrupted, check
and remove only the named `shutdown143-*` probe machine.

## Product regression coverage

`test/integration/shutdown.test.ts` exercises the public method: same-disk marker
persistence, managed credentials, stopped-state/PID reconciliation, named-network
release/rejoin, repeat calls, and forced fallback with deliberately invalid REST
credentials. It records the version, architecture, accelerator, elapsed time and
result to the test output. Run it locally or through `integration.yml` on the PR
ref; CI artifacts carry the platform evidence. Report untested combinations as
untested, rather than extrapolating the initial local observations.

```bash
QUICKCHR_TEST_TARGET=7.24.5 QUICKCHR_INTEGRATION=1 \
  bun test test/integration/shutdown.test.ts
```
