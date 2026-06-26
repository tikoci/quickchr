# Example coverage matrix

Which quickchr capability each example grounds, and — where there's no example —
why. Keeps `examples/` honest and tells contributors what's deliberately left to
docs/tests. Source of truth for the API surface: [`../MANUAL.md`](../MANUAL.md)
§4 (CLI) and §4 (`ChrInstance`) / `src/lib/types.ts`.

Legend: ✅ example · 📘 docs/MANUAL only · 🧪 covered by `test/` only.

## CLI subcommands

| Command | Example | Reason if absent |
|---|---|---|
| `start` | ✅ all examples | |
| `add` | 📘 | create-without-start; every example starts immediately |
| `list` / `status` | ✅ version-matrix `.sh` | |
| `inspect` | ✅ quickstart, service-forward, file-transfer | |
| `env` | ✅ harness | |
| `exec` | ✅ grounding, dude, mndp, udp-gateway | |
| `get` (license/device-mode/admin) | ✅ device-mode, trial-license | |
| `set --license` | ✅ trial-license | |
| `snapshot` (save/load/list/delete) | ✅ rollback | |
| `--forward` | ✅ service-forward | |
| `--add-network` (socket:connect) | ✅ mndp `.sh` | |
| `--add-package` | ✅ dude, version-matrix | |
| `--device-mode-enable` | ✅ device-mode | |
| `remove` | ✅ all (teardown) | |
| `stop` | 📘 | `remove` covers teardown; `stop` alone is rarely an example |
| `clean` | 📘 | disk reset; low educational value vs `snapshot`/`remove` |
| `console` | 📘 | interactive serial TTY — not scriptable in a runnable example |
| `qga` | 📘🧪 | x86-only + KVM-gated; flaky as an example (see `test/integration/exec`) |
| `disk` | 📘 | read-only disk detail; covered by MANUAL |
| `cache` | 📘 | host-side image cache management; not a CHR interaction |
| `networks` | 📘 | host network discovery; platform-specific output |
| `doctor` | 📘 | host prerequisite check; not a CHR interaction |
| `logs` | 📘 | tails qemu.log; trivial |
| `completions` | 📘 | shell setup; not a CHR interaction |
| `setup` | 📘 | interactive wizard (TTY only) |

## `ChrInstance` methods & `StartOptions`

| Surface | Example | Reason if absent |
|---|---|---|
| `QuickCHR.start` | ✅ all | |
| `rest()` | ✅ quickstart, grounding, … | |
| `exec()` | ✅ grounding, dude, … | |
| `waitForBoot()` | ✅ quickstart, udp-gateway, mndp | |
| `descriptor()` / `subprocessEnv()` | ✅ harness | |
| `upload()` / `download()` | ✅ file-transfer, version-matrix (`upload`) | |
| `installPackage()` | ✅ dude | |
| `snapshot.save/load/list` | ✅ rollback | |
| `snapshot.delete` | 📘 | `rollback` shows the lifecycle; delete is the same shape |
| `license()` | ✅ trial-license | |
| `StartOptions.deviceMode` | ✅ device-mode | |
| `StartOptions.extraPorts` | ✅ service-forward | |
| `StartOptions.networks` (socket-connect) | ✅ mndp | |
| `StartOptions.packages` / `portBase` | ✅ version-matrix | |
| `StartOptions.bootDiskFormat` | ✅ rollback | |
| `tzspGatewayIp` | ✅ udp-gateway | |
| `waitFor()` | 📘 | custom-condition poll; JSDoc has the canonical example |
| `setDeviceMode()` (live) | 📘 | power-cycles the VM; `device-mode` at-start is the safe path |
| `availablePackages()` | 📘 | listing only; `installPackage` is the action |
| `monitor()` / `serial()` / `qga()` | 📘🧪 | low-level / interactive / KVM-gated |
| `queryLoad()` | 📘 | monitor sampling; niche |
| `clean()` / `destroy()` | 📘 | lifecycle variants of `remove()` |
| `StartOptions.installAllPackages` | 📘 | heavy + slow; `packages` covers the pattern |
| `StartOptions.user` / `disableAdmin` | 📘 | provisioning detail in MANUAL |
| `StartOptions.excludePorts` | 📘 | `--no-winbox`/`--no-api-ssl`; niche |
| `StartOptions.bootSize` / `extraDisks` | 📘 | disk sizing; covered by MANUAL + `test/` |
| `StartOptions.version` (pin) | 📘 | examples use `channel`; pin is a one-field swap |

## Deferred (planned)

| Surface | Status |
|---|---|
| `socket::<name>` multi-CHR L2 (rootless-l2 / `socket-lan`) | ⏳ needs a 1-page topology design first — tracked in [`../BACKLOG.md`](../BACKLOG.md) |
| `shared` / `bridged:<if>` / `tap:<if>` networks | 📘 host-setup heavy (sudo / socket_vmnet); documented, not a rootless example |
