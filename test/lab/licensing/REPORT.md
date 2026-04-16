# Lab Report: `/system/license` REST Behavior

**Date**: 2026-04-16
**CHR**: 7.22.1 (x86_64), Intel Mac, HVF
**Status**: Complete — 5 tests (1 skipped: needs MikroTik.com credentials)

## Objective

Document the exact response shapes of `/system/license` and `/system/license/renew`
on CHR, including error classification for the `status` field that appears inside
HTTP 200 responses.

## Methodology

### Pre-test curl exploration

```bash
# Baseline GET — free CHR
curl -s -u admin: http://127.0.0.1:9100/rest/system/license | jq .
# → {"level":"free","system-id":"7WwsTkLUKQG"}

# Via /rest/execute
curl -s -u admin: -X POST http://127.0.0.1:9100/rest/execute \
  -H "Content-Type: application/json" \
  -d '{"script":"/system/license/print","as-string":""}'
# → {"ret":"  system-id: 7WwsTkLUKQG\r\n      level: free       "}

# Renew with missing fields
curl -s -u admin: -X POST http://127.0.0.1:9100/rest/system/license/renew \
  -H "Content-Type: application/json" -d '{}'
# → HTTP 400 {"detail":"missing =account=","error":400,"message":"Bad Request"}

# Renew with bad credentials
curl -s -u admin: -X POST http://127.0.0.1:9100/rest/system/license/renew \
  -H "Content-Type: application/json" \
  -d '{"account":"test@test.com","password":"wrong","level":"p1","duration":"10s"}'
# → HTTP 200 [
#   {".section":"0","status":"connecting"},
#   {".section":"1","status":"renewing"},
#   {".section":"2","status":"ERROR: Unauthorized"}
# ]

# Renew — trial limit
curl -s -u admin: -X POST http://127.0.0.1:9100/rest/system/license/renew \
  -H "Content-Type: application/json" \
  -d '{"account":"real@account.com","password":"real","level":"p1","duration":"10s"}'
# → HTTP 200 [
#   {".section":"0","status":"connecting"},
#   {".section":"1","status":"renewing"},
#   {".section":"2","status":"ERROR: Licensing Error: too many trial licences"}
# ]
```

### Test formalization

Five tests encoded in `license.test.ts`:

1. **GET baseline** — verify `level` and `system-id` present, level is `"free"`
2. **Via execute** — verify text output contains system-id and level
3. **Renew missing account** — HTTP 400 with `"missing =account="` detail
4. **Renew bad credentials** — HTTP 200 with `.section` array ending in `"ERROR: Unauthorized"`
5. **Renew with valid credentials** _(skipped)_ — requires `MIKROTIK_WEB_USER`/`MIKROTIK_WEB_PASS`

## Key Findings

### 1. Free CHR license is minimal

```json
{"level":"free","system-id":"7WwsTkLUKQG"}
```

Only two fields. No `nlevel`, no `deadline`, no expiration. Licensed CHR would have
additional fields (not tested — need valid credentials for renew).

### 2. CHR license tiers

| Level | Speed Limit | How to Get |
|-------|-------------|------------|
| `free` | 1 Mbps per interface | Default |
| `p1` | 1 Gbps per interface | 60-day trial via `/system/license/renew` |
| `p10` | 10 Gbps | Purchase from MikroTik |
| `p-unlimited` | Unlimited | Purchase from MikroTik |

### 3. `/system/license/renew` uses `.section` array pattern

Same async pattern as monitor-traffic and check-for-updates. The response is an array
of objects with `.section` indices:

```json
[
  {".section":"0", "status":"connecting"},
  {".section":"1", "status":"renewing"},
  {".section":"2", "status":"ERROR: Unauthorized"}
]
```

### 4. Error classification is critical

The `status` field can contain `"ERROR: ..."` strings inside an **HTTP 200** response.
Code MUST check the last section's status for the `"ERROR:"` prefix:

| Last Status | Meaning | Action |
|-------------|---------|--------|
| `"done"` | License renewed successfully | Poll GET to verify level |
| `"ERROR: Unauthorized"` | Bad MikroTik.com credentials | Throw immediately |
| `"ERROR: Licensing Error: too many trial licences"` | Account trial limit | Throw immediately |
| `"connecting"` or `"renewing"` | Still in progress (timed out) | Retry with longer duration |

**Never poll on error** — if status starts with `"ERROR:"`, the operation has definitively
failed. Polling would waste 90 seconds before timing out.

### 5. `duration=` controls server wait time

The `duration` parameter tells RouterOS how long to wait for the license server.
Without it, the request blocks for a default period (several minutes).
With `duration="10s"`, it waits up to 10 seconds for each phase.

### 6. Missing field returns HTTP 400

```json
{"detail":"missing =account=","error":400,"message":"Bad Request"}
```

This is immediate (no blocking). The `=field=` notation in the detail message is
RouterOS's native field reference syntax.

## Open Issues

- [ ] **Valid credential test**: Skipped because needs real MikroTik.com credentials
      (`MIKROTIK_WEB_USER`/`MIKROTIK_WEB_PASS`). Should be run at least once to confirm
      the success response shape `[{status:"connecting"},{status:"done"}]`.
- [ ] **Licensed CHR response**: What additional fields appear in `GET /system/license`
      after a successful p1 trial? Expected: `deadline`, `nlevel`, maybe others.
- [ ] **License persistence**: Does the license survive `quickchr remove` + re-create?
      It's tied to the virtual disk's system-id, so probably yes if the disk image is preserved.
- [ ] **Renewal rate limiting**: Is there a cooldown between renew attempts? The "too many
      trial licences" error is per-account, but is there also per-CHR rate limiting?

## Files

| File | Purpose |
|------|---------|
| `license.test.ts` | 5 tests (1 skipped), raw response shapes in header |

## Backs These Skills/Instructions

- `~/.copilot/skills/routeros-fundamentals/references/licensing-rest.md` — Primary SKILL
- `.github/instructions/routeros-rest.instructions.md` — License renew response shapes table
