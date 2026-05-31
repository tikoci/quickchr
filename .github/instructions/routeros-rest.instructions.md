---
applyTo: "src/lib/provision.ts,src/lib/exec.ts,src/lib/device-mode.ts,src/lib/license.ts,src/lib/rest.ts,test/integration/**"
---

# RouterOS REST API — Domain Knowledge

## Liveness Ladder (what "ready" means)

When checking if a CHR is ready, follow this hierarchy:

1. **GET `/` returns 200** (no auth) — webfig login page. HTTP layer is up.
2. **auth'd GET `/rest/system/resource` returns well-formed JSON object** — REST is ready.
   - Don't pin readiness on specific attributes — `JSON.parse` + `typeof === "object"` + `!Array.isArray` is enough.
   - Cache useful fields if present (`architecture-name`, `version`) but don't assert shape.
3. After step 2 succeeds, **failures are 99.9% the command/logic, not RouterOS being "flaky"**.

**Do NOT increase timeouts as a first fix.** If REST was ready (step 2 passed) and a subsequent
call fails, the problem is the command, auth, or endpoint — not RouterOS stability.

## Post-Boot REST Race

ALL REST endpoints may return wrong data briefly after boot (not just `/system/resource`).
`waitForBoot` validates step 2 above with consecutive-success guards. Other endpoints
(identity, license, device-mode, users) need their own field-presence polling if called
immediately after boot. Use `restGet` in a polling loop with a deadline.

Established pattern:
```typescript
const deadline = Date.now() + 20_000;
while (Date.now() < deadline) {
  const { status, body } = await restGet(url, auth, 5_000);
  if (status >= 200 && status < 300) {
    const data = JSON.parse(body);
    if (data && typeof data === "object" && !Array.isArray(data) && "expected-key" in data) {
      return data;
    }
  }
  await Bun.sleep(1_000);
}
```

## `/rest/execute` and `as-string`

`as-string` is a **presence-based boolean**. ANY value (`true`, `false`, `""`, `0`) makes
the execute call synchronous (returns output inline). ABSENT means async (returns a job ID like `*B546`).

```
POST /rest/execute  { "script": ":put hello" }             → { "ret": "*B546" }     (async job ID)
POST /rest/execute  { "script": ":put hello", "as-string": true }  → { "ret": "hello" }  (sync)
POST /rest/execute  { "script": ":put hello", "as-string": "" }    → { "ret": "hello" }  (sync — presence is what matters)
```

Our `exec.ts` always sends `"as-string": ""` for synchronous execution.

## Async Commands (duration= / once=)

Commands with `duration=` or `once` are "async" in RouterOS terms — results may be partial
or in-flight, and attributes can change shape between calls as results arrive.

- **CLI**: async commands show progress like a `more` pager
- **Native API**: has `/listen` (SSE-like `.re` messages with updated fields)
- **REST**: one-shot — without `duration=`/`once`, may wait until HTTP timeout, return
  pre-flight attributes, or assume some default behavior

`duration=` accepts RouterOS duration strings: `"10s"`, `"1m"`, `"1d2h3m2s"` — not ms integers.
Returns array with `.section` indices (one per sample period, typically 1/s).

`once=""` returns a single-element array (no `.section` field), immediate return.
`once` is presence-based — any value enables it — **EXCEPT `once="false"` which does NOT
activate once mode** (it blocks like no parameter). This differs from `as-string` which is
purely presence-based (even `"false"` enables it).

## REST Timeout Ceiling

Cross-project note from `tikoci/centrs`: normal RouterOS REST execution is treated there as
having a 60-second hard ceiling, and `via=rest-api` rejects larger user timeouts. quickchr has
separate lab-grounded handling for blocking endpoints below (`device-mode/update`,
`license/renew`), including host-side safety timers that may exceed 60s because they are
controlling a power-cycle or a bounded RouterOS wait.

Do not copy the blocking-endpoint timers to normal REST calls. Treat 60s as a working
assumption inherited from centrs for ordinary REST requests, but do not add a quickchr clamp
until the REST-timeout reconciliation lab in `BACKLOG.md` confirms the rule and documents
any endpoint-specific exceptions.

## device-mode/update — The Oddball

`/system/device-mode/update` is unique in RouterOS:

- **Blocks HTTP** until power-cycle confirmation or internal timeout (~5 min)
- Even calling from RouterOS itself (`/tool/fetch`) gets "failure: timeout waiting data"
- `flagged` and `attempt-count` attributes **survive reboots**
- Each failed attempt increments `attempt-count`; too many → must reset with
  `device-mode/update flagged=no` + reboot before retrying
- **NEVER retry on failure** — each attempt bumps `attempt-count`

Our code handles this by:
1. Send POST via `restPost` (fire and forget with 300s safety timeout)
2. Race against 2s sleep — if still pending, RouterOS entered blocking state
3. Kill QEMU (hard power-cycle) to confirm the change
4. Suppress the ECONNRESET that results from killing the connection
5. Restart QEMU, wait for boot, verify mode

## license/renew — Blocking Endpoint with Error Classification

`/system/license/renew` blocks while contacting MikroTik's license servers. Use `duration="10s"`
to let RouterOS wait up to 10s for the server before responding.

**Confirmed response shapes** (via curl experiments on running CHR):

| Response | Meaning | Action |
|----------|---------|--------|
| `[{".section":"0",status:"connecting"},{".section":"1",status:"done"}]` | License accepted | Poll `GET /system/license` to verify level changed |
| `[{".section":"0",status:"connecting"},{".section":"1",status:"renewing"},{".section":"2",status:"ERROR: Licensing Error: too many trial licences"}]` | Account trial limit reached | Throw immediately — do NOT poll |
| `[{".section":"0",status:"connecting"},{".section":"1",status:"renewing"},{".section":"2",status:"ERROR: Unauthorized"}]` | Bad MikroTik.com credentials | Throw immediately — do NOT poll |
| `{"detail":"missing =account=","error":400}` | Missing required field | HTTP 400 — caught by status check |
| `{"board-name":...}` (system resource data) | Post-boot REST race | Retry the POST (endpoint not initialized) |

**Critical**: The `status` field can contain `"ERROR: ..."` with HTTP 200. Our code MUST check
for error strings and throw immediately — not misclassify as "pending" and poll for 90 seconds.

## Type Safety Around RouterOS Shapes

Don't pin TypeScript types on RouterOS REST response shapes attribute-by-attribute.
RouterOS schemas drift between versions. **Type what we USE, not what they RETURN.**

- Well-formed JSON + is-object is enough for readiness checks
- Access specific fields with `data["field-name"]` and handle missing gracefully
- For schema documentation, use the rosetta MCP tools (`routeros_search`, `routeros_get_page`,
  `routeros_search_properties`, `routeros_lookup_property`)

## RouterOS Is Predictable

RouterOS is not "flaky". It is **"predictable but not always as expected"** — consistently
inconsistent on async commands, but stable on basic REST once booted.

If REST readiness (liveness ladder step 2) passes and a subsequent call fails:
1. Check the command syntax (RouterOS REST paths differ from CLI paths)
2. Check auth (wrong user, wrong password, expired session)
3. Check if the endpoint is async/blocking (see above)
4. Check if it's a post-boot race (field not yet populated)
5. **Only then** consider timing or infrastructure issues
