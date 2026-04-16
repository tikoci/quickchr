# SSH Key Provisioning — Lab Report

**Date:** 2025-07-17
**CHR Version:** 7.10 (stable), x86_64
**Host:** macOS arm64 (Apple Silicon)
**Acceleration:** HVF (x86 on arm64 = TCG)

## Summary

Tested SSH public key provisioning on RouterOS CHR via REST API. Two methods exist: `add` (inline key content) and `import` (from file on router). Key type support varies by RouterOS version.

## Findings

### 1. Two Methods for SSH Key Installation

**Method A: `PUT /rest/user/ssh-keys` (add)**
- Accepts `user` and `key` (inline public key content as string)
- Returns the created key entry with `.id`
- Response shape: `{".id":"*2","RSA":"false","bits":"2048","key-owner":"<comment>","user":"admin"}`

```bash
curl -u admin: http://127.0.0.1:9100/rest/user/ssh-keys \
  -X PUT -H "Content-Type: application/json" \
  -d '{"user":"admin","key":"ssh-rsa AAAA... comment"}'
# → 201 {".id":"*2","RSA":"false","bits":"2048","key-owner":"comment","user":"admin"}
```

**Method B: `POST /rest/user/ssh-keys/import` (import from file)**
- Requires the public key to first be uploaded to the router's file system
- Accepts `user` and `public-key-file` (filename on router)
- Returns `[]` (empty array) on success
- Two-step process: upload file, then import

```bash
# Step 1: Upload file
curl -u admin: http://127.0.0.1:9100/rest/file \
  -X PUT -H "Content-Type: application/json" \
  -d '{"name":"mykey.pub","contents":"ssh-rsa AAAA... comment"}'

# Step 2: Import
curl -u admin: http://127.0.0.1:9100/rest/user/ssh-keys/import \
  -X POST -H "Content-Type: application/json" \
  -d '{"user":"admin","public-key-file":"mykey.pub"}'
# → 200 []
```

### 2. Key Type Support (Version-Dependent)

| Key Type | `add` (7.10) | `import` (7.10) | Notes |
|----------|-------------|-----------------|-------|
| RSA 2048 | ✅ Works | ✅ Works | Only reliable type on older versions |
| ed25519 | ❌ "wrong format" | ❌ "wrong format" | Not supported on 7.10 |
| ECDSA 256 | ❌ "wrong format" | ❌ "wrong format" | Not supported on 7.10 |

Error message for unsupported types: `{"detail":"failure: unable to load key file (wrong format or bad passphrase)!","error":400}`

**Recommendation for quickchr:** Generate RSA 2048 keys for maximum compatibility. Test ed25519 on 7.18+ in a future lab.

### 3. Response Shape

```json
{
  ".id": "*2",
  "RSA": "false",
  "bits": "2048",
  "key-owner": "lab-rsa",
  "user": "admin"
}
```

- `key-owner` comes from the SSH key comment field (the part after the key data)
- `RSA` field is always `"false"` in our tests despite being RSA keys — meaning unclear (possibly indicates "is private key" or legacy field)
- `bits` is a string, not a number
- `.id` format is `*N` (decimal, not hex like firewall rules)

### 4. SSH Login Verification

After adding a key via REST, SSH key-based login works immediately (no reboot needed):

```bash
ssh -o PasswordAuthentication=no -o BatchMode=yes \
  -i /path/to/private/key admin@127.0.0.1 -p 9102 ':put "works"'
# → works
```

### 5. Key Removal

```bash
curl -u admin: 'http://127.0.0.1:9100/rest/user/ssh-keys/*2' -X DELETE
# → 204 No Content (empty body)
```

### 6. quickchr Provisioning Implications

For `quickchr` SSH key provisioning:

1. **Generate RSA 2048** keys (not ed25519) for compatibility across RouterOS versions
2. **Use `add` method** (inline key content) — simpler than upload+import, works in one REST call
3. **Key takes effect immediately** — no reboot needed after adding
4. Store private key in machine directory alongside `machine.json`
5. The `key-owner` field can be used to identify quickchr-managed keys (use a distinctive comment like `quickchr-<machine-name>`)

### 7. Package apply-changes Version Discovery

During this lab session, discovered that `/system/package/apply-changes` was **added in RouterOS 7.18**:
- Versions < 7.18: Must use `/system/reboot` to apply package changes
- Versions ≥ 7.18: Use `/system/package/apply-changes` (preferred, reboots and applies atomically)
- Confirmed via rosetta `routeros_command_version_check` and live testing on 7.10

Updated `routeros-container/SKILL.md` to note this version dependency.

## Test File

`test/lab/ssh-keys/ssh-keys.test.ts` — 7 tests covering:
- RSA key add via PUT
- ed25519 rejection (version-dependent)
- ECDSA rejection (version-dependent)
- RSA key import via file upload + import
- SSH login verification with installed key
- Key removal via DELETE
- Response shape validation

## Open Questions

1. When exactly was ed25519 SSH key support added? (Need to test on 7.16+ or 7.18+)
2. What does the `RSA` field actually mean? (Always "false" even for RSA keys)
3. Does `import` support different file formats (PEM, DER)?

> **Source:**
> - Lab: Live testing against CHR 7.10 (x86_64) on 2025-07-17
> - Rosetta: `/user/ssh-keys` command tree — `add` args: key, user, comment; `import` args: user, public-key-file, info
> - Rosetta: `routeros_command_version_check("/system/package/apply-changes")` → first_seen: 7.18
> - Code: `quickchr/src/lib/provision.ts` — SSH key generation and installation patterns
