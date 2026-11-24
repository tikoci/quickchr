# download-origin probe: windows-latest

2026-11-21T20:17:48.304Z → 2026-11-21T20:20:43.698Z · Bun 1.4.4 · win32/x64
Body bytes fetched: 630 MB (budget for full artifacts: 400 MB)

Channels: stable 7.25.1, long-term 7.24.6, testing 7.25.1, development 7.26beta5

## Host identity

| host | CNAME | A | AAAA | TLS peer | cert subject | issuer | SAN | valid to |
|---|---|---|---|---|---|---|---|---|
| download.mikrotik.com | global-balancer-e.mikrotik.com | 159.148.147.251 | 2a02:610:7501:3000::251 | 159.148.147.251 | CN=mikrotik.com | C=US, O=Let's Encrypt, CN=YE2 | DNS:*.mikrotik.com, DNS:mikrotik.com | Jan 22 23:30:06 2027 GMT |
| cdn.mikrotik.com | ENOTFOUND | 159.148.147.244 | 2a02:610:7501:3000::244 | 159.148.147.244 | CN=*.cdn.mikrotik.com | C=US, O=Let's Encrypt, CN=YE2 | DNS:*.cdn.mikrotik.com, DNS:cdn.mikrotik.com | Jan 14 06:25:32 2027 GMT |

## Integrity

| file | channels | mode | published sha256 | verdict |
|---|---|---|---|---|
| chr-7.25.1.img.zip | stable+testing | full | `c78e8e24ca78…` | identical; matches published .sha256 on both hosts |
| chr-7.24.6.img.zip | long-term | full | `692672e6cac9…` | identical; matches published .sha256 on both hosts |
| chr-7.26beta5.img.zip | development | full | `c3feb5ecaae5…` | identical; matches published .sha256 on both hosts |
| chr-7.25.1-arm64.img.zip | stable+testing | full | `205e8408c61e…` | identical; matches published .sha256 on both hosts |
| chr-7.24.6-arm64.img.zip | long-term | full | `eeec0ee0105c…` | identical; matches published .sha256 on both hosts |
| chr-7.26beta5-arm64.img.zip | development | full | `26f8beb33ad9…` | identical; matches published .sha256 on both hosts |
| all_packages-x86-7.25.1.zip | stable+testing | windows | `12cf2b2725a5…` | 3 × 1 MiB windows identical; published .sha256 identical on both hosts |
| all_packages-x86-7.24.6.zip | long-term | windows | `e8c07b6aa4ad…` | 3 × 1 MiB windows identical; published .sha256 identical on both hosts |
| all_packages-x86-7.26beta5.zip | development | windows | `85329ed801db…` | 3 × 1 MiB windows identical; published .sha256 identical on both hosts |
| all_packages-arm64-7.25.1.zip | stable+testing | windows | `7ddc73976af0…` | 3 × 1 MiB windows identical; published .sha256 identical on both hosts |
| all_packages-arm64-7.24.6.zip | long-term | windows | `316080cb36e8…` | 3 × 1 MiB windows identical; published .sha256 identical on both hosts |
| all_packages-arm64-7.26beta5.zip | development | windows | `cbb7142701fc…` | 3 × 1 MiB windows identical; published .sha256 identical on both hosts |

## Headers (compared across hosts)

| file | status | content-length | etag | last-modified | 1-byte range | .sha256 | differs |
|---|---|---|---|---|---|---|---|
| chr-7.25.1.img.zip | 200/200 | 45411298 | `"642d96fa554b811907e61ca1180ada21"` | Tue, 03 Nov 2026 10:23:18 GMT | 206/206 | 200/200 | no |
| chr-7.24.6.img.zip | 200/200 | 45300625 | `"9d4030fd27a09d07b237004d0754e4a3"` | Mon, 02 Nov 2026 11:45:00 GMT | 206/206 | 200/200 | no |
| chr-7.26beta5.img.zip | 200/200 | 46983270 | `"9cd8df97140b792763db8f74e2edbf99"` | Mon, 02 Nov 2026 12:24:34 GMT | 206/206 | 200/200 | no |
| chr-7.25.1-arm64.img.zip | 200/200 | 19244831 | `"3fa34e2eb57824a22f7160f7824e2bfc"` | Tue, 03 Nov 2026 10:23:18 GMT | 206/206 | 200/200 | no |
| chr-7.24.6-arm64.img.zip | 200/200 | 19208274 | `"b9415320150c1d7bf9e72ca4f1e058fd"` | Mon, 02 Nov 2026 11:45:00 GMT | 206/206 | 200/200 | no |
| chr-7.26beta5-arm64.img.zip | 200/200 | 19133647 | `"9a83c515519c2bc476b797af2c8d487f"` | Mon, 02 Nov 2026 12:24:34 GMT | 206/206 | 200/200 | no |
| all_packages-x86-7.25.1.zip | 200/200 | 10534340 | `"ca4999132b8143ac3e807beff33b2ccf"` | Tue, 03 Nov 2026 10:23:17 GMT | 206/206 | 200/200 | no |
| all_packages-x86-7.24.6.zip | 200/200 | 10476996 | `"6bc5446007355d2cd82749b9a72f93a3"` | Mon, 02 Nov 2026 11:45:00 GMT | 206/206 | 200/200 | no |
| all_packages-x86-7.26beta5.zip | 200/200 | 10923821 | `"1949f2b520042217b990320b8cfb9414"` | Mon, 02 Nov 2026 12:24:34 GMT | 206/206 | 200/200 | no |
| all_packages-arm64-7.25.1.zip | 200/200 | 57906586 | `"2777fb8c2f200434039346765fd4d0b2"` | Tue, 03 Nov 2026 10:23:17 GMT | 206/206 | 200/200 | no |
| all_packages-arm64-7.24.6.zip | 200/200 | 50611610 | `"41b2a0572e2cceb7de50a59f5b9f5036"` | Mon, 02 Nov 2026 11:45:00 GMT | 206/206 | 200/200 | no |
| all_packages-arm64-7.26beta5.zip | 200/200 | 53999411 | `"cdf7f4af5dfe0ec54bcc72692c227b66"` | Mon, 02 Nov 2026 12:24:34 GMT | 206/206 | 200/200 | no |

## Timing

Stall = gap > 5000 ms between body chunks. Fresh connection per request (keepalive off). Throughput is body MB/s (1e6) after the first byte.

| host | kind | trials | errors | stalls | max gap ms | MB/s min / p50 / max | TTFB ms min / p50 / max |
|---|---|---|---|---|---|---|---|
| download.mikrotik.com | full | 6 | 0 | 0 | 423 | 5.94 / 7.32 / 27.18 | 472 / 478 / 498 |
| download.mikrotik.com | range | 12 | 0 | 0 | 124 | 3.72 / 7.03 / 7.93 | 471 / 479 / 544 |
| cdn.mikrotik.com | full | 6 | 0 | 0 | 667 | 3.81 / 12.50 / 27.96 | 471 / 484 / 514 |
| cdn.mikrotik.com | range | 12 | 0 | 0 | 124 | 6.68 / 7.64 / 7.99 | 469 / 494 / 520 |

Paired (same bytes, both hosts, order alternated): 18 pairs; cdn faster in 11; cdn/download throughput ratio min 0.39 / p50 1.01 / max 4.23.
Position effect: first-in-pair p50 7.42 MB/s vs second-in-pair p50 7.34 MB/s.
