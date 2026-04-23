# Using `@tikoci/quickchr` from another project

This directory holds runnable examples that exercise quickchr against real CHR
VMs. If you're building your own consumer (a sibling experiment dir, a CI
harness, another tool), there are **three supported ways** to depend on
`@tikoci/quickchr`. Pick the one that matches how stable you need the version
to be and how often the two repos change together.

## The three patterns

### 1. Published npm (recommended for normal users)

```sh
bun add @tikoci/quickchr            # stable channel (latest)
bun add @tikoci/quickchr@next       # pre-release channel
```

Channel policy (see `scripts/release.ts`):

- **Even minor** versions (`0.2.x`, `0.4.x`, …) publish to npm tag `latest` — stable.
- **Odd minor** versions (`0.1.x`, `0.3.x`, …) publish to npm tag `next` — pre-release.

Use this when you don't need to touch quickchr internals and just want a
pinned version in your `package.json`.

### 2. Local path (recommended for sibling experiment dirs)

```sh
# from your consumer project, with quickchr checked out as a sibling
bun add file:../quickchr
```

…or directly in `package.json`:

```json
{
  "dependencies": {
    "@tikoci/quickchr": "file:../quickchr"
  }
}
```

Bun resolves the package from the local directory. Edits to `../quickchr/src`
are picked up on the next `bun` invocation — no rebuild step (quickchr ships
`.ts` sources directly via the `exports` map). Best for quick local iteration
where you don't want the symlink semantics of `bun link`.

### 3. `bun link` (recommended when co-developing both repos)

```sh
# one-time, in the quickchr checkout:
cd /path/to/quickchr
bun link

# then in each consumer:
cd /path/to/your-consumer
bun link @tikoci/quickchr
```

This creates a global symlink so every consumer sees the same live checkout.
Best when you're actively changing both repos in the same session.

**Caveat:** some long-running Bun processes (test watchers, `bun --hot`) may
cache the resolved module path. If your edits don't seem to apply, restart the
Bun process. If `bun link` resolution looks wrong, `bun pm ls` will show what
got resolved.

## When to use which

| Scenario | Pattern |
|---|---|
| Production / CI pinned to a release | Published npm |
| Trying a pre-release of quickchr | Published npm with `@next` |
| Sibling experiment dir, occasional edits to quickchr | Local path (`file:../quickchr`) |
| Active co-development of quickchr + consumer | `bun link` |

There is no `npm workspaces` / `bun workspaces` setup in this repo — quickchr
is a standalone package, not part of a monorepo.

## Runnable examples in this directory

The examples here are **Bun tests** (`bun:test`). Run them with:

```sh
QUICKCHR_INTEGRATION=1 bun test examples/vienk/vienk.test.ts
QUICKCHR_INTEGRATION=1 bun test examples/matrica/matrica.test.ts
```

Or via the package script:

```sh
bun run test:examples
```

- [`vienk/`](./vienk/) — minimal quickstart: one CHR, boot, query REST, remove.
- [`matrica/`](./matrica/) — multi-CHR parallel matrix across RouterOS channels.

### In-repo import vs external consumer import

The example tests import from the repo source directly:

```ts
// examples/vienk/vienk.test.ts — in-repo path
import { QuickCHR, type ChrInstance } from "../../src/index.ts";
```

That relative path only works **inside** this repository. As an external
consumer using any of the three patterns above, replace it with the package
name:

```ts
// your-consumer/test.ts
import { QuickCHR, type ChrInstance } from "@tikoci/quickchr";
```

Everything else in the example tests (the `QuickCHR.start(...)` call, the
`ChrInstance` API, channel selection, cleanup in `afterAll`) works identically
from an external consumer.
