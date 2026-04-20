# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in quickchr, please report it through
[GitHub Security Advisories](https://github.com/tikoci/quickchr/security/advisories/new).

Do **not** open a public issue for security vulnerabilities.

## Scope

quickchr manages local QEMU virtual machines. Its security surface includes:

- **Credential storage** — MikroTik web credentials and per-instance passwords are
  stored in the user's config directory (`~/.config/quickchr/`). Same-user processes
  can read them. This is by design (test harness, not production credential manager).
- **Network exposure** — CHR instances bind ports on `127.0.0.1` by default (localhost
  only). Shared/bridged networking can expose CHR to the LAN — this is opt-in.
- **QEMU processes** — spawned as the current user, not elevated.
