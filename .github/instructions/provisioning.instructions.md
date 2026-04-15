---
applyTo: "src/lib/provision.ts,src/lib/exec.ts,src/lib/qemu.ts,src/lib/license.ts,test/integration/**"
---

# Provisioning & RouterOS Debugging Instructions

## RouterOS "expired admin" is NOT a REST API Blocker

The `expired: true` flag on the admin account only triggers a password-change prompt
at CLI/Winbox/SSH login (bypassable with Ctrl-C). **RouterOS REST API and API sockets
are completely unaffected.** Authenticated requests with `admin:""` succeed on a fresh
CHR image regardless of the expired flag.

Do NOT add workarounds for `expired: true` on REST paths. If early REST responses
return unexpected data, the root cause is a **startup timing race** — not the expired
flag. Identify the actual condition (timing, RouterOS version, specific endpoint) and
fix that specifically.

## RouterOS Post-Boot REST Race

`waitForBoot` polls `/rest/system/resource` with a two-consecutive-OK guard and detects
the startup race (brief period where RouterOS returns wrong/array body) for that
endpoint. However, **the race affects ALL non-resource endpoints** — `/system/identity`,
`/system/license`, `/system/device-mode`, and others can also return wrong data briefly
after boot, even after `waitForBoot` returns true.

Each caller must handle this independently. The established pattern:

```typescript
// Retry until the response has the expected keys (up to N seconds)
const deadline = Date.now() + 20_000;
let lastBody = "";
while (Date.now() < deadline) {
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(5_000) });
    if (resp.ok) {
        const body = await resp.text();
        lastBody = body;
        const data = JSON.parse(body);
        if (data && typeof data === "object" && !Array.isArray(data) && "expected-key" in data) {
            return data; // Valid — stop polling
        }
    }
    await Bun.sleep(1_000);
}
throw new Error(`Endpoint did not return valid data within 20s (last: ${lastBody})`);
```

Callers that already implement this: `getLicenseInfo` (15s), `readDeviceMode` (30s
AbortSignal), `fetchUntilHasKeys` in anchor test (20s).

## Collecting RouterOS Logs for Debugging

When debugging provisioning or exec behavior, enable verbose logging on the CHR:

```routeros
# Enable debug-level logging (excluding noisy packet/raw topics)
/system/logging/add topics=debug,!packet,!raw action=memory

# Query logs via REST (or exec):
/log/print where message~"<basic-regex>"
```

Log topics hierarchy: `debug` < `info` < `warning` < `error`. Adding `raw,packet`
produces trace-level output (very verbose). Use `/log/print` with `where` to filter
server-side before returning results.

For packet-level debugging: `/tool/sniffer` with TZSP streaming, or `tcpdump`/`tshark`
on the host side of the QEMU network.

## Timeout Scaling Rules

Different acceleration modes have dramatically different boot/response times.
When setting timeouts, apply these scaling factors:

| Accel Mode          | Factor | Typical Boot | Notes                            |
|---------------------|--------|-------------|----------------------------------|
| x86 on x86 (KVM)   | 1×     | 5-10s       | Baseline                         |
| arm64 on arm64 (KVM)| 1×    | 5-10s       | Same as x86 KVM                  |
| arm64 on arm64 (HVF)| 1×    | 5-15s       | Apple Silicon                    |
| x86 on x86 (HVF)   | 1×     | 5-15s       | Intel Mac                        |
| arm64 on x86 (TCG)  | 2-4×   | 20-60s      | Manageable                       |
| x86 on arm64 (TCG)  | 10-20× | 60-300s     | Very slow, avoid in CI           |

When implementing timeouts:
- Use a base timeout (e.g., 30s for boot) and multiply by the scaling factor
- Provide a `--timeout-extra=<seconds>` CLI option that **adds** time (not replaces)
- Consider `detectAccel()` result to auto-scale timeouts
- Document the scaling in error messages when timeouts fire

## Provisioning Failure Modes

Before coding fixes to provisioning edge cases, **test locally** to understand the
actual behavior. Provisioning should be "transactional" — you either get the machine
you wanted, or you don't. Partial failures with "warnings" are errors.

Testing approach for failure modes:
1. Use `/system/logging` + `/log/print` to see what RouterOS actually does
2. Use QEMU monitor (`info status`, `info chardev`) to verify VM state
3. Test each provisioning step individually before changing the orchestration
4. Consider re-trying the entire create process as a last resort over partial recovery

## SSH Key Provisioning

For `exec --via=ssh` to work securely without passwords:
- The `quickchr` managed user path should include SSH key generation
- Store keys in the machine directory alongside other state
- Install the public key on the CHR during provisioning
- This makes SSH work even if the password is later changed
- Important: SSH key auth means `exec` always has a reliable path to the CHR
