# download-origin: `download.mikrotik.com` vs `cdn.mikrotik.com` (#146)

**Question:** does `cdn.mikrotik.com` serve the same RouterOS/CHR artifacts as
`download.mikrotik.com`, and does it behave the same, so the maintainer can ask
MikroTik whether it is a supported origin?

**Verdict: the CDN host looks equivalent.** It served the same bytes and the same
headers, with no errors and no stalls, from one local vantage point and from GitHub's
Linux, macOS and Windows runners. Its throughput was not consistently better or
worse. That makes the ticket worth sending ([TICKET-DRAFT.md](TICKET-DRAFT.md)), and
makes #243 useful: once a download base URL is configurable, `cdn.mikrotik.com` is a
value that works today. Two items stay open: freshness at a release boundary (no
release shipped during the probe) and support status (no MikroTik source found).

The data does not show the CDN host is faster, or that it is a geographic CDN. Both
names resolved to the same MikroTik /24 in Riga from every vantage point, with the
same TTFB.

## Maintainer's design stance (recorded, not proposed against)

- quickchr's core keeps **one documented download path**: `download.mikrotik.com`.
- If the CDN proves out, it is only ever an **opt-in value** for the configurable
  download base URL in #243. There is **no try-CDN-then-fall-back** scheme.
- Sequence: this probe first, then the maintainer files the MikroTik ticket. #243's
  priority depends on this result.

