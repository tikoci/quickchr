# matrica — Parallel Version Matrix

Starts 4 ARM64 CHR instances in parallel (one per RouterOS channel), installs `zerotier` and `container` packages on each, and compares configuration exports across versions. Config drift = something changed between releases.

**Latvian:** *matrica* = matrix

## Why ARM64?

- `zerotier` and `container` packages exist **only** on ARM64 — x86 CHR cannot test them
- Complements [solis](../solis/README.md) (x86 sequential migration) — together they cover both architectures
- **tikoci/restraml use case:** ARM64 CHR with all packages gives a complete RouterOS API schema including zerotier and container endpoints

## Port Map

| Channel     | HTTP           | SSH            | Name              |
|-------------|----------------|----------------|-------------------|
| long-term   | :9200          | :9202          | matrica-longterm  |
| stable      | :9210          | :9212          | matrica-stable    |
| testing     | :9220          | :9222          | matrica-testing   |
| development | :9230          | :9232          | matrica-dev       |

## Quick Start

```sh
# Makefile (simplest)
make

# Python (verbose, shows config drift diff)
python3 matrica.py

# bun:test (library API assertions)
QUICKCHR_INTEGRATION=1 bun test matrica.test.ts
```

## Flow

```
1. Pre-clean stale instances
2. Resolve current version for each channel (long-term, stable, testing, development)
3. Start 4 ARM64 CHRs in parallel:
     quickchr start matrica-longterm --channel long-term --arch arm64 --port-base 9200 --packages zerotier,container
     quickchr start matrica-stable   --channel stable    --arch arm64 --port-base 9210 --packages zerotier,container
     quickchr start matrica-testing  --channel testing   --arch arm64 --port-base 9220 --packages zerotier,container
     quickchr start matrica-dev      --channel development --arch arm64 --port-base 9230 --packages zerotier,container
4. Wait for all to boot, verify zerotier + container packages active
5. Upload rb5009-arm64.rsc → reset-configuration → wait for reboot → :export
6. 4-way diff of exports — differences = version-specific migration behaviour
7. Stop and remove all instances
```

Package installation triggers an extra reboot inside `quickchr start`. The total wall time is dominated by the slowest instance (4 in parallel, not serial).

## Performance

| Host | Accelerator | Boot + packages | Wall time (4 CHRs) |
|------|-------------|----------------|--------------------|
| Apple Silicon (M-series) | HVF | ~60–90 s | ~90–120 s |
| Intel Mac | TCG | ~3–5 min | ~4–5 min |
| Linux x86 with KVM | KVM/TCG | ~2–4 min | ~3–4 min |
| GitHub Actions (ubuntu-latest) | TCG | ~4–6 min | ~5–6 min |

For CI, use the lite variant (long-term + stable only):

```sh
make LITE=1
MATRICA_LITE=1 QUICKCHR_INTEGRATION=1 bun test matrica.test.ts
python3 matrica.py --lite
```

## Config Drift Check

`rb5009-arm64.rsc` is a baseline RB5009-style config used to detect version-induced changes:

- Bridge with `ether2`–`ether8` in the LAN
- DHCP client on `ether1` (management)
- Basic firewall, DNS, service hardening
- `system identity` set to `matrica-chr`

Without `--emulate-device rb5009` (planned — not yet implemented), only `ether1` exists. RouterOS logs warnings for missing bridge ports but stays stable. The export comparison still catches version differences in how RouterOS renders defaults.

When `--emulate-device rb5009` is available, re-run with that flag to get the full 9-interface topology.

## restraml Use Case

`tikoci/restraml` needs ARM64 CHR with all packages to extract the complete RouterOS API schema:

```sh
# Leave instances running for schema extraction
python3 matrica.py --no-cleanup
make py-no-cleanup

# Then, for each instance, extract the /console/inspect tree:
# (see tikoci/restraml → deep-inspect tooling)
curl -u admin: http://127.0.0.1:9200/rest/console/inspect/...
```

## Files

| File | Description |
|------|-------------|
| `Makefile` | Recipe-driven, supports `LITE=1` |
| `matrica.test.ts` | bun:test library API version |
| `matrica.py` | Python subprocess CLI version |
| `rb5009-arm64.rsc` | Sample RB5009-style config for ARM64 |

## Requirements

- [quickchr](../../README.md) installed (`bun install -g @tikoci/quickchr` or `quickchr doctor`)
- `qemu-system-aarch64` + ARM64 EFI firmware (`brew install qemu` on macOS)
- `ssh` + `scp` in PATH (for config upload + export steps)
- For Python: Python 3.10+ (stdlib only — no extra packages needed)
