# grounding — validate RouterOS config against a real router

The core quickchr loop: **apply** a RouterOS config snippet, **read it back**, and
**assert** it took — against real RouterOS, not a guess. This is what an agent
should do before trusting generated config: ground it on a disposable CHR.

`vienk` only *reads* built-in resources. `grounding` *writes* config and verifies
the write landed.

## The loop

```ts
const chr = await QuickCHR.start({ name, channel: "stable", secureLogin: false });
// start() resolves REST-ready — no extra waitForBoot() needed.

await chr.exec(`/ip/firewall/address-list/add list=quickchr-grounding address=10.99.99.99 comment="${tag}"`);

const entries = await chr.rest("/ip/firewall/address-list");
// assert an entry whose comment === tag exists
```

`exec()` runs a CLI command (here a config write); `rest()` reads structured
state back. The same shape grounds any config: firewall rules, addresses,
routing, queues, scripts.

## Re-run safety

Every run uses a unique `NONCE` baked into **both** the machine name and the
asserted values (the address-list comment and the system identity). A stale
machine from an interrupted run can't make a later run pass falsely: a fresh run
makes a new machine, and the assertions only accept values carrying *this* run's
nonce. (Clean up stale machines with `quickchr remove --all` if an interrupted
run leaves any behind.)

## Run

```sh
QUICKCHR_INTEGRATION=1 bun test examples/grounding/grounding.test.ts
```

Boots a real CHR (~25–40 s with KVM/HVF; minutes under TCG). See
[`../README.md`](../README.md) for how to depend on `@tikoci/quickchr` from your
own project, and [`../../docs/networking-recipes.md`](../../docs/networking-recipes.md)
for reaching guest services / receiving guest traffic.
