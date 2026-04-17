# Lab Report: SLiRP hostfwd — Does It Work Without a Guest IP?

## Date

2026-04-17

## Environment

- **CHR**: RouterOS 7.22.1 (x86_64)
- **Host**: Intel Mac (macOS Darwin x86_64), Bun 1.3.11
- **QEMU**: 10.2.2 with HVF acceleration (x86-on-x86)
- **socket_vmnet**: running (`/usr/local/var/run/socket_vmnet`, gateway 192.168.105.1)

## Question

When quickchr uses both `user` (SLiRP) and `shared` (vmnet) networks, NIC order determines
which RouterOS interface is ether1 vs ether2. RouterOS only auto-creates a DHCP client on
ether1. Does SLiRP hostfwd (the `localhost:91xx` port forwarding) work if the SLiRP interface
has no IP assigned?

## Background

QEMU SLiRP (`-netdev user`) provides:

- A virtual NAT network (default 10.0.2.0/24)
- Built-in DHCP server (assigns 10.0.2.15 to guest)
- DNS forwarder (10.0.2.3)
- Port forwarding via `hostfwd=tcp::HOST-:GUEST`

`hostfwd` works by:

1. QEMU opens a TCP listener on the host (e.g., `127.0.0.1:9110`)
2. When a connection arrives, SLiRP **accepts it immediately** on the host side
3. SLiRP then creates a TCP SYN destined for the guest IP (default `10.0.2.15`) on the guest port
4. The SYN is delivered as an Ethernet frame to the guest's virtual NIC
5. Guest must have `10.0.2.15` as a local address to accept the connection

## Experiments

### Experiment 1: Baseline — SLiRP on ether1 (default)

```bash
quickchr start slirp-exp1 --arch x86 --background --no-provision
```

**Result:**

- ether1 auto-DHCP → 10.0.2.15/24, gateway 10.0.2.2
- `curl -u admin: http://127.0.0.1:9110/rest/system/resource` → 200 OK ✅
- Full REST API operational

### Experiment 2: Remove IP from SLiRP interface

```bash
# Delete DHCP client (removes 10.0.2.15 from ether1)
curl -u admin: http://127.0.0.1:9110/rest/ip/dhcp-client/*1 -X DELETE
```

**Result:**

- `curl -v -m 10 http://127.0.0.1:9110/rest/ip/address`:
  - "Connected to 127.0.0.1 port 9110" ← **TCP connects** (SLiRP accepts on host side)
  - "Operation timed out after 10005 milliseconds with 0 bytes received" ← **HTTP hangs**
- **SLiRP creates a half-open connection**: host-side accepted, guest-side SYN never answered

**Mechanism**: Without 10.0.2.15 as a local address, the guest either:

