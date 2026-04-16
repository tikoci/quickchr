# Lab Report: Bun `fetch()` vs `node:http` Connection Pool

**Date**: 2026-04-15
**CHR**: 7.22.1 (x86_64), Intel Mac, HVF
**Bun**: 1.3.11
**Status**: Partially resolved — primary hypothesis disproved, secondary issue discovered

## Objective

Determine whether Bun's `fetch()` connection pooling causes stale responses when
a CHR is stopped and restarted on the same port, as documented in
`bun-http.instructions.md` and `provisioning.instructions.md`.

## Hypothesis

> Bun's `fetch()` pools TCP connections by `host:port` and ignores `Connection: close`.
> When a CHR instance is stopped and a new one starts on the same port, the pooled
> connection returns responses from the dead instance.

## Methodology

### Phase 1: Controlled comparison (bun-fetch-vs-node.test.ts)

Eight tests comparing `fetch()` and `node:http` + `agent: false` side-by-side:

1. **Baseline GET** — both clients retrieve `/rest/system/resource`, compare response identity
2. **Timing** — measure latency difference (fetch should be faster if pooling helps)
3. **POST correctness** — `POST /rest/execute` with `as-string=""` returns correct data
4. **POST timing** — timing matches actual RouterOS command delay (no cached response)
5. **Sequential GET→POST** — no cross-contamination between methods
6. **Concurrent GET+POST** — parallel requests return correct data
7. **Cross-endpoint** — `/rest/system/identity` then `/rest/execute` on same connection
8. **Connection close** — verify RouterOS sends `Connection: close` header

### Phase 2: Stop/restart scenario (bun-pool-restart.test.ts)

The specific scenario claimed to trigger the bug:

1. Make requests to CHR on port 9100 (warming the pool)
2. Record pre-restart identity and uptime
3. Stop the CHR via `QuickCHR.stop()`
4. Start a new CHR on the same port
5. Immediately call `fetch()` — does it return stale data?
6. Compare identity/uptime pre- and post-restart

### Pre-test curl exploration

```bash
# Baseline responses
curl -s -u admin: http://127.0.0.1:9100/rest/system/resource | jq .
curl -s -u admin: http://127.0.0.1:9100/rest/system/identity | jq .

# Verify Connection header
curl -v -u admin: http://127.0.0.1:9100/rest/system/resource 2>&1 | grep -i connection

# POST timing (RouterOS adds ~200ms delay for :delay command)
time curl -s -u admin: -X POST http://127.0.0.1:9100/rest/execute \
  -H "Content-Type: application/json" \
  -d '{"script":":put hello","as-string":""}'
```

## Results

### Primary hypothesis: DISPROVED

All 8 comparison tests pass. `fetch()` returns correct data in every scenario:

| Test | Result | Notes |
|------|--------|-------|
| Baseline GET | ✅ Pass | Both return identical JSON |
| Timing | ✅ Pass | fetch ~1.8× faster (pooling working correctly, not stale) |
| POST correctness | ✅ Pass | Correct inline output |
| POST timing | ✅ Pass | 200ms+ matches `:delay 0.2s` command delay |
| Sequential GET→POST | ✅ Pass | No cross-contamination |
| Concurrent | ✅ Pass | Both correct |
| Cross-endpoint | ✅ Pass | No contamination |
| Connection close | ✅ Pass | RouterOS sends `Connection: close` |

The stop/restart test also passes — uptime is fresh after restart, identity is correct.

### Secondary issue: DISCOVERED

During Phase 1-3 lab runs, a **different** pooling-related issue emerged:

> When `bun test` runs multiple lab files in one process, device-mode GET requests
> hang indefinitely. This reproduces with **both** `fetch()` and `node:http` + `agent: false`.

This is NOT the HTTP client's connection pool — it's the bun test runner's shared event loop.
When one test file sends a blocking request (device-mode update blocks for 5 minutes),
it starves the event loop and prevents other files' HTTP requests from completing.

**Workaround**: Run lab files individually, not as a batch.

## Conclusions

1. **Bun's fetch() connection pool bug was NOT reproduced** on Bun 1.3.11.
   The original reports (which led to the node:http migration) may have been caused by:
   - Older Bun versions with actual pool bugs
   - device-mode's connection-dropping behavior misattributed to Bun
   - Post-boot REST race (RouterOS returns wrong data briefly after boot)

2. **`rest.ts` using node:http + agent:false remains correct** as a belt-and-suspenders
   defense for library code. The cost is minimal (slightly slower per-request) and
   eliminates an entire class of potential issues.

3. **The bun test runner event loop issue is real** but unrelated to the HTTP client choice.
   It affects any blocking HTTP call, regardless of client.

## Open Issues

### Bun.fetch() — Need a Clear "Except When" Rule

The codebase currently has mixed HTTP patterns:

| Module | Client | Reason |
|--------|--------|--------|
| `rest.ts` | `node:http` + `agent:false` | CHR REST calls — belt-and-suspenders |
| `versions.ts` | `fetch()` | External URL (MikroTik upgrade server) |
| `images.ts` | `fetch()` | External URL (CHR image download) |
| `packages.ts` | `fetch()` | External URL (package ZIP download) |
| Integration tests | `node:http` + `agent:false` | Copied from rest.ts pattern |

**The rule we want but don't have**:

> Use `fetch()` for all HTTP calls **except** `<crisp exception list>`.

Current "exception" is vague: "CHR REST calls because of connection pool bugs."
But the bug wasn't reproduced. The real reasons for node:http in rest.ts are:

1. **`req.destroy()` silence** (Bug 2 in bun-http.instructions.md) — Bun doesn't emit
   `error` on destroy, causing promise hangs. This IS reproducible and IS a real bug.
2. **Defense-in-depth** against future pool regressions in Bun
3. **Consistency** — rest.ts already uses node:http, changing it back has risk with no benefit

**Suggested clear rule**:
> Use `fetch()` everywhere **except** when you need `req.destroy()` with guaranteed
> error propagation (timeout handling on long-polling/blocking endpoints).
> This means: `rest.ts` stays on node:http because of the destroy bug, not the pool bug.

### Items for Future Investigation

- [ ] **Bun bug report**: File issue for `req.destroy()` not emitting error event
- [ ] **Bun version tracking**: Re-test pool behavior on each major Bun release
- [ ] **Quantify node:http overhead**: Benchmark rest.ts vs fetch() at scale (100+ requests)
- [ ] **Test runner workaround**: Investigate `--test-isolate` or `--bail` flags for bun test

## Files

| File | Purpose |
|------|---------|
| `bun-fetch-vs-node.test.ts` | 8 comparison tests (fetch vs node:http) |
| `bun-pool-restart.test.ts` | Stop/restart stale-response scenario |

## Backs These Skills/Instructions

- `.github/instructions/bun-http.instructions.md` — Bug descriptions and rest.ts rule
- `.github/instructions/provisioning.instructions.md` — "Use node:http" section
- `.github/instructions/routeros-rest.instructions.md` — Post-boot REST race handling
