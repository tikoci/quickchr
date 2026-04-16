# Lab Report: `/system/package` REST Lifecycle

**Date**: 2026-04-16
**CHR**: 7.22.1 (x86_64), Intel Mac, HVF
**Status**: Complete — 6 tests passing, 1 skipped (destructive apply-changes)

## Objective

Document the full package lifecycle on CHR via REST — visibility, enable/disable,
`apply-changes` vs `reboot`, and the critical discovery that `/system/reboot` does NOT
apply package changes.

## Methodology

### Pre-test curl exploration

```bash
# Package list on fresh boot (only routeros visible)
curl -s -u admin: http://127.0.0.1:9100/rest/system/package | jq .

# Trigger check-for-updates to reveal all available packages
curl -s -u admin: -X POST http://127.0.0.1:9100/rest/system/package/update/check-for-updates \
  -H "Content-Type: application/json" -d '{"duration":"10s"}'

# Full package list after check-for-updates
curl -s -u admin: http://127.0.0.1:9100/rest/system/package | jq '.[] | .name'

# Enable a package
curl -s -u admin: -X POST http://127.0.0.1:9100/rest/system/package/enable \
  -H "Content-Type: application/json" -d '{"numbers":"container"}'

# Check scheduled state
curl -s -u admin: http://127.0.0.1:9100/rest/system/package | jq '.[] | select(.name=="container")'

# THE CRITICAL TEST: reboot vs apply-changes
# Step 1: Enable container, verify scheduled
curl -s -u admin: -X POST http://127.0.0.1:9100/rest/system/package/enable \
  -H "Content-Type: application/json" -d '{"numbers":"container"}'
curl -s -u admin: http://127.0.0.1:9100/rest/system/package | jq '.[] | select(.name=="container") | .scheduled'
# → "scheduled for enable"

# Step 2: Reboot (NOT apply-changes)
curl -s -u admin: -X POST http://127.0.0.1:9100/rest/system/reboot \
  -H "Content-Type: application/json" -d '{}'
# Wait for boot...
curl -s -u admin: http://127.0.0.1:9100/rest/system/package | jq '.[] | select(.name=="container") | .disabled'
# → "true" ← STILL DISABLED! Reboot did not apply the change!

# Step 3: Now use apply-changes
curl -s -u admin: -X POST http://127.0.0.1:9100/rest/system/package/enable \
  -H "Content-Type: application/json" -d '{"numbers":"container"}'
curl -s -u admin: -X POST http://127.0.0.1:9100/rest/system/package/apply-changes \
  -H "Content-Type: application/json" -d '{}'
# Wait for boot...
curl -s -u admin: http://127.0.0.1:9100/rest/system/package | jq '.[] | select(.name=="container") | .disabled'
# → "false" ← NOW IT'S ACTIVE!
```

### Test formalization

Six tests encoded in `packages.test.ts`:

1. **Package list structure** — verify array with `.id`, `name`, `version`, `disabled`, `scheduled`
2. **check-for-updates reveals packages** — count jumps from ~1 to 12 after check
3. **Update channel** — GET `/system/package/update` shows channel, can be changed
4. **Enable sets scheduled** — `scheduled` field changes to `"scheduled for enable"`
5. **Disable sets scheduled** — `scheduled` field changes to `"scheduled for disable"`
6. **Apply-changes triggers reboot** _(skipped)_ — destructive, reboots CHR

## Key Findings

### 1. CRITICAL: `/system/reboot` does NOT apply package changes

This is the single most important finding from the entire lab initiative:

> A plain `/system/reboot` discards pending package scheduled states.
> Only `/system/package/apply-changes` reliably applies enable/disable changes.

This contradicts advice in multiple MikroTik community sources and was previously
documented incorrectly in the `extra-packages.md` skill reference.

**Correction applied**: Updated `extra-packages.md` to use `apply-changes` instead of
`/system/reboot`. Updated `packages-rest.md` skill reference with prominent warning.

### 2. Built-in packages need no SCP upload

CHR 7.22.1 includes 12 packages built into the image. They appear after
`check-for-updates` reveals them:

> routeros, calea, container, dude, gps, iot, openflow, rose-storage,
> tr069-client, ups, user-manager, wireless

For these, the flow is: check-for-updates → enable → apply-changes. No SCP or
file upload needed. SCP is only required for truly third-party packages.

### 3. Package state model

| State | `available` | `disabled` | `version` | Meaning |
|-------|-------------|------------|-----------|---------|
| Active | `"false"` | `"false"` | `"7.22.1"` | Installed and running |
| Installed+disabled | `"false"` | `"true"` | `"7.22.1"` | Installed but not active |
| Available | `"true"` | `"true"` | `""` | Built-in, not yet installed |

### 4. Scheduled field values

- `""` — no pending action
- `"scheduled for enable"` — will be enabled on next apply-changes
- `"scheduled for disable"` — will be disabled on next apply-changes

Note: the test header says `"scheduled for install"` but testing confirmed it's
`"scheduled for enable"`. The enable POST sets this, not an install command.

### 5. check-for-updates is async

Uses the `.section` array pattern (same as monitor-traffic and license/renew):

```json
[
  {".section":"0", "status":"finding out latest version..."},
  {".section":"1", "status":"getting changelog..."},
  {".section":"2", "status":"System is already up to date"}
]
```

### 6. Container package requires device-mode

The `container` package can be enabled without device-mode, but `/container`
commands will fail with `"not allowed by device-mode"`. The quickchr provisioning
flow must set device-mode before enabling container package.

## Open Issues

- [ ] **SCP upload flow**: Not tested — need a third-party `.npk` to exercise the full
      SCP → upload → apply-changes path. The current lab only covers built-in packages.
- [ ] **QGA file delivery**: x86 CHR supports QGA `guest-file-write`. Could this deliver
      `.npk` files as an alternative to SCP? Not tested.
- [ ] **Downgrade behavior**: What happens when you disable a package that was active?
      Does apply-changes cleanly remove it? (The skipped test covers this partially.)
- [ ] **Multi-package enable**: Can you enable multiple packages in one POST
      (`{"numbers":"container,iot"}`)? Or must they be separate calls?
- [ ] **apply-changes vs reboot consistency**: The UPDATE note in the test header mentions
      behavior "may be inconsistent." More testing across CHR versions would help.

## Files

| File | Purpose |
|------|---------|
| `packages.test.ts` | 6 tests (1 skipped), raw response shapes in header |

## Backs These Skills/Instructions

- `~/.copilot/skills/routeros-fundamentals/references/packages-rest.md` — Primary SKILL
- `~/.copilot/skills/routeros-fundamentals/references/extra-packages.md` — General package reference (corrected)
- `.github/instructions/provisioning.instructions.md` — Package install flow
