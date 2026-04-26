# Security Policy

## Reporting a Vulnerability

Report privately via [GitHub Security Advisories](https://github.com/tikoci/quickchr/security/advisories/new). Do **not** open a public issue for an undisclosed vulnerability.

Please include affected files, reproduction details, and impact. Initial response within a few business days.

## Scope

quickchr manages local QEMU virtual machines for MikroTik RouterOS CHR (test harness, not a production credential or VM manager). Its runtime security surface:

- **Credential storage** — MikroTik web credentials and per-instance passwords are stored in the user's config directory (`~/.config/quickchr/`). Same-user processes can read them. By design.
- **Network exposure** — CHR instances bind ports on `127.0.0.1` by default (localhost only). Shared/bridged networking can expose CHR to the LAN — this is opt-in.
- **QEMU processes** — spawned as the current user, not elevated.

## Code scanning

The repository's [Security tab](https://github.com/tikoci/quickchr/security) is the live source of current alerts and advisories. This section describes the *configured* posture.

- **CodeQL** — not enabled. Planned: enable [Default Setup](https://github.com/tikoci/quickchr/settings/security_analysis) for `javascript-typescript` + `actions`, matching `tikoci/lsp-routeros-ts`.
- **Code Quality (AI findings, preview)** — not enabled. Planned to follow CodeQL.
- **Dependency review** — not enabled.
- **Dependabot security updates** — not enabled.
- **Secret scanning** — not enabled.
- **Private vulnerability reporting** — not enabled.

This repo is being brought up to the tikoci public-repo baseline; until that lands, this section reflects current truth rather than aspiration.

## Supported versions

| Version | Supported |
| --- | --- |
| latest | ✅ |
| older | ❌ |
