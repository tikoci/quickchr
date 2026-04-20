# Lab Report: `/system/device-mode` REST Behavior

**Date**: 2026-04-16
**CHR**: 7.22.1 (x86_64), Intel Mac, HVF
**Status**: Complete — 8 tests passing, 1 skipped (destructive blocking test)

## Objective

Document the exact REST behavior of `/system/device-mode` — especially the blocking
POST behavior, activation-timeout, attempt-count lifecycle, and error shapes — to
ground quickchr's device-mode automation and correct inaccurate claims in existing skills.

## Methodology

### Pre-test curl exploration

```bash
# Baseline GET — full attribute set
curl -s -u admin: http://127.0.0.1:9100/rest/system/device-mode | jq .

# .proplist filtering
curl -s -u admin: 'http://127.0.0.1:9100/rest/system/device-mode?.proplist=mode,container' | jq .

# Error responses (immediate, no blocking)
curl -s -u admin: -X POST http://127.0.0.1:9100/rest/system/device-mode/update \
  -H "Content-Type: application/json" -d '{"mode":"invalid"}'

curl -s -u admin: -X POST http://127.0.0.1:9100/rest/system/device-mode/update \
  -H "Content-Type: application/json" -d '{"nonexistent":"true"}'

# Activation-timeout (short, for testing)
curl -s -u admin: -X POST http://127.0.0.1:9100/rest/system/device-mode/update \
  -H "Content-Type: application/json" -d '{"container":"true","activation-timeout":"10s"}'
# → blocks for 10s, then returns 400 "update canceled"

# Singleton /print attempt
curl -s -u admin: -X POST http://127.0.0.1:9100/rest/system/device-mode/print
# → 500 Internal Server Error

# Via /rest/execute
curl -s -u admin: -X POST http://127.0.0.1:9100/rest/execute \
  -H "Content-Type: application/json" \
  -d '{"script":"/system/device-mode/print","as-string":""}'
```

### Iterative attempt-count testing

Ran 12 consecutive update cycles (with `activation-timeout=10s` and no power-cycle)
to test the "max 3 attempts" claim from MikroTik documentation:

```bash
for i in $(seq 1 12); do
  curl -s -u admin: -X POST http://127.0.0.1:9100/rest/system/device-mode/update \
    -H "Content-Type: application/json" -d '{"container":"true","activation-timeout":"10s"}'
  curl -s -u admin: http://127.0.0.1:9100/rest/system/device-mode | jq '.["attempt-count"]'
done
```

Result: attempt-count incremented to "12" with no REST-visible limit or behavioral change.

### Test formalization

Eight tests encoded in `device-mode.test.ts`:

1. **GET attributes** — verify all expected fields present with correct types
2. **String types** — confirm booleans are `"true"`/`"false"` strings, count is `"0"` string
3. **proplist filtering** — `.proplist=mode,container` returns only those fields
4. **Error: invalid mode** — HTTP 400, immediate (no blocking)
5. **Error: unknown param** — HTTP 400, immediate
6. **Error: bad timeout** — HTTP 400 with range message
7. **Singleton /print** — 500 Internal Server Error
8. **Via /rest/execute** — returns key-value text via as-string

One test skipped: POST that actually blocks (requires 10s+ wait per activation-timeout).

## Key Findings

### 1. ALL REST values are strings

Every attribute is a JSON string — booleans are `"true"`/`"false"`, numbers are `"0"`.
This is consistent with RouterOS REST convention but catches code that does
`if (data.container)` (always truthy since `"false"` is truthy in JavaScript).

### 2. POST ALWAYS blocks — even no-ops

`POST /rest/system/device-mode/update {}` (empty body) still blocks for the full
activation-timeout or default 5 minutes. There is no way to make a non-blocking
update request. Error responses (invalid params) ARE immediate.

### 3. Global HTTP stall during blocking

While device-mode/update is blocking, **ALL REST endpoints** become unresponsive —
not just `/system/device-mode`. The entire RouterOS HTTP server stalls.

### 4. attempt-count has no REST-visible limit

Tested to count=12. The MikroTik docs claim "after 3 failed attempts, the device must
be physically confirmed." This may apply only to hardware RouterBOARDs (with a physical
reset button), not CHR. On CHR, the only consequence is the count keeps incrementing.

**Correction applied**: Updated `device-mode.md` skill reference — was "max 3", now
notes the distinction between hardware and CHR behavior.

### 5. flagged is independent

`flagged` is set by RouterOS's configuration integrity analysis at boot, not by
attempt-count. A device can have attempt-count=12 and flagged=false.

### 6. activation-timeout range

Minimum: `00:00:10` (10 seconds). Maximum: `1d00:00:00` (1 day).
Values outside this range return immediate HTTP 400 with the range in the error message.

### 7. quickchr automation pattern

```text
POST update {container:"true", activation-timeout:"30s"}
  → blocks for ≤30s
Sleep 2s (let RouterOS process the request)
QEMU system_reset (hard power-cycle via monitor)
  → POST returns 400 "update canceled" OR connection drops
waitForBoot()
GET /rest/system/device-mode → verify container="true", attempt-count="0"
```

## Open Issues

- [ ] **Serial console output**: device-mode/update shows a countdown timer on serial.
      Not tested via quickchr's serial channel yet.
- [ ] **CHR vs hardware behavior**: The attempt-count limit likely differs on real
      RouterBOARDs with physical confirmation buttons. Need hardware for this test.
- [ ] **flagged recovery**: `flagged=yes` + `update flagged=no` + power-cycle flow
      not tested (would need to trigger flagged state, which requires malicious-looking
      configuration).

## Files

| File | Purpose |
|------|---------|
| `device-mode.test.ts` | 8 tests (1 skipped), raw response shapes in header |

## Backs These Skills/Instructions

- `~/.copilot/skills/routeros-fundamentals/references/device-mode-rest.md` — Primary SKILL
- `~/.copilot/skills/routeros-fundamentals/references/device-mode.md` — General device-mode reference (corrected)
- `.github/instructions/routeros-rest.instructions.md` — "device-mode/update — The Oddball" section
- `.github/instructions/provisioning.instructions.md` — Power-cycle pattern
