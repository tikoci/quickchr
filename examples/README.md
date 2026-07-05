# quickchr examples

Runnable examples that exercise quickchr against real CHR VMs. Each is a
copy-and-run artifact that *does something real* — boot a router, apply config,
forward a port — showing both the **CLI and the library API**.

New here? Start with [`quickstart/`](./quickstart/) → [`grounding/`](./grounding/).
For what each example grounds (and where there's deliberately no example), see
[`COVERAGE.md`](./COVERAGE.md).

## The shape of an example

Every `examples/<name>/` follows one convention (see
[`.github/instructions/examples.instructions.md`](../.github/instructions/examples.instructions.md)
and the [`_template/`](./_template/)):

| File | What it is |
|---|---|
| `<name>.ts` | **Primary** — a runnable Bun script (library API). `bun run examples/<name>/<name>.ts`. |
| `<name>.sh` / `<name>.ps1` | The **CLI** version — the `quickchr …` commands a human/agent types. |
| `<name>.py` | A Python CLI driver (run with `uv run`), where a non-TS audience helps. |
| `README.md` | What it does, how to run it, expected time, and any "friction found". |

### Why runnable scripts, not tests

Examples are **scripts you `bun run`** — because the real-world thing a consumer
writes is a script that does something, not a test fixture. The one exception is
[`grounding/`](./grounding/), which is a `bun:test`: there the **assertions are
the documentation** (a regression suite for the apply→read-back contract), and it
doubles as the reference for writing CHR integration tests. Reach for `bun:test`
only when that's the point — an agent can wrap any script in `test()` in seconds.

Scripts self-check with plain `check()` (from [`lib.ts`](./lib.ts)) and tear the
machine down on success *or* failure via `runExample()`.

## The examples

| Example | Grounds |
|---|---|
| [`quickstart/`](./quickstart/) | boot one CHR, query REST, tear down *(was `vienk`)* |
| [`grounding/`](./grounding/) | apply config with `exec()`, read back with `rest()` — the `bun:test` reference |
| [`dude/`](./dude/) | install a package (`installPackage`), enable + read it back (x86 **and** arm64) |
| [`harness/`](./harness/) | drive an external tool via `subprocessEnv()` / `descriptor()` |
| [`rollback/`](./rollback/) | snapshot → change → restore (`snapshot.save/load/list`) |
| [`service-forward/`](./service-forward/) | pin a guest service to a host port (`--forward` / `extraPorts`) |
| [`file-transfer/`](./file-transfer/) | `upload()` / `download()` round-trip |
| [`device-mode/`](./device-mode/) | provision `/system/device-mode` (enable container) |
| [`trial-license/`](./trial-license/) | apply a CHR trial license — **manual-only** (rate limits) |
| [`udp-gateway/`](./udp-gateway/) | receive guest-originated UDP with no forward (`tzspGatewayIp`) |
| [`mndp/`](./mndp/) | receive MNDP L2 broadcasts via a `socket-connect` NIC |
| [`version-matrix/`](./version-matrix/) | boot every RouterOS channel in parallel and compare *(was `matrica`)* |

## Running them

```sh
# Library scripts (boot a real CHR — needs QEMU + KVM/HVF):
bun run examples/quickstart/quickstart.ts

# CLI scripts:
sh examples/quickstart/quickstart.sh          # POSIX
pwsh examples/quickstart/quickstart.ps1       # Windows

# Python drivers (uv preferred over a venv):
uv run examples/mndp/mndp.py

# The one test example:
QUICKCHR_INTEGRATION=1 bun test examples/grounding/grounding.test.ts

# The CI smoke harness (curated subset + failure-path case):
bun run smoke:examples
```

CLI scripts resolve quickchr via `$QUICKCHR` (default: this repo's source CLI, so
you exercise local changes). Set `QUICKCHR=quickchr` to use an installed binary.

## Depending on `@tikoci/quickchr` from your own project

The example scripts import quickchr from the repo source (`../../src/index.ts`).
As an external consumer, replace that with the package name — there are three
supported ways to depend on it:

### 1. Published npm (recommended for normal users)

```sh
bun add @tikoci/quickchr            # stable channel (latest)
bun add @tikoci/quickchr@next       # pre-release channel
```

Channel policy (see `scripts/release-prep.ts`): **even** minor versions (`0.2.x`,
`0.4.x`, …) publish to npm tag `latest` (stable); **odd** minors (`0.3.x`, …)
publish to `next` (pre-release).

### 2. Local path (recommended for sibling experiment dirs)

```sh
bun add file:../quickchr
```

Bun resolves the package from the local directory; edits to `../quickchr/src` are
picked up on the next `bun` invocation (quickchr ships `.ts` sources directly).

### 3. `bun link` (recommended when co-developing both repos)

```sh
cd /path/to/quickchr && bun link
cd /path/to/your-consumer && bun link @tikoci/quickchr
```

A global symlink so every consumer sees the same live checkout. If edits don't
apply, restart long-running Bun processes (`bun --hot`, watchers).

| Scenario | Pattern |
|---|---|
| Production / CI pinned to a release | Published npm |
| Trying a pre-release | Published npm `@next` |
| Sibling experiment dir, occasional edits | Local path (`file:../quickchr`) |
| Active co-development | `bun link` |

Then in your code:

```ts
import { QuickCHR, type ChrInstance } from "@tikoci/quickchr";
```

Each example's README has an "If you copied only this directory" note covering the
import swap and the `../lib.ts` helpers.
