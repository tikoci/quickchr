# quickchr

CLI and library to download, launch, and manage MikroTik CHR virtual machines via QEMU.

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) runtime
- [QEMU](https://www.qemu.org) with `qemu-system-x86_64` and/or `qemu-system-aarch64`
- UEFI firmware (edk2) for arm64 CHR

Install QEMU:

```bash
# macOS
brew install qemu

# Ubuntu/Debian
sudo apt install qemu-system-x86 qemu-system-arm qemu-efi-aarch64

# Fedora/RHEL
sudo dnf install qemu-kvm qemu-system-aarch64 edk2-aarch64

# Arch
sudo pacman -S qemu-full

# Windows
winget install QEMU.QEMU
```

### Install

```bash
bun add @tikoci/quickchr
```

### CLI Usage

```bash
# Interactive wizard
quickchr

# Start a CHR (downloads image, allocates ports, boots)
quickchr start --channel stable --arch arm64

# Start with specific version
quickchr start --version 7.22.1

# List instances
quickchr list

# Check instance status
quickchr status 7.22.1-arm64-1

# Stop an instance
quickchr stop 7.22.1-arm64-1

# Stop all instances
quickchr stop --all

# Reset disk to fresh image
quickchr clean 7.22.1-arm64-1

# Remove instance entirely
quickchr remove 7.22.1-arm64-1

# Check prerequisites
quickchr doctor
```

### Start Options

| Flag | Description | Default |
|------|-------------|---------|
| `--version <ver>` | RouterOS version | Latest stable |
| `--channel <ch>` | stable, long-term, testing, development | stable |
| `--arch <arch>` | arm64 or x86 | Host native |
| `--name <name>` | Instance name | Auto-generated |
| `--cpu <n>` | CPU cores | 1 |
| `--mem <mb>` | Memory in MB | 512 |
| `--background` | Run in background (default) | true |
| `--foreground` | Foreground with serial on stdio |  |
| `--add-package <pkg>` | Extra package (repeatable) |  |
| `--add-user <user:pass>` | Create a user after boot |  |
| `--disable-admin` | Disable the admin user |  |
| `--port-base <port>` | Starting port number | Auto (9100+) |
| `--dry-run` | Show plan without executing |  |

### Background vs Foreground Mode

By default `quickchr start` runs QEMU in the **background**: QEMU is spawned as a detached process and the command returns immediately once CHR has booted. You can then use `quickchr list`, `quickchr status`, and `quickchr stop` to manage it.

```bash
# Background (default) — returns after CHR finishes booting
quickchr start --channel stable

# Foreground — serial console attached to your terminal
quickchr start --channel stable --fg
```

In **foreground** mode, your terminal becomes the CHR serial console (like a VM's VGA window). Use these key sequences:

| Key | Action |
|-----|--------|
| `Ctrl-A X` | Exit QEMU and return to shell |
| `Ctrl-A C` | Toggle QEMU monitor (`quit` to force-stop) |
| `Ctrl-A H` | List all key shortcuts |

> **Note:** Background QEMU processes are true OS-level orphans — `quickchr` does not use shell job control (`&`). After the command returns you can close the terminal and QEMU keeps running. Use `quickchr stop <name>` to shut it down cleanly.

### Library Usage

```typescript
import { QuickCHR } from "@tikoci/quickchr";

// Start a CHR
const chr = await QuickCHR.start({
  channel: "stable",
  arch: "arm64",
  mem: 512,
});

// Wait for boot
await chr.waitForBoot();

// Use REST API
const info = await chr.rest("/system/resource");
console.log(info);

// Stop
await chr.stop();
```

### Use in Tests

```typescript
import { describe, test, afterAll } from "bun:test";
import { QuickCHR } from "@tikoci/quickchr";

let chr;

test("boot CHR and check version", async () => {
  chr = await QuickCHR.start({ channel: "stable" });
  await chr.waitForBoot();

  const resource = await chr.rest("/system/resource");
  expect(resource["board-name"]).toBe("CHR");
}, 120_000);

afterAll(async () => {
  if (chr) await chr.stop();
});
```

### Port Layout

Each instance gets a block of 10 ports:

| Port Offset | Service |
|-------------|---------|
| +0 | HTTP/REST/WebFig (80) |
| +1 | HTTPS (443) |
| +2 | SSH (22) |
| +3 | API (8728) |
| +4 | API-SSL (8729) |
| +5 | WinBox (8291) |

Default base is 9100, so first instance gets HTTP on 9100, SSH on 9102, etc.

## Development

```bash
bun install
bun test                    # Unit tests
bun run lint                # Biome check
QUICKCHR_INTEGRATION=1 bun test test/integration/  # Integration tests (needs QEMU)
```

## License

MIT
