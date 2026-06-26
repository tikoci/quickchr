# dude — ground a RouterOS package + its config against a real router

A richer grounding loop than [`grounding`](../grounding/): install an optional
RouterOS **package**, configure the subsystem it adds, and read the setting back.
The Dude server is a good case — its `/dude` menu only exists once the `dude`
package is installed.

## The loop

```ts
const installed = await chr.installPackage("dude"); // downloads + reboots to activate
// installed === ["dude"] when the package was found for this version/arch

await chr.rest("/dude");            // the menu now exists (package present)
await chr.exec("/dude/set enabled=yes");
await chr.rest("/dude");            // → { enabled: "true", … }
```

`installPackage()` fetches the `.npk` from MikroTik (host-side), uploads it over
SCP, reboots, and waits for REST to come back — so when it resolves, the package
is active. It returns the names it actually installed; a package missing for the
version/arch is skipped (not in the returned list).

## x86-only

The `dude` server package ships for **x86** only, so this example skips on arm64.
Verified on RouterOS `7.23.1` (x86). If a future release drops or renames the
package, `installPackage("dude")` returns `[]` and the assertion fails loudly —
that's the signal to re-ground, not to paper over.

## Why no seeded `dude.db`

Loading a pre-built `dude.db` is version-fragile across RouterOS releases, so this
example deliberately doesn't ship one — it grounds the **install + config** path
deterministically instead. (For the file-transfer API itself —
`upload()` / `download()` — see `test/integration/file-transfer.test.ts`.)

## Run

```sh
QUICKCHR_INTEGRATION=1 bun test examples/dude/dude.test.ts
```

Boots a real CHR and installs a package (~50–90 s with KVM/HVF). If you hit a
non-deterministic failure, re-run once; if it persists, please file an issue at
<https://github.com/tikoci/quickchr/issues>.
