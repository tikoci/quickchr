#!/usr/bin/env bun
/**
 * dude — ground an optional RouterOS *package* and its config against a real router
 *
 * A richer grounding loop than `grounding`: install the `dude` server package
 * (`installPackage` downloads the arch-correct `.npk` from MikroTik and reboots
 * to activate), then enable The Dude server and read the setting back. Shows that
 * a package-gated subsystem (`/dude`) only appears once its package is present.
 *
 * Works on **both x86 and arm64** — MikroTik ships `dude-<ver>-arm64.npk`
 * alongside the x86 build (verified 7.21.1–7.23.1), and quickchr's package
 * resolver picks the right one for the host-native arch (omitted here = auto).
 *
 * Run:  bun run examples/dude/dude.ts
 * Time: ~50–90 s (install downloads the package and reboots once).
 */
import { QuickCHR } from "../../src/index.ts";
import { check, exampleMachineName, runExample } from "../lib.ts";

if (import.meta.main) {
	await runExample(async (track) => {
		const chr = track(
			await QuickCHR.start({
				name: exampleMachineName("dude"),
				channel: "stable",
				secureLogin: false,
				mem: 256,
			}),
		);

		// installPackage downloads the arch-correct package, uploads it, and reboots.
		// Empty return = the package wasn't found for this version/arch → re-ground,
		// don't silently skip.
		const installed = await chr.installPackage("dude");
		check(installed.includes("dude"), "dude package did not install");

		// The /dude menu only exists once the package is present.
		const before = (await chr.rest("/dude")) as { enabled?: string };
		check(typeof before === "object" && before !== null, "/dude should exist after install");

		// Config round-trip: enable the server, read it back.
		await chr.exec("/dude/set enabled=yes");
		const after = (await chr.rest("/dude")) as { enabled?: string };
		check(after.enabled === "true", `expected /dude enabled=true, got ${after.enabled}`);

		console.log(`  dude installed and enabled (enabled=${after.enabled})`);
	});
}
