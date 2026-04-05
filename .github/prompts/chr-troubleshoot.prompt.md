---
description: Start a CHR instance from chat and troubleshoot QEMU/RouterOS/quickchr problems interactively.
---

# Bring Up a CHR for Troubleshooting

Use this prompt to spin up a MikroTik CHR virtual machine via quickchr and diagnose issues in the running instance.

## Step 1 — Prerequisites Check

Run doctor to verify the environment is ready:

```
bun run dev -- doctor
```

Look for:
- `qemu-system-x86_64` or `qemu-system-aarch64` found (depending on host arch)
- On arm64 macOS: UEFI firmware paths present (from Homebrew `qemu`)
- HVF acceleration available (macOS) or KVM (Linux)

If QEMU is missing: `brew install qemu` (macOS) or `apt install qemu-system` (Linux).

## Step 2 — Start an Instance

### Quick start (background, stable channel):

```
bun run dev -- start
```

### With options:

```
bun run dev -- start --version=7.16.2 --name=debug-chr --cpu=2 --mem=512
```

Common flags:
- `--version=X.Y.Z` — pin a specific RouterOS version
- `--channel=stable|long-term|testing` — use a channel
- `--arch=x86|arm64` — override architecture
- `--name=<name>` — name the machine
- `--cpu=N` — vCPU count
- `--mem=N` — RAM in MB
- `--no-background` / `--fg` — foreground (attach console)
- `--port-base=N` — override starting port (default 9100)
- `--add-user=admin:pass` — create a user post-boot
- `--disable-admin` — disable default admin account
- `--dry-run` — show what would run, don't start

### Check running instances:

```
bun run dev -- list
```

## Step 3 — Connect to the Instance

Ports are allocated in blocks of 10 starting at 9100:

| Service  | Default Port | Offset |
|----------|-------------|--------|
| HTTP REST | 9100       | +0     |
| HTTPS    | 9101        | +1     |
| SSH      | 9102        | +2     |
| API      | 9103        | +3     |
| API-SSL  | 9104        | +4     |
| WinBox   | 9105        | +5     |

Connect via SSH:
```sh
ssh admin@127.0.0.1 -p 9102
```

Hit the REST API:
```sh
curl -u admin: http://127.0.0.1:9100/rest/system/resource
```

## Step 4 — Troubleshooting Checklist

### CHR won't boot / REST API times out

1. Check QEMU log:
   ```sh
   cat ~/.quickchr/machines/<name>/qemu.log
   ```
2. Verify PID is alive:
   ```sh
   cat ~/.quickchr/machines/<name>/qemu.pid
   kill -0 $(cat ~/.quickchr/machines/<name>/qemu.pid)
   ```
3. Check ports aren't conflicting:
   ```sh
   bun run dev -- start --dry-run
   ```
4. ARM64 specific: ensure EFI vars file is present and same size as code firmware.
5. Try TCG (software emulation): look for `accel=tcg` in the QEMU log.

### QEMU exits immediately

- Missing firmware (arm64): `brew reinstall qemu` and re-run `doctor`
- Corrupt disk image: `bun run dev -- clean <name>` to restore from cache
- Port already in use: use `--port-base` to pick a different range

### Serial console (interactive debug)

```typescript
import { QuickCHR } from "@tikoci/quickchr";
const instance = await QuickCHR.start({ name: "debug-chr", background: true });
const { readable, writable } = instance.serial();
// pipe readable to terminal, write to writable
```

Note: QGA is x86 only — arm64 CHR doesn't start the guest agent.

### QEMU monitor commands

```typescript
const result = await instance.monitor("info status");
console.log(result);
```

Common monitor commands:
- `info status` — VM running state
- `info network` — network devices
- `info block` — disk devices
- `system_powerdown` — graceful shutdown signal

### REST API not responding after boot

- Default credentials: `admin` / `` (empty password)
- RouterOS REST API listens on port 80 (guest), forwarded to 9100 (host)
- Try: `curl -v -u admin: http://127.0.0.1:9100/rest/system/identity`

## Step 5 — Cleanup

Stop a machine:
```
bun run dev -- stop <name>
```

Remove a machine (stops + deletes state):
```
bun run dev -- remove <name>
```

Clean (restore fresh disk image, keep state):
```
bun run dev -- clean <name>
```

## Architecture Notes (from QEMU instructions)

- **ARM64**: Uses `qemu-system-aarch64`, `-M virt`, UEFI pflash, `-device virtio-blk-pci` (never `if=virtio`)
- **x86**: Uses `qemu-system-x86_64`, `-M q35`, SeaBIOS, `if=virtio` disk
- **Acceleration priority**: KVM (Linux) → HVF (macOS) → TCG (fallback)
- **Boot detection**: polls `http://127.0.0.1:{httpPort}/` until 200 OK
