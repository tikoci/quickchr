# quickchr — work map

This file is a **map**, not a work log. Open work is tracked in
**[GitHub Issues](https://github.com/tikoci/quickchr/issues)**; see
[CONTRIBUTING.md "Tracking work"](./CONTRIBUTING.md#tracking-work) for the full scheme
and the label legend (`area:*`, `P1`–`P4`, `research`, `needs-decision`).

## Where things live

| Content | Home |
|---------|------|
| Open, actionable work | GitHub Issues |
| Design decisions & rationale | [DESIGN.md](./DESIGN.md) |
| Grounded RouterOS/QEMU behaviour facts | narrowest `.github/instructions/*.md`, else `docs/`, else `test/lab/<topic>/REPORT.md` |
| Shipped, user-facing changes | [CHANGELOG.md](./CHANGELOG.md) |
| Narrative history (incl. the old 674-line backlog) | git history — `git log -p -- BACKLOG.md` |

**One home per thing.** Don't mirror an open issue in a doc, or a doc's fact in an issue.

## Filed as issues

Quick index (labels on each): [#23](https://github.com/tikoci/quickchr/issues/23) `cp` file-transfer ·
[#24](https://github.com/tikoci/quickchr/issues/24) `install` on a running machine ·
[#25](https://github.com/tikoci/quickchr/issues/25) `rootless-l2` example ·
[#26](https://github.com/tikoci/quickchr/issues/26) rename `tzspGatewayIp` ·
[#27](https://github.com/tikoci/quickchr/issues/27) troubleshooting-capture example ·
[#29](https://github.com/tikoci/quickchr/issues/29) release/verification reuse ·
[#30](https://github.com/tikoci/quickchr/issues/30) coverage byproduct ·
[#31](https://github.com/tikoci/quickchr/issues/31) arm64 savevm/loadvm.

This index is the **migrated backlog work**. Process/meta issues are tracked separately:
[#36](https://github.com/tikoci/quickchr/issues/36) (agent-setup cleanup) and
[#37](https://github.com/tikoci/quickchr/issues/37) (this backlog→issues migration).

## Open items not yet filed as issues

Curated but unfiled — file with the **Task**/**Research** template when picked up. The one-liners
are deliberately terse; the full prior notes (done-when, grounding) are in git history
(`git log -p -- BACKLOG.md`).

**area:cli**

- **User-settings framework** (P1) — narrow: ~5 settings (wizard defaults, cache cap, timeout scale, auth preference). Not machine-config mutation.
- **`doctor` cluster** (P2) — enhancement + correctness review pass; `doctor --export` bug-report bundle; version/RouterOS staleness.
- **Error diagnostics chain** (P2) — `research`: induce the 3–5 top error codes → `test/lab/errors/REPORT.md`; then structured `{code,message,hint,diagnostics}`; then centralize the error-message/logging surface (P4).
- **Machine config audit/verify report** (P2) — validate a machine against stored config (REST/packages/version/users); reports only, never mutates.
- **`--json` for `networks` and `disk`** (P3) — finish the #3 `--json` audit.
- **`exec --lint`** (P3, depends on lsp-routeros-ts) · **`list` live QEMU stats** (P3) · **ANSI table cleanup → borderless columns** (P4).
- **`RouterOS :export` alongside VM snapshot** (P3) — opt-in, wizard asks; never block the snapshot.

**area:wizard**

- **Remediation + preflight** (P2) — per-failure-code "why/try-this" (needs a per-machine session log first); storage preflight (disk free, `qemu-img`, socket_vmnet, port block); post-start credential-access info.

**area:rest**

- **`exec()` soft-error detection** (P2) — `research`: collect 5–10 real HTTP-200-with-error outputs → corpus; then opt-in `throwOnCliError`/`isRouterOSError()`. *May be subsumed by a future centrs validation path — defer the direction call.*
- **REST timeout contract reconciliation** (P2, `research`) — one lab mapping REST / `/execute` / `/console/inspect` / `license/renew` / `device-mode/update`; then update `routeros-rest.instructions.md` + any code clamps.
- **`/system/shutdown` exec returns HTTP 400** (P3) — capture the sequence, handle gracefully.
- **Bun HTTP follow-ups** (P3) — file the upstream `req.destroy()`-silence issue; re-test on Bun majors; unify to `fetch()` if fixed (rule + repro in `bun-http.instructions.md`).
- **Standalone lab tests** (P3, `research`) — serial device-mode countdown; large-duration async memory; license "done" path with real creds.

**area:library-api**

- **Machine evidence descriptor for harnesses** (P2) — one stable redacted run-summary shape (machine, requested/actual version, board, ports, auth) so centrs/donny stop hand-rolling records; fold into `descriptor()`/`inspect --json`/`doctor --export`.
- **Protocol-adapter reuse spike** (P3) — compare centrs' REST/native-api seam with `rest.ts`/`exec.ts` before adding SSH/native-api paths. *Possible centrs-subsumption — defer.*
- **LLM-ergonomics review of CLI/API** (P2) · **service-port-pinning API polish + paired-skill follow-up** (P4).

**area:networking**

- **SSH transport for `exec`** (P2) — `--via=ssh` (keys done, transport not); spike `ssh2` vs system `ssh`. Then **`--via=auto` smart routing** REST→SSH→QGA→console (P2).
- **`socket-mcast` darwin warning** (P3) — `networks`/wizard should warn on macOS (broken there; fact in DESIGN + `docs/networking.md`).
- **centrs L2 mac-telnet** (P3, `research`) — `socket-connect` proven for MNDP; apply the same bidirectional technique to MAC-Telnet.
- **`sudo` handling** (P2) — clear "sudo needed" error + pre-setup docs; never re-exec `sudo quickchr`.
- **Windows follow-ups** (P3) — the full TCG suite already passed (56/0/3; scp works *without* `sshpass`, SLiRP + port-forward validated — see `ci.instructions.md`). Remaining: named-socket/`socat`, TAP-Windows detection + docs, QGA +8 (KVM-gated), snapshot smoke.
- **Platform gaps** (P3) — macOS vmnet-bridged physical-only filter; macOS multi-NIC socket_vmnet fd numbering; Linux TAP discovery; `--emulate-device` profiles (start hEX).

**area:qemu**

- **Boot respawn-once watch-item** (P3) — DESIGN #8 mitigation, root cause unconfirmed; watch CI for `respawning QEMU once`. Build a repro if it recurs/survives respawn/appears on `_launchExisting`.
- **Cross-platform validation** (P3, `test`) — Linux-host bundle run; `completions --install` on bash+fish; `qemu-img`+`--boot-size` on Linux (Windows snapshot smoke is under *Windows follow-ups*).
- **arm64 QGA** (P3) — MikroTik ticket open; extend QGA tests once fixed + arm64+KVM confirmed.

**area:examples**

- **Multi-CHR examples** (P4) — tris (OSPF hub/spoke), solis (version migration), trauks (`/app` container), divi (VRRP, root-only). Each needs a 1-page topology sketch before coding.

**area:docs**

- **Agent teaching surface** (P2) — Copilot `.prompt.md` files; keep the paired `routeros-qemu-chr`/`routeros-quickchr` skills aligned when QEMU/CHR behaviour changes.

## Decisions owed (needs-decision)

Direction is the maintainer's; an agent may sketch but not implement. File with the
**Needs-decision** template. Rationale for all three is in [DESIGN.md](./DESIGN.md) "Port Layout →
Allocation rationale" and the config note.

- **Port-base randomness** — move off the fixed 9100 base; breaking change vs setting-with-default; which clean high range.
- **Fixed "service block" redesign** — dynamic variable-size blocks vs fixed core pool + separate extras pool (both dodge the Windows `+6..+8` IPC collision).
- **Config schema rationalization** — split desired config (cpu/mem/packages/networks) from runtime state (pid/status/lastStartedAt); needs a field-split + migration sketch.

## Deferred

Not rejected — revisit when prerequisites land or the need sharpens (rejected items are in
DESIGN.md "Out of Scope"): MCP server · TUI mode · `.rsc`/`.backup` config import ·
auto-update check · saved credential profiles · wizard snapshot/machine search (lists > 16).
