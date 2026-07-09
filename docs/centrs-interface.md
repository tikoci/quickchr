# quickchr ↔ centrs Interface — Live Descriptor Contract (v1)

> **Status:** Contract/spec document. This is the durable, agent-ready home for the
> work tracked in [#71](https://github.com/tikoci/quickchr/issues/71) (and the broader
> quickchr → centrs provider relationship). It supersedes the long comment thread on
> #71: where this document and #71 disagree, **this document wins** unless #71 has a
> newer decision that has been folded back in here.
>
> Design rationale for the surrounding surface lives in [DESIGN.md](../DESIGN.md)
> ("Provisioning Scope", "Agent-Friendliness"). Open work is tracked as GitHub Issues
> (`consumer:centrs` on quickchr, `provider-quickchr` on centrs).
>
> **Audience:** an implementing agent (quickchr side) and a consuming agent (centrs
> side). Read [The relationship](#the-relationship) and [Descriptor v1 shape](#descriptor-v1-shape)
> first; use [Staged implementation plan](#staged-implementation-plan) to actually build it.

---

## Why this document exists

`tikoci/centrs#134` lets a user write `centrs --quickchr <name> …` to target a
quickchr-managed CHR VM. Centrs must resolve that VM's live connection facts —
host, ports, TLS, auth per service — **through quickchr's public API only**, never
by reading `machine.json`, `quickchr.env`, or quickchr's credential store directly.

`ChrInstance.descriptor()` / `quickchr inspect` is that bridge. But the *current*
descriptor (`MachineDescriptor`, `src/lib/types.ts:386`) is a flat "here are all the
ports and one auth blob" shape. Centrs needs a **structured, per-service, versioned**
contract so it can pick a `--via` transport and get exactly the endpoint + auth for
that transport, with a stable compatibility boundary and typed handling of old
quickchr versions.

This doc defines that contract (descriptor **v1**), the division of responsibility
between the two projects, and a staged plan to implement it on the quickchr side.

---

## The relationship

Two projects, one seam. Keep the boundary crisp — most past churn came from blurring it.

| quickchr owns (the provider) | centrs owns (the consumer) |
|---|---|
| Resolving its own settings + secrets (never asks centrs to read them) | Validation, RouterOS-shaped command checking |
| Emitting a credential-bearing **handoff descriptor** for a *running* machine | Envelopes, `--via` selection, fan-out, typed errors |
| Connection facts it can actually vouch for (SLiRP-forwarded loopback ports) | Settings provenance/merge, CLI override precedence |
| Typed errors for stopped/missing machines (`MACHINE_STOPPED`, `MACHINE_NOT_FOUND`) | Choosing whether/how to consume optional descriptor fields |

Load-bearing consequences:

- **No runtime coupling.** Centrs imports `@tikoci/quickchr` only when the user opts
  into `--quickchr`. quickchr has no build-time or runtime dependency on centrs.
- **quickchr does not provision centrs features.** No btest-specific or any
  consumer-feature-specific RouterOS setup. quickchr stays focused on core VM/system
  setup (license, device-mode, admin access, the managed SSH key).
- **quickchr does not expose centrs transfer methods.** `sftp` is a centrs transfer
  method layered on the `ssh` service — it is not a quickchr service key.
- **The descriptor is credential-bearing by design.** Both sides must treat
  `password` / `header` / `basic` as secret material and never log the values.

---

## Forward-compat policy

`descriptorVersion` is the schema compatibility boundary. This mirrors TikTOML's
`tikoci/centrs#137` ignore-unknown rule, so centrs' external provider schemas share
one forward-compat policy.

- `descriptorVersion: 1` today.
- **Changes within a `descriptorVersion` are additive-only** (new optional fields /
  new `services` keys / new `networks` entries).
- **Consumers must ignore unknown fields.** A future `services["mac-telnet"]` key, or
  a new `networks` entry kind, is just a new property existing consumers already
  ignore — no version bump.
- **Bump `descriptorVersion` only for a breaking descriptor-schema change** (removing
  or retyping an existing field, changing an established semantic).

Consumer rule (centrs): reject a quickchr whose `descriptorVersion` is higher than it
understands, or whose `descriptor()` is absent/old-shaped, with a typed/friendly error
— do not best-effort-parse an unknown major shape.

---

## Descriptor v1 shape

This is the canonical target shape. Top-level machine-identity fields
(`name`/`version`/`arch`/`cpu`/`mem`/`pid`/`machineDir`/`createdAt`/`lastStartedAt`)
carry over from the current `MachineDescriptor` (`src/lib/types.ts:386`); the
`services` map replaces the old flat `ports`/`urls`/`auth` trio. **This is a breaking
restructure of `MachineDescriptor`, not an additive change** — see
[Backward compatibility](#backward-compatibility).

```ts
interface Descriptor {
  descriptorVersion: 1;
  quickchr: { packageVersion: string };   // no apiVersion — see "Dropped fields"
  status: "running";                       // descriptor() only ever returns a running shape;
                                           // stopped/missing throw MACHINE_STOPPED / MACHINE_NOT_FOUND as today

  // machine identity — carried over from the current MachineDescriptor as top-level fields
  name: string;
  version: string;
  arch: Arch;
  cpu: number;
  mem: number;
  pid: number | null;
  machineDir: string;
  createdAt: string;
  lastStartedAt: string | null;

  services: {
    "rest-api": ServiceEndpoint;
    "native-api": ServiceEndpoint;
    ssh: SshServiceEndpoint;
  };

  customForwards?: CustomForward[];        // only if quickchr has forwards beyond the three services above
  networks?: NetworkTopologyEntry[];       // topology-only; see "Multi-network awareness"
}
```

### `ServiceEndpoint` (rest-api, native-api)

One per-service endpoint shape. Centrs reuses this same internal type for TikTOML
resolution (`tikoci/centrs#174` Tier 1) — quickchr's descriptor and TikTOML's
`services` block are both "per-service, same internal `ServiceEndpoint`". This shared
name-and-shape is deliberate and load-bearing, not a coincidence.

```ts
type ServiceEndpoint =
  | {
      available: true;
      host: string;        // "127.0.0.1" — hostname/IP, NOT a port (see naming-collision note)
      port: number;
      guestPort?: number;
      transport: "tcp" | "udp";
      tls: boolean;        // true for https / apiSsl-backed endpoints, false otherwise
      url?: string;
      source?: { provider: "quickchr"; portMappingName?: string };
      auth?: { username: string; password?: string; basic?: string; header?: string };
    }
  | {
      available: false;
      unavailableReason: string;
      // best-effort echoes; a consumer must gate on `available` before dialing
      host?: string;
      port?: number;
      guestPort?: number;
      transport?: "tcp" | "udp";
      tls?: boolean;
      url?: string;
      source?: { provider: "quickchr"; portMappingName?: string };
    };
```

- Use `transport` (not `protocol`) for TCP/UDP — centrs already uses `protocol`/`via`
  for the service axis (`rest-api`, `native-api`, `ssh`).
- Auth uses `username` (not `user`). The old top-level `auth.user` shape is dropped in
  the restructure; the new per-service `auth.username` is the only spelling.
- `source.portMappingName` reports *which* quickchr internal port-forward backs the
  service (e.g. `"api-ssl"`), for provenance — but the service **key** stays
  `"native-api"`. Keep quickchr's internal forward names out of the service keys.

### `SshServiceEndpoint`

`SshServiceEndpoint` **extends the generic `ServiceEndpoint`** — same
`available`/`host`/`port`/`transport`/`source` discriminated union — with an
SSH-specific `auth` sub-shape substituted for the REST/native-api auth object. It is
**not** an independent type.

```ts
type SshServiceEndpoint =
  | ({ available: true } & Omit<Extract<ServiceEndpoint, { available: true }>, "auth"> & {
      auth: {
        username: string;              // state.user?.name ?? "admin"
        privateKeyPath?: string;       // managedSshKey.privateKeyPath — ONLY when batchVerified === true
        modes: Array<"private-key" | "agent-or-config" | "password">;
        batchModes: Array<"private-key" | "agent-or-config">;
        passwordAvailable?: boolean;
      };
    })
  | Extract<ServiceEndpoint, { available: false }>;
```

- `services.ssh` is always `tls: false` — SSH has its own transport security, a
  different axis from the http/https, api/apiSsl split.
- **`batchModes` is the gate centrs enforces** for `--via ssh` and `transfer --via
  sftp`. If `batchModes` contains no key/agent-compatible mode, centrs must emit a
  typed unsupported-capability error — never prompt for a password or silently fall
  back. Password-only SSH is not a usable centrs batch handoff.

### `CustomForward`

Generic extra-forward listing. Uses a descriptor-specific shape rather than leaking
internal `PortMapping` field names. Keep it generic — no consumer-specific semantics
(centrs decides later whether any feature such as btest consumes one).

```ts
interface CustomForward {
  name: string;
  transport: "tcp" | "udp";
  host: string;        // "127.0.0.1" — hostname
  hostPort: number;    // host-side port
  guestPort: number;   // guest-side (RouterOS) port
}
```

### `NetworkTopologyEntry`

Topology-only awareness of non-SLiRP NICs — see
[Multi-network awareness](#multi-network-awareness-scope-boundary). Purely
declarative; **do not** add `available`/`host`/`port` here (that would imply a
resolved-connection promise quickchr can't keep for DHCP-assigned segments).

```ts
interface NetworkTopologyEntry {
  id: string;                    // "net0", "net1", … — matches NetworkConfig.id / boot order (net0 = ether1)
  specifier: NetworkSpecifier;   // verbatim declared intent from state.networks[].specifier
}
```

---

## Field semantics & mapping rules

The type is the easy part. These rules are where an implementer goes wrong by
pattern-matching field names. All code references are against `main` at `ee13eb9`.

### SSH — the concrete data source

The SSH service is sourced from `MachineState.managedSshKey` (`src/lib/types.ts:224`,
persisted to `machine.json`, populated in `src/lib/provision.ts` (landed via
issues #74 / #82 / #83):

```ts
interface ManagedSshKey {
  privateKeyPath: string;   // <machineDir>/ssh/id_ed25519
  algorithm: string;        // "ed25519"
  batchVerified: boolean;   // real host-OpenSSH BatchMode=yes / IdentitiesOnly=yes login succeeded
  verifiedAt?: string;
}
```

Mapping rules:

- `auth.privateKeyPath` = `state.managedSshKey?.privateKeyPath`, **only when**
  `state.managedSshKey?.batchVerified === true`. Otherwise **omit the field** — never
  emit an unverified path.
- `auth.batchModes` = `["private-key"]` when `batchVerified === true`, else `[]`.
  Never advertise `"private-key"` in `batchModes` off an absent/unverified key.
- `"agent-or-config"` may appear in `batchModes` independent of `managedSshKey` — that
  is host `ssh-agent` / `~/.ssh/config` policy, which quickchr cannot verify. Include
  it as a mode centrs *may* try, not one quickchr vouches for.
- `auth.username` = `state.user?.name` (the managed/provisioned user, e.g.
  `"quickchr"`) when a managed user exists, else `"admin"`.
- `auth.passwordAvailable` = whether the credential store has a resolvable password for
  that user today (same source `resolveAuth`/`resolveCreds` use — `src/lib/auth.ts`).
- **Absent `managedSshKey`** (machine started with `--no-secure-login`, or an explicit
  `--user`/`--password` override that skips managed-key install per
  `provision.ts:396`): no key path, `batchModes: []`, and `modes` still includes
  `"password"` when `passwordAvailable`.
- Algorithm/version grounding: `test/lab/ssh-keys/REPORT.md`.

### TLS

`tls: boolean` was chosen over `secure` or string-parsing `source.portMappingName`.
quickchr already tracks plain/TLS pairs separately (`ChrPorts.http`/`https`,
`.api`/`.apiSsl` — `src/lib/types.ts:376`). Populate:

- `services["rest-api"]` → pick `https`/`http` per the existing REST-URL preference
  logic; set `tls` to match which was chosen.
- `services["native-api"]` → pick `apiSsl`/`api`; set `tls` to match.
- `services.ssh` → always `tls: false`.

Consumer scope note (do **not** build this into quickchr): centrs auto-preferring the
secure variant when both are open is a centrs-side (`tikoci/centrs#134`) decision.
Leave a pointer comment; don't add preference logic to quickchr.

### Availability semantics — REST / native-API

`resolveAuth`/`resolveCreds` (`src/lib/auth.ts:30-37` docstring) **never throw** —
when `state.disableAdmin` is `true` and no provisioned user exists, they still fall
back to `admin:""` by design ("the caller will get a 401"). The descriptor must not
blindly report `available: true` just because *some* credential tuple resolved:

- For `services["rest-api"]` / `services["native-api"]`: if `state.disableAdmin ===
  true` **and** `state.user` is unset (no provisioned user, no stored per-instance
  credentials), report `available: false, unavailableReason: "admin disabled, no user
  provisioned"`. Do **not** report `available: true` off the meaningless `admin:""`
  fallback.
- Otherwise `available: true` as today.

### Naming collision to watch

`PortMapping.host` (`src/lib/types.ts:120`) is a **number** — the host-side *port*.
The new `ServiceEndpoint`/`CustomForward` shapes use `host: string` as a **hostname**
(`"127.0.0.1"`) with a separate numeric `hostPort`/`port`. Same field name, different
type, one hop apart in the same data flow (`state.ports` → descriptor).

**Do not** wire `hostPort: mapping.host, host: mapping.host` by pattern-matching the
name. In the new shapes, `host` is always the literal `"127.0.0.1"` string;
`hostPort`/`port` is the numeric value read from the `PortMapping`.

### Dropped fields

- **`apiVersion` — dropped.** Ship `quickchr: { packageVersion }` only (from
  `package.json`). There is no versioning scheme for the `ChrInstance`/`QuickCHR`
  public surface distinct from `packageVersion` or `descriptorVersion`. Do not invent
  one for this issue.
- **Old flat `ports` / `urls` / top-level `auth`** — replaced by `services`. (The
  restructure is allowed; see below.)

---

## Scope boundaries & non-goals

### `--via` coverage — what v1 `services` does and does not resolve

The v1 3-key `services` map (`rest-api`, `native-api`, `ssh`) is **complete for what
quickchr itself manages today**. Centrs' matrix (`docs/MATRIX.md` in centrs) has
other `--via`-adjacent columns — `mac-telnet`, `snmp`, `mndp`, `romon`,
`winbox-terminal` — but quickchr's `MachineState`/descriptor tracks none of them.
(`mac-telnet` reaches a CHR today via a **centrs-owned** host TCP relay built on
quickchr's raw `socket-connect` `NetworkSpecifier` — `test/integration/mactelnet-l2-bridge.ts`
lives in the centrs consumer, not quickchr.)

Therefore, as an explicit scope statement (not an oversight):

> `--quickchr` v1 does not resolve `mac-telnet` / `snmp` / `mndp` / `romon` /
> `winbox-terminal` targets. Centrs should produce a typed "not supported by this
> provider" error for those `--via` values rather than synthesizing an L2 bridge
> itself.

If a `services["mac-telnet"]` key is ever built, it is a new property under the
additive-only policy — existing consumers already ignore it, so **no
`descriptorVersion` bump** is needed.

### Multi-network awareness (scope boundary)

`buildDescriptor()` (`src/lib/quickchr.ts:245`) builds every field from `ports` /
`127.0.0.1` literals and `resolveAuth(state)` — it never reads `state.networks`. So
the v1 `services` shape is scoped **exclusively to the default `"user"`/SLiRP NIC's
hostfwd-forwarded loopback ports**, even though a machine may also have
`bridged`/`shared`/`vmnet-*`/`tap`/`socket-*` NICs via `--add-network`. quickchr has
**no field** that tracks a DHCP-assigned guest IP for those segments.

Decision (confirmed with the issue owner): stay **SLiRP-only for actual connection
facts** in v1 — do not resolve guest IPs or wire L2 paths speculatively. But make the
*existence* of other networks visible via the topology-only `networks` list so a
consumer isn't silently blind to them:

- `services` = resolved, dialable facts → SLiRP-forwarded-only.
- `networks` = declarative topology only → mirrors `state.networks[].specifier`
  verbatim (already non-secret; no MACs, no host details, no DHCP resolution).
  Lets centrs render an informational tip (e.g. "this machine also has a
  `vmnet-bridged` network on `en0` — `--quickchr` only resolved the SLiRP endpoint;
  connect manually for that path").
- `networks[0]` (the SLiRP `"user"` NIC) is redundant with `services` but should still
  be listed for consistency — let the consumer filter; don't make quickchr decide what
  counts as "extra."
- `networks` is genuinely additive under the forward-compat policy — no version bump
  even if added after the rest of v1 ships.

### Other non-goals (binding, carried over)

- Do not expose `machine.json` as the integration API.
- Do not make centrs read quickchr secrets/config files.
- Do not couple quickchr to centrs at runtime.
- Do not provision feature-specific RouterOS services (incl. btest) for centrs.
- Do not expose `sftp` (or other centrs transfer methods) as quickchr services.
- QGA stays out of `services` v1 — deferred to
  [#70](https://github.com/tikoci/quickchr/issues/70) unless it defines an explicit
  channel shape. QGA is quickchr-scoped, not a RouterOS TCP/UDP service endpoint.

---

## Naming alignment (quickchr ↔ centrs)

Confirmed against centrs' literal source (`execute.ts`/`api.ts`/`terminal.ts`/
`transfer.ts`), not just issue text. Most names match on purpose; two do not — flagged
so nobody assumes 1:1.

| Concept | quickchr descriptor | centrs internal | Match? |
|---|---|---|---|
| Service keys | `"rest-api"`, `"native-api"`, `"ssh"` | `--via` values (verbatim) | ✅ identical |
| Per-service endpoint type | `ServiceEndpoint` | `ServiceEndpoint` (`#174` Tier 1) | ✅ same name + shape (load-bearing) |
| Auth user field | `auth.username` | `ResolvedAuth.username` | ✅ identical |
| Transport axis | `transport: "tcp"\|"udp"` | `via`/`protocol` (separate axis) | ✅ deliberately distinct |
| SSH key path | `auth.privateKeyPath` | `ResolvedAuth.sshKey` | ⚠️ **different name, same concept** |
| Transfer method | *(not a service)* | `sftp` (consumes `ssh`) | ⚠️ centrs-only, not a quickchr key |

The centrs implementer wiring `--quickchr`'s SSH mapping must map
`privateKeyPath → sshKey` explicitly — do not assume the 1:1 field-name match that
works for `username`.

### Centrs consumption rule

Centrs chooses `--via` first, then selects the matching quickchr service endpoint. A
single `127.0.0.1:<port>` is not enough — REST, native API, SSH, and future
quickchr-scoped channels use different forwarded ports and auth. For centrs v1,
`--quickchr` **conflicts with** direct target/auth overrides (`--host`, `--port`,
`--username`, `--password`, `--ssh-key`); the clean provider-owned path is the first
contract. Later centrs resolver work may revisit CLI-only credential overrides.

---

## Staged implementation plan

Sequenced for a future quickchr-side agent. All blockers are clear (#74 merged via
PRs #82 / #83; `ManagedSshKey` present on `main`). Each phase is independently reviewable.

### Phase 1 — Types

- Add `Descriptor`, `ServiceEndpoint`, `SshServiceEndpoint`, `CustomForward`,
  `NetworkTopologyEntry`, and `SERVICE_IDS` / `QUICKCHR_DESCRIPTOR_VERSION` constants
  to `src/lib/types.ts` (export the constants for TS-consumer ergonomics —
  `SERVICE_IDS.nativeApi === "native-api"`, so consumers get autocomplete while the
  wire key stays canonical).
- Keep the current `MachineDescriptor` in place for now if convenient, or mark it for
  replacement — the cutover is Phase 2.
- **Done:** types compile; constants exported; JSDoc on each field pointing back to
  this doc.

### Phase 2 — `buildDescriptor()` rewrite

Rewrite `src/lib/quickchr.ts:245` (`buildDescriptor`) to emit the v1 `Descriptor`:

- Build `services["rest-api"]` / `services["native-api"]` from `ports` + `resolveAuth`,
  with `tls` per the http/https · api/apiSsl choice, `source.portMappingName`
  provenance, and the `disableAdmin`-no-user `available: false` case.
- Build `services.ssh` from `state.managedSshKey` + `state.user` per the SSH mapping
  rules — `privateKeyPath`/`batchModes` gated on `batchVerified === true`.
- Emit `customForwards` for any forward beyond the three services (generic shape;
  mind the `PortMapping.host`-is-a-port collision).
- Emit `networks` from `state.networks[].specifier` (topology only).
- Keep the running-only guard (`MACHINE_STOPPED` / `MACHINE_NOT_FOUND` unchanged).
- **Done:** `quickchr inspect` on a running machine emits the v1 shape; stopped/missing
  still throw typed errors.

### Phase 3 — Tests

`bun test` coverage (unit where possible; integration `QUICKCHR_INTEGRATION=1` for the
SSH-verified path). Cover the [Done-when](#done-when--acceptance) checklist:

- `descriptorVersion` + `quickchr.packageVersion` present; no `apiVersion`.
- Unknown-field tolerance (a consumer-style parse ignores an injected extra field).
- All three canonical service keys with correct `transport`/`tls`.
- SSH auth-mode reporting in **both** states: verified key (`batchModes:
  ["private-key"]`, `privateKeyPath` set) and absent/unverified key (`batchModes: []`,
  no path, `modes` includes `"password"` when available).
- `disableAdmin`-no-user → `available: false` for `rest-api`/`native-api`.
- `customForwards` shape when extra forwards exist.
- `networks` topology mirrors `state.networks`.

### Phase 4 — Docs, changelog & consumer heads-up

- `CHANGELOG.md` entry for the `MachineDescriptor` restructure (user-facing).
- Update `MANUAL.md` / `README.md` where the old flat descriptor shape is documented.
- File/update a heads-up issue or note on **restraml** and **donny** (current
  `descriptor()`-shape consumers per #50) that the shape changed. This is the one hard
  process requirement of the restructure — flag it, don't silently break them.
- Cross-link this doc from wherever the change lands.

### Ship & iterate

Once Phases 1–3 are green, quickchr can ship the v1 descriptor and centrs can start
building `--quickchr` against it (`tikoci/centrs#134`). Expect a refinement round after
centrs *actually uses* it — fold any resulting decisions back into this doc and bump
`descriptorVersion` only if a change is genuinely breaking.

---

## Backward compatibility

Restructuring `MachineDescriptor` (`src/lib/types.ts:386`) is **accepted as a breaking
change** — quickchr is pre-1.0 (`0.4.x`) with no external consumers depending on the
current shape yet. Per the relaxed guidance on #71 (superseding an earlier
CHANGELOG+semver-major ask in the same review):

- **Required:** flag the shape change — a `CHANGELOG.md` entry **and** a note/issue on
  any repo that reads `descriptor()`/`MachineDescriptor` today (`restraml`, `donny`)
  so it isn't silently broken.
- **Not required for this issue:** strict semver-major bump discipline. That's a
  1.x-era concern.

DESIGN.md:78 ("a change to the persisted contract needs an issue, a CHANGELOG/docs
note, and a migration path, not a silent break") still applies in spirit — the note
and CHANGELOG entry satisfy it for a pre-1.0 public API.

---

## Done-when / acceptance

A newer centrs can resolve a quickchr target using only `@tikoci/quickchr` public APIs,
reject an old quickchr with a typed/friendly error, and build REST/native/SSH target
settings **without** reading `machine.json` or quickchr private files.

- [ ] `descriptorVersion: 1` + `quickchr: { packageVersion }` (no `apiVersion`).
- [ ] `services["rest-api"]` / `services["native-api"]` implement `ServiceEndpoint`
      incl. `tls`, with the `disableAdmin`-no-user case → `available: false`.
- [ ] `services.ssh` implements `SshServiceEndpoint`, sourced from
      `MachineState.managedSshKey` (batch key only advertised when `batchVerified`).
- [ ] `customForwards` (optional) uses the generic `{name, transport, host, hostPort,
      guestPort}` shape — not raw `PortMapping` fields.
- [ ] `networks` (optional) topology mirror of `state.networks[].specifier`.
- [ ] `MachineDescriptor` restructure ships with a CHANGELOG entry + a heads-up on
      restraml and donny.
- [ ] Tests/docs cover: versioning, unknown-field tolerance, all three service keys,
      `tls` correctness, SSH auth-mode reporting (verified + unverified/absent),
      `disableAdmin`-no-user unavailable case, custom-forward shape, `networks`.

### Open question (not blocking)

Whether [#50](https://github.com/tikoci/quickchr/issues/50) (broader stable
machine-evidence descriptor) should consume this same `descriptorVersion`/`services`
contract once it lands. Decide when convenient; not a decision this work needs to make.

---

## Decision log (why the shape is what it is)

Compressed history so the *reasoning* survives without re-reading the #71 thread.

| Decision | Resolution | Grounding |
|---|---|---|
| Service key naming | Centrs `--via` IDs (`rest-api`/`native-api`/`ssh`), not `rest`/`nativeApi`/`api` | Match centrs literal `--via` strings; TS ergonomics via exported `SERVICE_IDS` |
| `sftp` as a service | No — it's a centrs transfer method on `ssh` | Layering; keep quickchr service list = things quickchr resolves |
| SSH auth shape | `modes`/`batchModes`/`passwordAvailable`; batch key gated on `batchVerified` | quickchr uses `SSH_ASKPASS`; centrs uses OpenSSH `BatchMode=yes` — different bars |
| SSH data source | `MachineState.managedSshKey` (from #74/#82/#83) | `types.ts:224`; `test/lab/ssh-keys/REPORT.md` |
| `apiVersion` | Dropped — `packageVersion` only | No separate public-surface versioning scheme exists |
| TLS disambiguation | `tls: boolean` on `ServiceEndpoint` | Over `secure` / string-parsing `portMappingName`; quickchr already tracks pairs |
| REST/native availability | `available:false` on `disableAdmin`-no-user | `auth.ts` never throws; would over-report the one known-broken case |
| `MachineDescriptor` restructure | Allowed (breaking), must be flagged | pre-1.0, no external consumers; flag on restraml/donny |
| Multi-network | `services` SLiRP-only; add topology-only `networks` | `buildDescriptor` never reads `state.networks`; no guest-IP tracking |
| `--via` coverage | 3 keys complete for what quickchr manages; rest → centrs typed error | `mac-telnet` relay is centrs-owned, not quickchr state |
| QGA | Deferred to #70 | Not a RouterOS TCP/UDP endpoint; quickchr-scoped |

### Provenance

- Primary issue: [tikoci/quickchr#71](https://github.com/tikoci/quickchr/issues/71)
  (this doc supersedes its long comment thread).
- SSH data-source dependency: [#74](https://github.com/tikoci/quickchr/issues/74)
  (merged via [#82](https://github.com/tikoci/quickchr/pull/82),
  [#83](https://github.com/tikoci/quickchr/pull/83)).
- Related quickchr: #50 (broader descriptor), #70 (QGA), #72 (docs pointer),
  #73 (example), #51 (SSH transport), #23 (file-copy CLI).
- Centrs consumer: `tikoci/centrs#134` (`--quickchr`), #173 (`devices list`),
  #174 (shared `ServiceEndpoint`), #137 (ignore-unknown / TikTOML), #140 (examples).
- Code grounding is against `main` at `ee13eb9`; verify line numbers before relying on
  them, since files drift.
