# harness — drive an external tool against a live CHR

When a *separate* process needs to talk to a running CHR — a schema extractor
like [`tikoci/restraml`](https://github.com/tikoci/restraml), a protocol suite
like [`tikoci/centrs`](https://github.com/tikoci/centrs), or any CLI — don't have
it read `machine.json`. quickchr exposes a stable connection surface:

| Surface | Shape | Use |
|---|---|---|
| `instance.subprocessEnv()` | env vars (`URLBASE`, `BASICAUTH`, `QUICKCHR_*`) | hand to a child process |
| `instance.descriptor()` | `{ urls, auth, ports, status, version, … }` | structured record / evidence |

## The pattern

```ts
const env = await chr.subprocessEnv();        // URLBASE, BASICAUTH, …
Bun.spawn(["bun", "run", "child.ts"], { env: { ...process.env, ...env } });
```

The child ([`child.ts`](./child.ts)) reads `URLBASE` + `BASICAUTH` from its
environment and calls the CHR REST API on its own.

### `BASICAUTH` is `user:password`, not a header

`BASICAUTH` / `QUICKCHR_AUTH` are the **raw `user:password`** string. Base64-encode
it yourself for HTTP Basic auth:

```ts
fetch(`${process.env.URLBASE}/system/resource`, {
  headers: { Authorization: `Basic ${btoa(process.env.BASICAUTH)}` },
});
```

`URLBASE` already includes the `/rest` base, so append the menu path directly.

## ⚠ Secret-bearing output

`subprocessEnv()` and `descriptor()` carry the **real credentials** for the
machine. Treat their output like a password: pass it to the child via the
environment, but don't log it or write it into CI artifacts. (This example boots
with `secureLogin: true` so the credential is an actual managed-user password,
not the empty admin password.)

## Run

```sh
QUICKCHR_INTEGRATION=1 bun test examples/harness/harness.test.ts
```

Boots a real CHR (~40–60 s with KVM/HVF). See [`../README.md`](../README.md) for
dependency patterns.
