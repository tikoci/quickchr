# SSH + RouterOS — Lab Report

**Round:** TIKOCI SSH grounding (issue [#74](https://github.com/tikoci/quickchr/issues/74))
**Date:** 2026-07-06
**CHR versions tested:** 7.11, 7.12, 7.13, 7.14, 7.15, 7.16 (boundary sweep, boot-only);
**7.20.8 long-term** (quickchr's provisioning floor) and **7.23.1 stable** (full matrix)
**Host:** macOS, Intel x86_64 (HVF-accelerated x86 CHR) — OpenSSH_10.2p1, LibreSSL 3.3.6
**Runner:** `test/lab/ssh-keys/run-matrix.ts` (matrix) + `.github/workflows/lab.yml` job `ssh-os-baseline` (host-OS axis)

## Scope

This is not just "pick quickchr's managed-key algorithm." It is the single SSH
research round for **quickchr** (issue #74 / #71), **centrs** ([#176](https://github.com/tikoci/centrs/issues/176) `check` failure-mode
taxonomy + `--add-ssh-key-if-missing`; [#147](https://github.com/tikoci/centrs/issues/147) `transfer`), and a candidate
**`routeros-ssh`** skill. quickchr is TIKOCI's research arm (`test/lab/*`), so the
grounding here is deliberately broader than the one `descriptor()` field #71 needs.

Every install cell is gated on a **real host-OpenSSH batch login** (not only "the key
appears in the REST listing") — that listing-only check is exactly the gap #71 must close
and the gap the shipped `installSshKey()` verification left open. quickchr's managed
probe now tightens that batch login with `PasswordAuthentication=no`,
`IdentitiesOnly=yes`, and `-F <platform null device>` so host ssh_config or agent
identities cannot satisfy the check.

## 1. "ed25519 support" is four features at four versions

The forum thread says 7.12, an earlier changelog note said 7.15 — both are partly
right, because "ed25519 support" is four separate capabilities (rosetta changelog,
`category:ssh`). Row 4 — an ed25519 *user public key* accepted by
`/user/ssh-keys/add|import` — is the load-bearing one for quickchr and centrs, and
it is the only one with no clean changelog entry, so it was **measured** here.

| # | Capability | Version | RouterOS surface | Grounding |
| - | ---------- | ------- | ---------------- | --------- |
| 1 | Ed25519 key exchange (curve25519 KEX) | 7.7 | negotiation algo | changelog |
| 2 | Ed25519 **host key** (server identity) | 7.9 | `/ip/ssh host-key-type=ed25519` | changelog |
| 3 | Ed25519 **user private** key (router-as-client) | 7.15 | `/user/ssh-keys/private import` | changelog |
| 4 | Ed25519 **user public** key (login **to** the router) | **7.12** (measured) | `/user/ssh-keys/add \| import` | **this lab** |

**Row-4 boundary (measured, ed25519 public key via REST `add`, one CHR boot per version):**

| Version | ed25519 `add` | Result |
| ------- | ------------- | ------ |
| 7.10 | ❌ 400 "wrong format" | reject (2025 lab) |
| 7.11 | ❌ 400 "wrong format" | reject |
| **7.12** | ✅ 201 | **first accept** |
| 7.13 | ✅ 201 | accept |
| 7.14 | ✅ 201 | accept |
| 7.15 | ✅ 201 | accept |
| 7.16 | ✅ 201 | accept |

**The row-4 boundary is 7.12** — the forum thread was right; the changelog's "7.15"
is row 3 (user *private* keys), a different feature. quickchr's floor (7.20.8) is
far past 7.12, so its ed25519 default is safe for every version it provisions.
centrs, which meets arbitrary devices, should treat **< 7.12** as the RSA-2048-only
regime.

## 2. RouterOS SSH server surface (`/ip/ssh`) — and it changed shape mid-7.x

The `/ip/ssh` settings a host-OpenSSH client negotiates against. **The REST schema
for this menu is not stable across the 7.x line** — a fact centrs `check` must
tolerate:

| Field | 7.11 | 7.20.8 | 7.23.1 | Meaning |
| ----- | ---- | ------ | ------ | ------- |
| `host-key-type` | rsa | rsa | rsa | server identity key; **default `rsa`** — drives the `known_hosts`/TOFU line |
| `host-key-size` | 2048 | 2048 | 2048 | RSA host-key bits |
| `strong-crypto` | false | false | false | `yes` ⇒ 256/192-bit ciphers, sha256, 2048-DH; drops md5/null/1024-DH |
| `ciphers` | *(absent)* | auto | auto | cipher selection |
| `allow-none-crypto` | false | *(absent)* | *(absent)* | pre-7.20 field, dropped |
| `always-allow-password-login` | false | false | *(absent)* | pre-7.23 name for the password policy |
| `password-authentication` | *(absent)* | *(absent)* | `yes-if-no-key` | **7.23 rename**: once a user has any key, password login is refused by default |
| `publickey-authentication-options` | *(absent)* | *(absent)* | none | `touch-required`/`verify-required` = FIDO `ED25519-SK` (7.21); would break batch auth |
| `forwarding-enabled` | no | no | no | out of scope |

**Load-bearing facts for centrs `check`:**

- The password-policy knob is `always-allow-password-login=false` on ≤7.20.x and
  `password-authentication=yes-if-no-key` on 7.23.x — **same behavior, renamed
  field**. Both mean: *a user with any SSH key installed can no longer log in with
  a password.* A `check` that probes one field name will read blank on the other
  version line.
- Default `host-key-type=rsa` on every version tested — so the `known_hosts` line
  a client pins on first contact is `ssh-rsa` unless the operator flips it. Grounded
  via `ssh-keyscan` in every matrix run: only `ssh-rsa` offered.

## 3. Install methods & response schema (also changed shape)

Three install paths exist; quickchr ships the **console `add`** one:

| Method | Call | Notes |
| ------ | ---- | ----- |
| REST add | `PUT /rest/user/ssh-keys {user,key}` | inline key content, one call; returns the created entry |
| REST import | `PUT /rest/file` then `POST /rest/user/ssh-keys/import {user,public-key-file}` | two-step (upload + import); import returns `[]` on success — this is centrs' `transfer`+`import` path |
| console add | `/user/ssh-keys/add user= key=` over serial | quickchr's `installSshKey()`; commits synchronously (REST may 200 before durable) |

RouterOS **cannot generate keys itself** — keys always come from the host.

**The `/rest/user/ssh-keys` response schema drifts across the 7.x line** — it bit
the runner (a `key-owner`-based match reported false negatives on 7.23.1 until fixed
to accept either field). Measured field-by-field across the boot sweep:

| Field | 7.12–7.14 | 7.15–7.16 | 7.20.8 | 7.23.1 | Note |
| ----- | --------- | --------- | ------ | ------ | ---- |
| `.id`, `user` | ✓ | ✓ | ✓ | ✓ | stable |
| `key-type` (`ed25519`/`rsa`) | ✓ | ✓ | ✓ | ✓ | explicit algorithm, present since ≥7.12 |
| `RSA` (always `"false"`) | ✓ | — | — | — | **dropped at 7.15** — resolves the old "what does `RSA` mean" question; it's gone |
| `bits` | — | ✓ | ✓ | ✓ | **added at 7.15** |
| `fingerprint` (`SHA256:…`) | — | — | ✓ | ✓ | **added between 7.16 and 7.20.8** |
| `key-owner` (the comment) | ✓ | ✓ | ✓ | — | **renamed** to `info`… |
| `info` (the comment) | — | — | — | ✓ | …**between 7.20.8 and 7.23.1** |

Tooling that reads `/rest/user/ssh-keys` must therefore match the comment on
`info ?? key-owner` and must not depend on `RSA`. quickchr's `installSshKey()` matches
the generated key comment plus fingerprint when RouterOS exposes it (normalizing
optional trailing base64 padding), so an older key for the same user cannot satisfy the
managed-key verification; the runner uses the same comment-field fallback.

## 4. Verified install matrix (every cell = real batch login)

Both floor (7.20.8) and stable (7.23.1): identical results.

| Cell | Method | Algo | 7.20.8 | 7.23.1 |
| ---- | ------ | ---- | ------ | ------ |
| A | console `add` (quickchr's path) | ed25519 | ✅ install + login | ✅ install + login |
| B | REST `import` (centrs' path) | ed25519 | ✅ install + login | ✅ install + login |
| C | console `add` | RSA-2048 | ✅ install + login | ✅ install + login |
| D | REST `import` | RSA-2048 | ✅ install + login | ✅ install + login |
| A′ | REST `add` | ed25519 | ✅ install + login | ✅ install + login |
| C′ | REST `add` | RSA-2048 | ✅ install + login | ✅ install + login |
| F | REST `add` | ECDSA-256 | ❌ 400 "wrong format" | ❌ 400 "wrong format" |

- **ed25519 works via all three transports (console `add`, REST `add`, REST
  `import`) on both the floor and current stable**, verified by an actual
  passwordless login — not just presence in the listing.
- **ECDSA is still rejected** on 7.23.1 with the same "unable to load key file
  (wrong format or bad passphrase)!" error the 7.10 lab captured. RouterOS accepts
  only RSA and ed25519 user public keys.

## 5. Host-OS defaults axis (grounded via CI)

quickchr and centrs shell out to the **host** OpenSSH, so the host's defaults
decide whether a RouterOS-side key/algorithm connects. Grounded by
`.github/workflows/lab.yml` job `ssh-os-baseline` (`ssh -V`, `openssl version`,
`ssh-keygen` default type, `ssh -Q` algorithm sets). Measured on the GitHub-hosted
runners (run of 2026-07-06) plus the local Intel Mac:

| OS | `ssh -V` | `ssh-keygen` default type | TLS lib OpenSSH links | `openssl` binary |
| -- | -------- | ------------------------- | --------------------- | ---------------- |
| ubuntu-latest | OpenSSH_9.6p1 | **ed25519** | OpenSSL 3.0.13 | OpenSSL 3.0.13 (same) |
| windows-latest | OpenSSH_10.3p1 | **ed25519** | OpenSSL 3.5.6 | OpenSSL 3.5.6 (same) |
| macos-latest | OpenSSH_10.2p1 | **ed25519** | **LibreSSL 3.3.6** | OpenSSL 3.6.2 (**different**) |
| macOS (local Intel) | OpenSSH_10.2p1 | **ed25519** | **LibreSSL 3.3.6** | OpenSSL 3.6.2 (**different**) |

**All three runner OSes default `ssh-keygen` to ed25519** — so the key a user
already has, and the key a bare `ssh-keygen` mints, is ed25519 on every platform
quickchr/centrs run on. That is the empirical backing for ed25519 as the aligned
default across both tools.

The `ssh -V` "OpenSSL vs LibreSSL" split matters and is **macOS-specific**: on both
macOS runners the SSH client links **LibreSSL**, even though a separate OpenSSL
binary is installed — so "what `openssl version` prints" is *not* what OpenSSH
negotiates with. Ubuntu and Windows link the same OpenSSL their `openssl` binary
reports. Tooling that infers SSH crypto support from `openssl version` will be wrong
on macOS only.

**Alignment conclusion:** where the host mints an ed25519 key by default (as the
local host does), RouterOS ≥ the row-4 boundary accepts that exact public key via
`add`/`import`. So ed25519 is both quickchr's safe managed default *and* the natural
key for centrs' "reuse the user's existing key" path. RSA-2048 remains the fallback
only for sub-boundary devices — which quickchr never provisions (floor 7.20.8), but
centrs may still meet.

## 6. Recommendations & deliverables

- **quickchr `provision.ts`** — keep the **ed25519** managed default (confirmed by
  cells A/A′ on both 7.20.8 and 7.23.1). RSA-2048 documented as the sub-boundary
  fallback only. Landed this round: `installSshKey()` now **captures and surfaces
  the console `add` output on failure** (previously discarded → a real RouterOS
  rejection masqueraded as a blind 10s REST-listing timeout), matches the generated key
  row by comment/fingerprint, and verifies batch login with `IdentitiesOnly=yes` while
  ignoring ssh_config (`-F` to the platform null device).
- **#71** — unblocked and the data source landed: `installSshKey` now does a real
  host-OpenSSH batch login after install and persists
  `MachineState.managedSshKey = { privateKeyPath, algorithm, batchVerified }` (to
  `machine.json`). #71's descriptor advertises `services.ssh.auth.privateKeyPath` /
  batch key auth as usable **only when `batchVerified` is true**. Verified live on the
  floor (7.20.8) and stable (7.23.2) via `test/integration/provisioning.test.ts`.
- **centrs #176** — the §2 password-policy field rename + the §3 error strings are
  the grounded distinctions `check`'s error/warn/tip taxonomy needs; ed25519 row-4
  result is the recipe for `--add-ssh-key-if-missing`.
- **routeros-skills** — candidate `routeros-ssh` skill: server/client schemes, the
  four-feature ed25519 timeline, `password-authentication` semantics + the field
  rename, host-OpenSSH alignment. Create *after* this REPORT.md is the grounding
  (footnote discipline).

## 7. Open questions resolved / remaining

- ✅ *When did ed25519 user-public-key login land?* — measured (row-4 boundary, §1).
- ✅ *What did the always-`"false"` `RSA` field mean?* — moot; dropped in 7.23,
  replaced by explicit `key-type` (§3).
- ✅ *Does `import` support ed25519?* — yes, on both floor and stable (cells B/D).
- ◻️ Exact 7.23 `import` PEM/DER format handling (only OpenSSH pubkey format tested).
- ◻️ `strong-crypto=yes` negotiation against host OpenSSH (named in §2, not yet run).

> **Sources**
>
> - Live testing against CHR 7.11/7.20.8/7.23.1 (x86_64, HVF) on 2026-07-06 via
>   `quickchr` + `test/lab/ssh-keys/run-matrix.ts`.
> - Host-OS axis: `.github/workflows/lab.yml` job `ssh-os-baseline` (Ubuntu/Windows/macOS runners).
> - rosetta changelog `category:ssh` for the ed25519 feature timeline (rows 1–3).
> - Manual: <https://help.mikrotik.com/docs/spaces/ROS/pages/132350014/SSH>.
> - Cross-refs: quickchr #71/#74, centrs #176/#147.
