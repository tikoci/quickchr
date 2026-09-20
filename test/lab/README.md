# Lab Tests — RouterOS REST Behavior Documentation

Lab tests are **live experiments** run against real CHR instances to document exact RouterOS behavior.
They are not part of CI — they exist to produce grounded facts that feed into SKILL references and instruction files.

## Structure

Each subdirectory is a self-contained lab covering one subsystem:

| Directory | Topic | Tests | SKILL Reference |
|-----------|-------|-------|-----------------|
| `bun-pool/` | Bun `fetch()` vs `node:http` connection pooling | 9 | `bun-http.instructions.md` |
| `device-mode/` | `/system/device-mode` REST blocking + attributes | 8 | `device-mode-rest.md` |
| `packages/` | `/system/package` lifecycle, apply-changes | 6 | `packages-rest.md` |
| `async-commands/` | `duration=`, `once=`, `.section` arrays | 5 | `async-commands-rest.md` |
| `licensing/` | `/system/license` tiers, renew response shapes | 5 | `licensing-rest.md` |
| `slirp-hostfwd/` | SLiRP hostfwd: does it work without a guest IP? | 4 | `qemu.instructions.md` |
| `ssh-keys/` | SSH key provisioning and `exec --via=ssh` | — | `provisioning.instructions.md` |
| `www-abort-damage/` | Does an aborted REST probe damage RouterOS `www`? (#79) | 5 | `qemu.instructions.md` |
| `scripting-patterns/` | RouterOS scripting via REST `/execute` | — | — |
| `full-suite-resource-trend/` | Does full-suite cost inflate with position, or stay flat? (#76) | — | `ci.instructions.md` |

Each directory contains:

- `*.test.ts` — Bun test files with inline findings as header comments
- `REPORT.md` — Lab report: methodology, conclusions, open issues, links to skills

`full-suite-resource-trend/` is the exception to the `*.test.ts` shape: it measures
the *harness* rather than RouterOS, so it is a sampler plus a runner that
reproduces the CI per-file loop. See its own README for how to run it.

## Running

Lab tests require a running CHR instance and must be run **individually** (not as a batch):

```bash
# Start a lab CHR
bun run dev -- start --name lab-pool --background

# Run one lab at a time
QUICKCHR_INTEGRATION=1 bun test test/lab/device-mode/device-mode.test.ts
QUICKCHR_INTEGRATION=1 bun test test/lab/packages/packages.test.ts

# Do NOT run all labs together — bun test runner parallelism causes hangs
# QUICKCHR_INTEGRATION=1 bun test test/lab/  ← this will hang
```

### Why single-file runs only

Bun's test runner shares the event loop across files in the same process.
When one test file's RouterOS request blocks (e.g., device-mode update), it starves
other files' HTTP requests. This is a bun test runner limitation, not a quickchr or
RouterOS issue. See `bun-pool/REPORT.md` for details.

## Methodology

Each lab follows the same protocol:

1. **Raw exploration** — `curl` commands against the running CHR to see exact response shapes
2. **Hypothesis formation** — document expected behavior based on MikroTik docs + rosetta MCP
3. **Test formalization** — encode the curl experiments as `bun:test` assertions
4. **Cross-check** — compare findings against existing SKILL/instruction files
5. **Correction** — update skills and instructions where lab data contradicts prior claims

## Grounding a Field Report

The labs above are ones we chose to run. A **field report** is the other kind: a bug
report or an external agent's lab arrives with a conclusion already in it, and that
conclusion has to be grounded before anything is written down. The methodology above
assumes you picked the question; this one assumes someone else did, possibly wrongly.

The rule from `~/CLAUDE.md` applies with full force here — *one failure in one place is a
signal, not a fact* — and the specific trap is that a field report's **conclusion** and its
**observation** arrive welded together. The observation is usually sound. The conclusion is
a guess made under time pressure by someone debugging something else.

**Ask for one repro per candidate cause, not for a verdict.** A question like "was UDP
blocked?" invites the reporter to restate their conclusion. Splitting it forces
measurement:

1. **Name the environment** — `uname -a`, OS release, sandbox/seccomp/proxy/firewall state,
   and the exact command line of the process that failed. Half of field reports are
   resolved here, because the environment is not the one everyone assumed.
2. **Separate observed from inferred.** "What exact command failed, with what exact
   errno/output? Was that seen at the syscall (strace/audit/`EPERM`), or inferred from a
   silent symptom?" A report that says "blocked at the syscall level" may mean either.
3. **Enumerate the candidate causes and demand a minimal repro for each, separately.**
   This is the step that does the work. For a suspected network block, the split was
   internet / loopback-multicast / unix-datagram — three commands, and the second one
   killed the egress theory outright.
4. **Ask for the diagnostics that would refute it** — `netstat -gn`, `iptables -L -n`,
   `nft list ruleset`, the persisted config — including the ones expected to come back
   empty. An empty firewall ruleset is what makes "it is a kernel filter" a finding rather
   than a guess.
5. **Ask directly whether the recollection matches the logs**, and say whose recollection
   it is. Memory of a debugging session is reconstructed, and the reporter is the only one
   who can check it against what was actually logged.
6. **Ask what should be withdrawn.** Field reports bundle unrelated failures. Naming the
   ones that are *not* evidence for this question prevents them being cited later.

Then map the grounded observation onto a mechanism in source before writing it down. An
observation without a mechanism is still a correlation.

**Worked example (2026-09-20, `mcast`).** The report said "the sandbox blocked outbound UDP
at the syscall level". Steps 1–3 turned that into: Linux host (not macOS, which the issue
had assumed), seccomp-bpf active with an empty firewall, and `EPERM` on *unconnected*
`sendto()`/`sendmsg()` for `AF_INET` `SOCK_DGRAM` only — `connect()`+`send()`, TCP and
`AF_UNIX` datagrams all pass. Step 3's loopback case disproved the egress theory two
people had independently assumed. That maps onto the `sendto()`/`send()` branch in QEMU's
`net_socket_receive_dgram()`, which is why `mcast` died there and `dgram` did not. Step 6
withdrew the same session's image-download failures, which were TCP proxy stalls. Written
up in DESIGN.md, "A named socket says what it is"; the split it produced is #167
(delivery) vs #169 (permission).

## Environment

All labs were conducted on:

- **CHR**: RouterOS 7.22.1 (x86_64)
- **Host**: Intel Mac (macOS Darwin), Bun 1.3.11
- **QEMU**: 10.2.2 with HVF acceleration (x86-on-x86, native speed)
- **Port**: 9100 (default quickchr port block base)
- **Machine name**: `lab-pool`

## Relationship to Other Artifacts

```text
SKILL.md references          ← authoritative rules for agents
  ↑ distilled from
REPORT.md (this directory)   ← methodology + conclusions + open issues
  ↑ backed by
*.test.ts                    ← executable evidence (raw response shapes in comments)
  ↑ preceded by
curl experiments             ← initial exploration (methodology documented in REPORT.md)
```

If a SKILL claim needs auditing, the lab report has the "footnotes" — which tests
back the claim, what curl experiments were run, and what open questions remain.
