# Lab Report: Async Command Patterns (RouterOS REST)

**Date**: 2026-04-16
**CHR**: 7.22.1 (x86_64), Intel Mac, HVF
**Status**: Complete — 5 tests passing

## Objective

Document the three async command modes in RouterOS REST (`duration=`, `once=`, no param)
and the `.section` array response pattern that appears across multiple subsystems.

## Methodology

### Pre-test curl exploration

```bash
# Mode 1: duration= (returns array with .section indices)
curl -s -u admin: -X POST http://127.0.0.1:9100/rest/interface/monitor-traffic \
  -H "Content-Type: application/json" -d '{"interface":"ether1","duration":"3s"}'
# → 3 sections (one per second), takes ~3s to return

# Mode 2: once= (returns single-element array, immediate)
curl -s -u admin: -X POST http://127.0.0.1:9100/rest/interface/monitor-traffic \
  -H "Content-Type: application/json" -d '{"interface":"ether1","once":""}'
# → single element, no .section, immediate return

# Mode 3: no param (BLOCKS — had to Ctrl-C)
curl -s -u admin: -X POST http://127.0.0.1:9100/rest/interface/monitor-traffic \
  -H "Content-Type: application/json" -d '{"interface":"ether1"}'
# → hung until Ctrl-C after 30s

# once="false" — does it activate once mode?
curl -s -u admin: -X POST http://127.0.0.1:9100/rest/interface/monitor-traffic \
  -H "Content-Type: application/json" -d '{"interface":"ether1","once":"false"}'
# → BLOCKED! once="false" does NOT activate once mode (unlike as-string)

# once="true"
curl -s -u admin: -X POST http://127.0.0.1:9100/rest/interface/monitor-traffic \
  -H "Content-Type: application/json" -d '{"interface":"ether1","once":"true"}'
# → single element, immediate return (once="true" does activate it)

# once="" (empty string)
curl -s -u admin: -X POST http://127.0.0.1:9100/rest/interface/monitor-traffic \
  -H "Content-Type: application/json" -d '{"interface":"ether1","once":""}'
# → single element, immediate return

# Ethernet monitor (different command, same pattern)
curl -s -u admin: -X POST http://127.0.0.1:9100/rest/interface/ethernet/monitor \
  -H "Content-Type: application/json" -d '{"numbers":"ether1","once":""}'

# as-string on /rest/execute (for comparison)
curl -s -u admin: -X POST http://127.0.0.1:9100/rest/execute \
  -H "Content-Type: application/json" -d '{"script":":put hello","as-string":""}'
# → {"ret":"hello"}

curl -s -u admin: -X POST http://127.0.0.1:9100/rest/execute \
  -H "Content-Type: application/json" -d '{"script":":put hello","as-string":"false"}'
# → {"ret":"hello"} ← as-string="false" STILL activates it (presence-based)
```

### Test formalization

Five tests encoded in `async-commands.test.ts`:

1. **duration= returns .section array** — verify 3 sections for `duration="3s"`
2. **once= returns single element** — verify no `.section`, immediate return
3. **Ethernet monitor once** — verify pattern works on different command
4. **No param blocks** — verify request hangs (with 5s timeout to detect)
5. **once="false" does NOT activate** — verify it blocks (unlike as-string)

## Key Findings

### 1. Three distinct modes

| Parameter | Response | Timing | `.section` |
|-----------|----------|--------|------------|
| `duration="3s"` | Array of 3 elements | ~3 seconds | Yes (0, 1, 2) |
| `once=""` | Array of 1 element | Immediate | No |
| _(none)_ | Blocks indefinitely | Until timeout/disconnect | N/A |

### 2. `once="false"` is NOT presence-based

This is the key behavioral difference from `as-string`:

| Parameter | `as-string` | `once` |
|-----------|------------|--------|
| `""` | ✅ Activates | ✅ Activates |
| `"true"` | ✅ Activates | ✅ Activates |
| `"false"` | ✅ Activates | ❌ **Blocks like no param** |
| Absent | ❌ Returns job ID | ❌ Blocks indefinitely |

`as-string` is purely presence-based — ANY value (including `"false"`) activates it.
`once` is **partially** presence-based — `"false"` is the exception that does NOT activate.

**Correction applied**: Added this caveat to `routeros-rest.instructions.md` and
`async-commands-rest.md` skill reference.

### 3. `.section` pattern is universal

The `.section` key appears in async responses across multiple subsystems:

- `/interface/monitor-traffic` with `duration=`
- `/system/package/update/check-for-updates`
- `/system/license/renew`

Section indices are sequential integers as strings (`"0"`, `"1"`, `"2"`).
Count equals number of sample periods (typically 1 per second for `duration=`).

### 4. device-mode/update is different

Unlike monitor commands, `/system/device-mode/update` does NOT use the `.section`
pattern. It simply blocks and returns a single object (or HTTP 400 on timeout/error).
It cannot be scoped with `duration=` or `once=`.

### 5. Cross-subsystem consistency

The pattern is consistent enough to generalize: any RouterOS command with a streaming/
monitor mode uses the same three-mode structure. Safe to assume this for new commands
until proven otherwise.

## Open Issues

- [ ] **Full command inventory**: Which other RouterOS commands support `duration=`/`once=`?
      Known: monitor-traffic, ethernet/monitor, check-for-updates, license/renew.
      Candidates: `/tool/bandwidth-test`, `/tool/profile`, `/tool/ping`.
- [ ] **Large duration responses**: What happens with `duration="60s"`? Is the response
      streamed or buffered? Memory concerns for very long durations?
- [ ] **`.proplist` interaction**: Can `.proplist` filter which fields appear in `.section`
      array elements? Would reduce payload for high-frequency monitoring.
- [ ] **REST vs API-socket behavior**: The native MikroTik API has `/listen` for streaming.
      REST is one-shot. How do they differ for the same commands?

## Files

| File | Purpose |
|------|---------|
| `async-commands.test.ts` | 5 tests, raw response shapes in header |

## Backs These Skills/Instructions

- `~/.copilot/skills/routeros-fundamentals/references/async-commands-rest.md` — Primary SKILL
- `.github/instructions/routeros-rest.instructions.md` — Async commands section