Because of that, this report does not evaluate primary or failover roles (steps 6–7
of #146's repro plan). The only role in question is "a value a user may set".

## Method

[`probe.ts`](probe.ts) is a standalone Bun script. It needs no CHR.

- **Channels** are resolved with quickchr's own `resolveVersion()`. Paths come from
  `chrDownloadUrl()` / `packagesDownloadUrl()` in `src/lib/versions.ts`, with only the
  hostname swapped. No production code changed.
- **Artifacts:** for every resolved version, on x86 and arm64: the CHR `.img.zip` and
  `all_packages-<arch>-<version>.zip` (12 artifacts).
- **Metadata per artifact and host:** `HEAD` (status, `content-length`, `etag`,
  `last-modified`, `accept-ranges`, rate-limit headers), a 1-byte `Range` GET, and
  the published `<file>.sha256`.
- **Integrity:** full downloads **from both hosts** while they fit in
  `--full-budget-mb`. Each body is SHA-256 hashed as it streams and compared with the
  other host and with the published `.sha256` from both hosts. Artifacts past the
  budget get three 1 MiB windows (start, middle, end) hashed on both hosts.
- **Timing:** every full download, plus `--rounds` paired byte ranges (same artifact
  and offset for both hosts in a round, offset random per round). Host order
  alternates by artifact and by round (A,B then B,A). `keepalive: false`, so every
  request pays DNS, TCP and TLS, like a one-shot `quickchr` download. TTFB is the time
  to response headers. Throughput is body MB/s (10⁶ B) after the first byte. A
  **stall** is a gap over 5 s between body chunks. An idle gap of 60 s aborts the
  request and counts as an error.
- **Identity:** DNS (CNAME, A, AAAA) via `node:dns`, plus a TLS handshake that records
  the peer address, certificate subject, issuer, SAN and validity.
- **User-Agent:** `routeros-download-origin-probe/1`. No account or project details.

## Runs

Channels at every run: long-term **7.24.6**, stable **7.25.1**, testing **7.25.1**,
development **7.26beta5**. Three distinct versions, so 12 artifacts.

| run | where | full-artifact budget | range rounds | bodies fetched | started (UTC) |
|---|---|---|---|---|---|
| `local-linux` | Linux workstation (Europe), Bun 1.4.4 | 1200 MB: all 12 artifacts, both hosts | 12 × 8 MiB | 981 MB | 2026-11-21 20:12 |
| `local-linux-2` | same | 200 MB: 2 x86 CHR images, both hosts | 16 × 16 MiB | 744 MB | 2026-11-21 20:17 |
| [44945141039](https://github.com/tikoci/quickchr/actions/runs/44945141039) | `ubuntu-latest`, `macos-latest`, `windows-latest` | 400 MB: all 6 CHR images, both hosts | 12 × 8 MiB | 629 MB per runner | 2026-11-21 20:13 |
| [44945494198](https://github.com/tikoci/quickchr/actions/runs/44945494198) | same three runners | same | same | 629 MB per runner | 2026-11-21 20:17 |

About 5.5 GB in total. Per-run summaries are in [`results/`](results/). The full JSON
for the local runs is committed. The CI JSON is in each run's
`download-origin-<os>` artifact.

## Integrity

**Every comparison was identical.** All 12 artifacts were full-hashed on both hosts
locally. All 6 CHR images were full-hashed on both hosts on each of the 3 runner OSes,
twice. Every full hash matched the published `.sha256`, which exists on both hosts for
every artifact and is byte-identical between them. Artifacts outside a run's budget
had identical 1 MiB windows. Nothing differed in any run.

| artifact | version | arch | published SHA-256 (same on both hosts, matched by every full download) |
|---|---|---|---|
| `chr-7.25.1.img.zip` | 7.25.1 | x86 | `c78e8e24ca78d7f13496140e600702df07fe5c57d1a5d6d025654c8476ed2ed2` |
| `chr-7.24.6.img.zip` | 7.24.6 | x86 | `692672e6cac9cfaa4f37c6334d07760d49e074b50befc61f0904270553f17126` |
| `chr-7.26beta5.img.zip` | 7.26beta5 | x86 | `c3feb5ecaae54d1ebc03fc97257ed361386863d658ebea1711b5140f33389a0f` |
| `chr-7.25.1-arm64.img.zip` | 7.25.1 | arm64 | `205e8408c61eeb0da7554e81b7ec508294b54b6d1a66d7e90fa57cd3f123a77e` |
| `chr-7.24.6-arm64.img.zip` | 7.24.6 | arm64 | `eeec0ee0105c7f295046b584464663707008bf19b3293b9a56be2d502665bae4` |
| `chr-7.26beta5-arm64.img.zip` | 7.26beta5 | arm64 | `26f8beb33ad91fbbd096a1e3886a1f89f80b9fa08a836c4a7db6484687ac747a` |
| `all_packages-x86-7.25.1.zip` | 7.25.1 | x86 | `12cf2b2725a505ac504c506578fbdee587ec999698e6a2dc533ca0837cfca169` |
| `all_packages-x86-7.24.6.zip` | 7.24.6 | x86 | `e8c07b6aa4ad5f6168d8858b581a5eeb955355da87c9dfba512866c47585a907` |
| `all_packages-x86-7.26beta5.zip` | 7.26beta5 | x86 | `85329ed801dbd19ae952cf295af3b6501478385d6676e52bb387670ce547db17` |
| `all_packages-arm64-7.25.1.zip` | 7.25.1 | arm64 | `7ddc73976af0e68ed8093b7cc8e0bf2f6a665d7dcf53b3b99f048ca132dc0c38` |
| `all_packages-arm64-7.24.6.zip` | 7.24.6 | arm64 | `316080cb36e8be4203f82267565b6f5ce941af07b62550c82f6f3e818586352b` |
| `all_packages-arm64-7.26beta5.zip` | 7.26beta5 | arm64 | `cbb7142701fcbb62e82e14783e1afb419fe074e397056286ec5ae7c3310b6db7` |

Full-hash count per host: 12 (local) + 2 (local-2) + 6 × 3 OSes × 2 runs = **50 full
downloads per host, 100 in total, 0 mismatches**.

## Headers

Identical on both hosts for all 12 artifacts, in every run (the probe flags any field
that differs, and none did):

| artifact | status | content-length | etag | last-modified | `Range: bytes=0-0` | `.sha256` |
|---|---|---|---|---|---|---|
| `chr-7.25.1.img.zip` | 200 | 45411298 | `"642d96fa554b811907e61ca1180ada21"` | Tue, 03 Nov 2026 10:23:18 GMT | 206 | 200 |
| `chr-7.24.6.img.zip` | 200 | 45300625 | `"9d4030fd27a09d07b237004d0754e4a3"` | Mon, 02 Nov 2026 11:45:00 GMT | 206 | 200 |
| `chr-7.26beta5.img.zip` | 200 | 46983270 | `"9cd8df97140b792763db8f74e2edbf99"` | Mon, 02 Nov 2026 12:24:34 GMT | 206 | 200 |
| `chr-7.25.1-arm64.img.zip` | 200 | 19244831 | `"3fa34e2eb57824a22f7160f7824e2bfc"` | Tue, 03 Nov 2026 10:23:18 GMT | 206 | 200 |
| `chr-7.24.6-arm64.img.zip` | 200 | 19208274 | `"b9415320150c1d7bf9e72ca4f1e058fd"` | Mon, 02 Nov 2026 11:45:00 GMT | 206 | 200 |
| `chr-7.26beta5-arm64.img.zip` | 200 | 19133647 | `"9a83c515519c2bc476b797af2c8d487f"` | Mon, 02 Nov 2026 12:24:34 GMT | 206 | 200 |
| `all_packages-x86-7.25.1.zip` | 200 | 10534340 | `"ca4999132b8143ac3e807beff33b2ccf"` | Tue, 03 Nov 2026 10:23:17 GMT | 206 | 200 |
| `all_packages-x86-7.24.6.zip` | 200 | 10476996 | `"6bc5446007355d2cd82749b9a72f93a3"` | Mon, 02 Nov 2026 11:45:00 GMT | 206 | 200 |
| `all_packages-x86-7.26beta5.zip` | 200 | 10923821 | `"1949f2b520042217b990320b8cfb9414"` | Mon, 02 Nov 2026 12:24:34 GMT | 206 | 200 |
| `all_packages-arm64-7.25.1.zip` | 200 | 57906586 | `"2777fb8c2f200434039346765fd4d0b2"` | Tue, 03 Nov 2026 10:23:17 GMT | 206 | 200 |
| `all_packages-arm64-7.24.6.zip` | 200 | 50611610 | `"41b2a0572e2cceb7de50a59f5b9f5036"` | Mon, 02 Nov 2026 11:45:00 GMT | 206 | 200 |
| `all_packages-arm64-7.26beta5.zip` | 200 | 53999411 | `"cdf7f4af5dfe0ec54bcc72692c227b66"` | Mon, 02 Nov 2026 12:24:34 GMT | 206 | 200 |

Both hosts send `accept-ranges: bytes`, `content-type: application/zip`, HSTS and the
same `x-ratelimit-limit` / `x-ratelimit-remaining` headers. Those, `date`, `etag` and
`last-modified` are the only other headers observed. Neither sends `server`,
`via`, `age`, `x-cache` or `cache-control`, the headers a caching CDN usually adds.

### Host identity

The same from the local machine and from all three runner OSes in both CI runs:

| host | DNS | TLS peer | certificate subject | SAN | issuer | valid to |
|---|---|---|---|---|---|---|
| `download.mikrotik.com` | CNAME `global-balancer-e.mikrotik.com` → 159.148.147.251, 2a02:610:7501:3000::251 | `…::251` locally, 159.148.147.251 on runners | `CN=mikrotik.com` | `*.mikrotik.com`, `mikrotik.com` | Let's Encrypt YE2 | 2027-01-22 |
| `cdn.mikrotik.com` | A 159.148.147.244, AAAA 2a02:610:7501:3000::244 (no CNAME) | `…::244` locally, 159.148.147.244 on runners | `CN=*.cdn.mikrotik.com` | `*.cdn.mikrotik.com`, `cdn.mikrotik.com` | Let's Encrypt YE2 | 2027-01-14 |

`upgrade.mikrotik.com` shares `global-balancer-e` with `download.mikrotik.com`.

### Observations that bear on #243

- **Both hosts serve the whole `routeros/` tree, channel files included.**
  `cdn.mikrotik.com/routeros/NEWESTa7.<channel>` and
  `download.mikrotik.com/routeros/NEWESTa7.<channel>` return the same bytes as
  `upgrade.mikrotik.com` (checked for all four channels; `CHANGELOG` also matches).
  So for these MikroTik hosts, one base URL could cover both downloads and channel
  lookup. A third-party mirror may not, so #243's second override is still needed.
- **Both names look like the same backend pool.** `x-ratelimit-limit` rotates through
  a small set of values (5707, 5726, 5727, 5737 in 12 + 12 sequential requests), and
  the same set shows up behind both hostnames. This is an inference from headers, not
  a fact about MikroTik's infrastructure.
- **`Last-Modified` is later than the channel timestamp** for all three versions, by
  the same amount on both hosts. Example: `NEWESTa7.stable` says 7.25.1 at 1793623193
  (2026-11-02 12:39 UTC), while its files show `Last-Modified` 2026-11-03 10:23 UTC.
  The files appear to have been rewritten after release. The hashes still match the
  `.sha256`. For #243 this means `Last-Modified` is not a reliable release timestamp.

## Timing and reliability

**0 errors and 0 stalls** (gaps over 5 s) on either host, in any run: 150 timed
transfers per host (full + range; the 1 MiB integrity windows are not counted). The longest gap between body chunks was 666 ms (Windows, cdn).

Per host, per run. "full" is a whole artifact. "range" is a paired byte range.

| run | host | full: n / MB/s min–p50–max / TTFB p50 | range: n / MB/s min–p50–max / TTFB p50 |
|---|---|---|---|
| local-linux | download | 12 / 3.26–8.92–12.27 / 796 ms | 12 × 8 MiB / 3.89–4.27–4.73 / 795 ms |
| local-linux | cdn | 12 / 2.53–8.31–11.93 / 804 ms | 12 × 8 MiB / 3.48–4.26–4.34 / 798 ms |
| local-linux-2 | download | 2 / 9.62–10.30–10.99 / 793 ms | 16 × 16 MiB / 5.04–7.12–7.84 / 801 ms |
| local-linux-2 | cdn | 2 / 9.06–9.71–10.36 / 808 ms | 16 × 16 MiB / 4.28–7.12–7.72 / 796 ms |
| ubuntu run 1 | download | 6 / 15.84–21.52–29.12 / 479 ms | 12 / 7.32–7.74–7.93 / 484 ms |
| ubuntu run 1 | cdn | 6 / 15.46–20.38–27.07 / 501 ms | 12 / 7.44–7.81–7.99 / 484 ms |
| ubuntu run 2 | download | 6 / 11.03–13.35–23.29 / 585 ms | 12 / 2.94–5.83–6.92 / 597 ms |
| ubuntu run 2 | cdn | 6 / 11.55–16.74–23.50 / 618 ms | 12 / 3.54–6.22–6.53 / 601 ms |
| macos run 1 | download | 6 / 4.46–12.62–19.68 / 514 ms | 12 / 6.69–7.13–7.58 / 527 ms |
| macos run 1 | cdn | 6 / 12.25–16.92–21.00 / 519 ms | 12 / 6.51–7.39–7.66 / 514 ms |
| macos run 2 | download | 6 / 12.68–16.27–20.84 / 482 ms | 12 / 7.27–7.63–7.83 / 494 ms |
| macos run 2 | cdn | 6 / 13.71–17.57–21.43 / 478 ms | 12 / 7.32–7.80–7.96 / 484 ms |
| windows run 1 | download | 6 / 5.33–9.98–14.51 / 529 ms | 12 / 6.22–6.93–7.14 / 527 ms |
| windows run 1 | cdn | 6 / 3.25–4.90–28.39 / 538 ms | 12 / 3.50–7.17–7.21 / 524 ms |
| windows run 2 | download | 6 / 5.94–7.31–27.17 / 477 ms | 12 / 3.72–7.02–7.93 / 479 ms |
| windows run 2 | cdn | 6 / 3.80–12.50–27.96 / 484 ms | 12 / 6.68–7.63–7.98 / 494 ms |

Paired comparison: the same bytes from both hosts back to back, order alternated. The
ratio is cdn MB/s ÷ download MB/s per pair.

| run | pairs | cdn faster | ratio min / p50 / max | p50 MB/s, first in pair vs second |
|---|---|---|---|---|
| local-linux | 24 | 8 | 0.48 / 0.99 / 1.56 | 4.81 vs 4.27 |
| local-linux-2 | 18 | 9 | 0.79 / 1.00 / 1.26 | 7.25 vs 7.31 |
| ubuntu run 1 | 18 | 8 | 0.87 / 1.00 / 1.04 | 7.93 vs 7.86 |
| ubuntu run 2 | 18 | 11 | 0.79 / 1.04 / 2.10 | 6.41 vs 6.47 |
| macos run 1 | 18 | 13 | 0.91 / 1.04 / 4.71 | 7.51 vs 7.41 |
| macos run 2 | 18 | 13 | 0.96 / 1.02 / 1.13 | 7.85 vs 7.80 |
| windows run 1 | 18 | 10 | 0.23 / 1.01 / 3.65 | 6.76 vs 7.16 |
| windows run 2 | 18 | 11 | 0.39 / 1.01 / 4.22 | 7.42 vs 7.34 |
| **all** | **150** | **83 (55%)** | p50 per run 0.99–1.04 | no consistent order effect |

How to read this:

- **No host difference.** The median paired ratio is 0.99–1.04 in every run.
  CDN-faster counts range from 8 of 24 to 13 of 18. Single-run medians differ, but
  the direction flips between runs. Windows run 1 had cdn full p50 4.90 vs download
  9.98 MB/s, and run 2 had cdn 12.50 vs download 7.31. That is runner variance
  (Windows full transfers ranged from 5.3 to 27.2 MB/s on download and 3.3 to
  28.4 MB/s on cdn), not host behavior.
- **TTFB depends on distance, not host.** About 795 ms locally and about 480–600 ms
  on US runners, the same on both hosts in every run. With a fresh TLS 1.3 connection
  per request, that fits both names terminating in Riga. Nothing suggests an edge
  closer to the US runners.
- **Byte ranges are slow-start bound.** 8 MiB ranges plateau at 4.3 MB/s locally and
  7–8 MB/s on runners. Full artifacts reach 10–29 MB/s. So the range rows compare the
  hosts' connection setup and early window, and the full rows compare sustained
  throughput.
- **The glacial transfers from #146's evidence did not reproduce.** In the
  2026-09-16 session a 43 MB image took 236 s at 0.18 MB/s. Here the slowest full
  artifact was 2.5 MB/s, and nothing stalled. A sample with no bad hours cannot show
  whether the CDN host avoids them.

## Freshness at a release boundary: **open**

**No RouterOS release shipped while the probe ran.** Channels stayed at 7.24.6 /
7.25.1 / 7.25.1 / 7.26beta5 from 20:07 to 20:25 UTC on 2026-11-21. The `watch` mode
polled both hosts every 120 s for 7.26beta6, 7.26rc1, 7.25.2 and 7.24.7 and saw none
of them. No claim about release-time freshness is made.

What this run does show: the current files and channel pointers are identical on both
hosts, including `Last-Modified` and `ETag`. The latest release is about 19 days old,
so this does not measure propagation lag.

**To close it, when a release ships** (betas usually arrive every one to two weeks;
the last one, 7.26beta5, is from 2026-10-30), start the watcher **before** the
expected release and leave it running:

```sh
# Poll channel pointers on both hosts, plus the expected next versions' x86 CHR
# image and .sha256, every 60 s for up to 7 days. Records the first time each host
# serves each item.
bun test/lab/download-origin/probe.ts watch \
  --label=release-boundary --interval-s=60 --duration-min=10080 \
  --expect=7.26beta6,7.26rc1,7.25.2,7.24.7
# Output: test/lab/download-origin/results/watch-release-boundary.jsonl
#   "first-seen" lines: per host, NEWESTa7.<channel>, image and .sha256
#   "both-hosts-serving" with sha256Agree, once both hosts serve a version
```

Then run `probe.ts run --label=post-release` once to re-hash the new version on both
hosts. Record in this report: the first-seen times per host, the lag between hosts,
and whether `.sha256` agreed. If the version appears on one host only for a while,
that goes into the ticket.

The watcher uses `NEWESTa7.*` on both hosts plus `--expect` because a release can
appear as files before the channel pointer moves. Each poll costs 8 small GETs plus
4 per expected version per host. Adjust `--expect` to the versions actually due.

## Support status: **no authoritative MikroTik source found**

Checked on 2026-11-21:

- [mikrotik.com/download/routeros](https://mikrotik.com/download/routeros?architecture=x86):
  69 artifact links, all on `download.mikrotik.com/routeros/`. The only
  `cdn.mikrotik.com` link is `cdn.mikrotik.com/fdroid/repo` (the F-Droid
  repository). The same holds on `/download/tools` (27 vs F-Droid only) and
  `/download/winbox` (12 vs F-Droid only).
- [Upgrading and installation](https://help.mikrotik.com/docs/spaces/ROS/pages/328142/Upgrading%2Band%2Binstallation):
  its manual `/tool fetch` example uses `download.mikrotik.com`.
- A web search for `"cdn.mikrotik.com"` on help.mikrotik.com and in general found no
  RouterOS documentation for it.

So `download.mikrotik.com` is the documented origin. `cdn.mikrotik.com` is
**undocumented for RouterOS artifacts**: neither supported nor unsupported. Treat that
as a deployment risk until MikroTik answers. Answering it is the purpose of
[TICKET-DRAFT.md](TICKET-DRAFT.md).

## Verdict, in the maintainer's terms

**CDN looks equivalent → worth a ticket, and it makes #243 useful.**

- Same bytes: 100 full downloads, 0 mismatches, all matching MikroTik's `.sha256`.
- Same headers, same channel files.
- Same reliability: 0 errors and 0 stalls in 150 timed transfers per host.
- Same speed: median paired ratio 0.99–1.04, cdn faster in 83 of 150 pairs.

It is **not** shown to be faster, geographically distributed, or as fresh at release
time. The ticket should say exactly that (the draft does).

For #243: a configurable base URL set to `https://cdn.mikrotik.com/routeros` would
work today with no other change. Because the CDN host also serves `NEWESTa7.*`, it can
answer channel lookups too. quickchr's default and documented path stays
`download.mikrotik.com`, with no fallback between hosts.

## Re-running

```sh
# Full local probe (about 1 GB at the default budget; lower --full-budget-mb to hash less)
bun test/lab/download-origin/probe.ts run --label=local --full-budget-mb=1200 --rounds=12

# Hosted runners (Linux, macOS, Windows): dispatch-only lab job, never on push
gh workflow run lab.yml --ref <branch> -f lab=download-origin \
  -f download-origin-budget-mb=400 -f download-origin-rounds=12
```

## Open items

- Release-boundary freshness: see above. Re-run `watch` across the next release.
- Support status: the maintainer's MikroTik ticket.
- #243: implementation is independent of this probe. This report only shows that
  `cdn.mikrotik.com` is a working value for that setting.
