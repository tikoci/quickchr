# Support ticket draft: is `cdn.mikrotik.com` a supported origin for RouterOS/CHR files?

Draft for the maintainer to send to MikroTik support. Measurement details are in
[REPORT.md](REPORT.md). Edit freely before sending.

---

**Subject:** Is cdn.mikrotik.com a supported download host for RouterOS / CHR files?

Hello,

We maintain an open-source tool that downloads RouterOS CHR images and the
all-packages zip from `https://download.mikrotik.com/routeros/<version>/` to run CHR
under QEMU for testing. We noticed that `https://cdn.mikrotik.com/routeros/<version>/`
serves the same paths, and we compared the two hosts on 2026-11-21.

What we observed:

- **Same files.** For RouterOS 7.24.6 (long-term), 7.25.1 (stable and testing) and
  7.26beta5 (development), on x86 and arm64, the CHR `.img.zip` and the
  `all_packages-*.zip` files downloaded from both hosts had identical SHA-256 hashes,
  and the hashes matched the published `.sha256` file on both hosts. Sizes, ETags and
  Last-Modified headers were identical, and both hosts support byte ranges.
- **Same network location.** From our location and from GitHub-hosted runners in the
  US, `download.mikrotik.com` (CNAME `global-balancer-e.mikrotik.com`) resolved to
  159.148.147.251 and `cdn.mikrotik.com` to 159.148.147.244. Response times were the
  same for both hosts. The TLS certificates differ (`*.mikrotik.com` and
  `*.cdn.mikrotik.com`).
- **Same reliability in our sample.** Across our runs (one location plus GitHub's
  Linux, macOS and Windows runners) we saw no errors or stalled transfers on either
  host, and no consistent throughput difference between them.
- `cdn.mikrotik.com/routeros/NEWESTa7.<channel>` also answers, with the same content
  as `upgrade.mikrotik.com`.

We could not find `cdn.mikrotik.com` in the documentation or on the download pages,
apart from the F-Droid repository link. Our questions:

1. Is `cdn.mikrotik.com` a supported, stable host for RouterOS and CHR downloads that
   third-party tools may use, or is it internal and subject to change?
2. If it is supported, is a new release published to both hosts at the same time?
3. If neither host is preferred for automated downloads, is there a host or
   practice you would recommend for tools that download CHR images in CI (for
   example, a rate limit to stay under)?

Our tool will keep `download.mikrotik.com` as its default either way. We are asking
so we can document whether `cdn.mikrotik.com` is a valid alternative for users who
choose to configure one.

Thank you.
