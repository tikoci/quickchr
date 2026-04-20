# vienk — Simplest CHR Integration Test

The minimal quickchr example: boot one CHR, check the REST API, clean up.

Use this to verify your QEMU and quickchr setup works before building anything more complex.

## Run

```bash
# Install prerequisites (once):
bun install

# Run the example:
QUICKCHR_INTEGRATION=1 bun test examples/vienk/vienk.test.ts
```

## What It Does

1. Boots a single CHR (stable RouterOS, native arch)
2. Waits for the REST API to respond (`/rest/system/resource`)
3. Checks identity and interface list
4. Removes the machine (stop + delete disk)

## Expected Output

```text
vienk — single CHR smoke test
  ✓ CHR boots and REST API responds
    RouterOS 7.22 (stable) (arm64) — uptime: 0h0m42s
  ✓ system identity is readable
  ✓ interface list has at least one ethernet
```

## Timing

| Accelerator | Approx. boot time |
|-------------|-------------------|
| KVM (Linux) | 20–40 s |
| HVF (macOS Apple Silicon) | 20–40 s |
| TCG (software emulation) | 2–4 min |

## Architecture

The test auto-selects arch from `process.arch`:

- `arm64` host → arm64 CHR (HVF/KVM)
- `x64` host → x86 CHR (HVF/KVM on matching host)

## What to Look at Next

- `examples/matrica/` — parallel multi-version matrix
- `test/integration/` — full quickchr integration test suite
- `CONTRIBUTING.md` — project dev setup and test policy
