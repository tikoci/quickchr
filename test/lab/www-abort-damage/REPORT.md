# Lab Report: Does an aborted REST probe damage RouterOS `www`?

## Date

2026-07-29

## Environment

- **CHR**: RouterOS 7.21.5 (long-term), 1 vCPU, 512 MiB, factory defaults (`--no-secure-login`)
- **Host**: Intel Mac (macOS Darwin x86_64), Bun 1.3.14, QEMU from Homebrew `/usr/local`
- **Accel**: x86 guest under **HVF**, arm64 guest under **cross-arch TCG** — both tested
- **Network**: default SLiRP `user` NIC, REST reached over hostfwd on `127.0.0.1`

## Question

[#79][i79] reports that a post-`clean()` relaunch never becomes REST-ready on CI:
96 consecutive probes, all aborted at their deadline, `www` serving nothing for
480 s while every other service (`ssh`, `api`, `api-ssl`, `winbox`) stayed up.
The proposed mechanism was that quickchr's own probe does the damage —
`restGet()` destroys the socket at a hardcoded 3 s deadline, and enough of those
leave `www` unable to accept.

That was an inference from one socket table. Is it true, and is it arm64-specific?

## Background

Two pieces of quickchr code meet here:

- `waitForBoot()` (`src/lib/qemu.ts:538`) probes `/rest/system/resource` every
  2 s until the overall budget expires. The budget is accel-scaled
  (`120_000 × accelTimeoutFactor`, up to 480 s); the per-probe deadline on the
  same line is the literal `3000`.
- `restGet()` (`src/lib/rest.ts:41`) implements that deadline as
  `req.destroy()` — a mid-flight TCP teardown, not a graceful close.

## Experiments

All health checks use `curl` in a **separate process**. If `curl` sees the same
failure as Bun's `node:http`, no client-side socket reuse can explain it.

### Experiment 1 — is one aborted probe harmful?

Abort a request at 50 ms (past connect and request-send, before the ~125 ms
failed-login answer), then probe at delays from 0 ms to 3000 ms.

**Result: no.** 9 delays × 3 probes each, all `HTTP 200` in 15–48 ms. A lone
aborted probe leaves no trace.

### Experiment 2 — do consecutive aborts accumulate?

N ∈ {2, 3, 5} aborts, gap G ∈ {0, 500, 1000, 2000} ms, then 4 health probes.

**Result: no.** All 12 cells clean, `200` on every probe. Aborts alone — even
five in a row — do not exhaust anything.

### Experiment 3 — the discriminator

Experiments 1 and 2 were clean, but the original ad-hoc loop reproduced damage
every time. The two differ in one thing: the ad-hoc loop let a request
**complete** between aborts. Run both patterns back to back, twice:

| Pattern | Sequence | Outcome |
|---------|----------|---------|
| A | `abort` × 4, 1 s apart, nothing completing between | `[ABORT,ABORT,ABORT,ABORT]` → `curl=200 curl=200` |
| B | (`abort`, then a **completed** request) × 4, 1 s apart | `[ABORT/200  RST/RST  RST/RST  ABORT/401]` → `curl=rc56 curl=rc56` |

**Both rounds byte-identical.** Pattern B is the damaging one, and it is
deterministic.

Read pattern B's output:

- pair 1 — we abort; the following request still succeeds (`200`)
- pairs 2 and 3 — **the guest resets every connection**, ours and `curl`'s alike
- pair 4 — a connection survives and is answered **`401`** … while sending
  `admin:` with its valid empty password. `401` is the status computed for the
  *aborted* `cleanuser` request, delivered to a different connection.

### Experiment 4 — architecture and recovery

Formalized as `www-abort-damage.test.ts` and run against both guests.

**Result:** 5/5 pass on x86/HVF (twice) and on arm64 cross-arch TCG. `www`
recovers on its own within a few seconds of the last abort — polled, and measured
at 1344 / 2301 / 2309 / 2376 ms across four runs.

### Experiment 5 — reproducing CI's failure end to end

Full CI scenario locally on arm64/TCG: boot with `cleanuser`, `stop()`,
`clean()`, relaunch, `waitForBoot()`.

**Result: `waitForBoot` resolved true in 51 s.** Also checked: 60 consecutive
probes at `waitForBoot`'s exact cadence, with the stale credentials, against a
guest held at `cpu-load: 100` → **60/60 clean `401`s**, no abort, no wedge.

## Conclusions

Established here:

1. **`clean()` leaves `state.user` naming the deleted user.** Inspected
   `machine.json` after a factory reset: still `{"user": {"name": "cleanuser"}}`.
   Confirms defect A of [#79][i79].
2. **Defect A alone is not fatal.** `waitForBoot()` accepts `401` as proof the
   REST layer responded, so probing as a deleted user is survivable — provided
   the answer arrives.
3. **An aborted probe followed by a completed request corrupts `www`.**
   Deterministic, guest-side (`curl` sees it), and reproduced on **both** x86/HVF
   and arm64/TCG — **not arm64-specific**, which is the load-bearing part of
   [#79][i79]'s claim.
4. **The corruption is a wrong answer, not just a lost one.** A caller is handed
   the status computed for a different request. Any code that trusts a REST
   status after a timeout can act on another request's result. Same family as
   [#69][i69].
5. **`waitForBoot()` generates exactly this pattern.** Probe overruns 3 s → abort;
   next probe 2 s later completes → pair. The loop damages the service it is
   waiting for.

Not established — stated plainly because [#79][i79]'s write-up asserts it:

- **The permanent wedge did not reproduce.** Here `www` recovers in 1.3–2.4 s.
   "After five aborts `www` stops accepting SYNs forever" remains an inference
   from CI's socket table, not a demonstrated fact.
- **The trigger for CI's *first* abort is still unexplained.** Every CI probe
   timed out starting with the first at 3001 ms, so something made that first
   response take over 3 s. Locally the failed login answers in ~125 ms even at
   `cpu-load: 100`. Whatever slows that first response on a hosted arm64 runner
   is not reproduced here — and it is the entry point to the whole failure.

## Open issues

- The per-probe deadline is unscaled while the budget it lives in is scaled
  ([#79][i79] defect B, [#106][i106] for the envelope). Findings 3–5 say a
  slow-but-alive REST layer should be *waited for*, not aborted.
- Backing off after consecutive aborted probes (rather than continuing the
  abort/complete alternation) is supported by finding 3: it is the *pattern*,
  not the count, that does the damage.
- The unexplained first abort needs a hosted arm64 runner to chase. The CI
  forensics in [#79][i79] are currently the only place it has been seen.

[i69]: https://github.com/tikoci/quickchr/issues/69
[i79]: https://github.com/tikoci/quickchr/issues/79
[i106]: https://github.com/tikoci/quickchr/issues/106