- Drops the SYN at L3 (destination IP doesn't match any local address), or
- ARP for 10.0.2.15 fails and SLiRP can't deliver the frame

Either way, data never flows. The TCP connect succeeding on the host side is misleading —
it's purely SLiRP's host-side socket, not an end-to-end connection.

### Experiment 3: Two NICs — user (ether1) + shared (ether2)

```bash
quickchr start slirp-exp2 --arch x86 --background --no-provision \
  --add-network user --add-network shared
```

**Result:**

- ether1 (SLiRP): auto-DHCP → 10.0.2.15/24 ✅
- ether2 (shared/socket_vmnet): **no IP** — no auto-DHCP client, `status=searching...`
- REST API works via ether1 hostfwd ✅
- Can add DHCP client on ether2 via REST: `POST /rest/ip/dhcp-client/add`

### Experiment 4: Reversed NIC order — shared (ether1) + user (ether2)

```bash
quickchr start slirp-exp3 --arch x86 --background --no-provision \
  --add-network shared --add-network user
```

**Result:**

- `waitForBoot` timeout after 120s ❌
- ether1 (shared): auto-DHCP client created, but DHCP server response depends on vmnet
- ether2 (SLiRP): **no auto-DHCP client** → no IP → hostfwd half-opens → HTTP hangs
- Machine auto-cleaned on timeout

## Conclusions

### 1. SLiRP hostfwd REQUIRES a guest IP

hostfwd creates connections to a specific guest IP (default 10.0.2.15). Without that IP
configured on the guest interface, the guest cannot accept the forwarded TCP connection.
The host-side connect succeeds (SLiRP accepts immediately), but data never flows —
resulting in HTTP timeouts, not connection refused.

**Implication for `waitForBoot`**: The per-probe HTTP timeout (currently 3s) applies to
every probe when the guest has no IP. With a 120s total timeout and 2s sleep between
probes, that's ~24 probes × 3s timeout = 72s wasted on half-open connections before
the overall timeout fires. The probes don't fail fast (ECONNREFUSED) — they fail slow
(timeout).

### 2. SLiRP MUST be on ether1 (current ordering is correct)

RouterOS auto-creates a DHCP client on ether1 only. SLiRP has a built-in DHCP server.
Therefore SLiRP on ether1 guarantees an IP without any provisioning. This is the only
NIC position where hostfwd works out of the box.

### 3. Shared/bridged on ether2 needs manual DHCP client

When adding a second network (shared, bridged), it goes on ether2+. RouterOS does not
auto-create DHCP clients on those interfaces. To get an IP:

```json
POST /rest/ip/dhcp-client/add
{"interface":"ether2","use-peer-dns":"yes","add-default-route":"yes","default-route-distance":"2"}
```

This is safe to do via REST over SLiRP ether1 (provisioning step), but has side effects:

- Two default gateways (ECMP if same distance, backup if different distance)
- Two DNS servers (random selection per query)
- Use `default-route-distance=2` to make shared the backup route

### 4. The "attractive positioning" is confirmed viable

The user's hypothesis: "SLiRP on ether1, shared on ether2, no extra DHCP config needed
for localhost access" is correct. SLiRP-first is the right default:

- **Provisioning**: Works immediately via `localhost:91xx` — no login to RouterOS needed
- **Discovery**: If the user wants MNDP discovery or real IP on shared, they can add
  DHCP client on ether2 via REST after boot (or via a provisioning step)
- **No side effects**: Single DHCP client, single default route, clean routing table

### 5. SLiRP half-open behavior is a hazard for aarch64 TCG

On aarch64-on-aarch64 TCG (GitHub ARM64 runners), SLiRP's slow TCP stack + half-open
connections exacerbate hangs. If for any reason the DHCP client is slow to bind (startup
race), `waitForBoot` probes will half-open and each one burns the full per-probe timeout.
Under TCG where a single TCP round-trip can take many seconds, this compounds badly.

**Recommendation**: Consider a pre-flight check in `waitForBoot` that does a raw TCP
connect with a short timeout (500ms). If it connects but gets no data within 1s, log
a diagnostic: "SLiRP accepted connection but guest not responding — possible missing IP".

## Open Questions

1. **Can SLiRP hostfwd be configured to target a different guest IP?**
   Yes: `hostfwd=tcp::9110-10.0.2.100:80` — but this requires the guest to have that
   specific IP. Does not solve the "no IP on interface" problem.

2. **Does RouterOS auto-DHCP on ether1 behave differently on ARM64 CHR?**
   Not tested in this lab. Should be identical (same RouterOS code), but ARM64 TCG boot
   timing may delay DHCP client binding.

3. **Would a static IP on the SLiRP interface work without DHCP?**
   Yes — `10.0.2.15/24` as a static address should work. But adding it requires serial
   console access (can't use REST without an IP). Not practical for automated provisioning.

4. **Why did socket_vmnet shared fail to provide DHCP on ether2 (Experiment 3)?**
   ether2 showed `tx=35 rx=0` — DHCP Discover packets sent but no response received.
   May be a socket_vmnet configuration issue on this specific machine (bridge100 appears
   to be a bridged setup, not the shared NAT). Needs further investigation separately.
