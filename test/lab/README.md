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
| `scripting-patterns/` | RouterOS scripting via REST `/execute` | — | — |

Each directory contains:

- `*.test.ts` — Bun test files with inline findings as header comments
- `REPORT.md` — Lab report: methodology, conclusions, open issues, links to skills

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

## Environment

All labs were conducted on:

- **CHR**: RouterOS 7.22.1 (x86_64)
- **Host**: Intel Mac (macOS Darwin), Bun 1.3.11
- **QEMU**: 10.2.2 with HVF acceleration (x86-on-x86, native speed)
- **Port**: 9100 (default quickchr port block base)
- **Machine name**: `lab-pool`

## Relationship to Other Artifacts

```
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
