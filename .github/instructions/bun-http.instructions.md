---
applyTo: "src/lib/*.ts,test/**"
---

# Bun HTTP — Known Bugs and Workarounds

## Rule: CHR REST → rest.ts, External URLs → fetchResilient()

All HTTP requests to a CHR RouterOS instance MUST go through `src/lib/rest.ts`.
External URLs (MikroTik download servers, upgrade checks) go through
`fetchResilient()` (`src/lib/net.ts`), not bare `fetch()`. `fetchResilient` is a
normal `fetch` with one failback: on a connection-class error it retries by
resolving the A record via public DNS and connecting over the IPv4 literal (Host
+ TLS SNI preserved) — resilience to a misconfigured/transient resolver. See
DESIGN.md decision #9.

**No exceptions.** Do not use bare `fetch()` for external download/upgrade URLs,
and do not use `fetch()` or inline `node:http` for CHR REST calls.

Import pattern:
```typescript
import { restGet, restPost, restPatch } from "./rest.ts";
```

## Why: Three Bun-Specific Bugs

### Bug 1 — Connection Pool (stale responses)

Bun's `fetch()` pools TCP connections by `host:port` and **ignores `Connection: close`**.
When a CHR instance is stopped and a new one starts on the same port, the pooled connection
returns responses from the dead instance. Symptoms:

- A test passes in isolation but fails in the full suite
- A POST returns immediately (<2ms) with data that looks like a cached GET response
- Different test runs produce inconsistent results

**Fix**: `node:http` with `agent: false` (one connection per request). This is what `rest.ts` does.

### Bug 2 — req.destroy() Silence (hangs)

Bun's `node:http` implementation does NOT emit the `error` event when `req.destroy()` is
called. In Node.js, destroying a request emits `error` with an `ECONNRESET`-like error.
In Bun, the promise just never resolves.

**Fix**: Use a `done` flag + `setTimeout` + direct `reject()`:
```typescript
let done = false;
const timer = setTimeout(() => {
  if (!done) { done = true; req.destroy(); reject(new Error("timeout")); }
}, timeoutMs);
// ... in callbacks:
if (!done) { done = true; clearTimeout(timer); resolve/reject(...); }
```

This is the pattern used in `rest.ts`. Do not implement it inline — use `rest.ts`.

### Bug 3 — Bun.secrets.get() Keychain Dialog

`Bun.secrets.get(key)` triggers the macOS Keychain authorization dialog. In non-interactive
contexts (CI, background processes, some test configurations), this blocks indefinitely.

**Fix**: Guard with a check for interactive TTY before calling, or use environment variables
in CI. Integration tests that need credentials should use `MIKROTIK_WEB_USER` /
`MIKROTIK_WEB_PASS` environment variables with `Bun.secrets` as a fallback only in
interactive terminals.

## Unit Test Mocking

Code that uses `rest.ts` (node:http internally) cannot be tested with `globalThis.fetch` mocking.

- **For CHR REST code**: Use `node:http`'s `createServer` to spin up a real mock server on port 0.
  See `test/unit/license.test.ts` `startMockServer` for the pattern.
- **For external URL code** (versions.ts, images.ts, packages.ts): `globalThis.fetch` mocking
  is correct because `fetchResilient()` calls `fetch()` for its primary path. To exercise the
  failback, also spy `dns.Resolver.prototype.resolve4` and make the first `fetch` throw a
  connection-class error (see `test/unit/net.test.ts`).

## External-URL fetches go through fetchResilient() (Correct)

These files reach external URLs via `fetchResilient()` (`src/lib/net.ts`) — intentional:
- `versions.ts` — MikroTik upgrade server
- `packages.ts` — package ZIP downloads
- `images.ts` — CHR image downloads
