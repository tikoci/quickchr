#!/usr/bin/env bun
/**
 * quickstart — the simplest possible quickchr loop
 *
 * Boots one CHR (stable RouterOS, host-native arch), waits for the REST API,
 * reads a few built-in resources, and tears the machine down. The "does my
 * QEMU + KVM/HVF setup work?" smoke test, and the pattern an agent anchors on.
 *
 * `arch` is omitted, so quickchr matches the host (arm64 on Apple Silicon, x86
 * on Intel/AMD). `secureLogin: false` keeps admin password-less for a quick read.
 *
 * Run:  bun run examples/quickstart/quickstart.ts
 * Time: ~20–40 s with KVM/HVF; ~2–4 min under TCG.
 */
import { QuickCHR } from "../../src/index.ts";
import { check, exampleMachineName, runExample } from "../lib.ts";

if (import.meta.main) {
	await runExample(async (track) => {
		const chr = track(
			await QuickCHR.start({
				name: exampleMachineName("quickstart"),
				channel: "stable",
				secureLogin: false,
				mem: 256,
			}),
		);

		// start() already resolves REST-ready; this is a cheap re-confirmation.
		check(await chr.waitForBoot(30_000), "CHR did not become REST-ready");

		const res = (await chr.rest("/system/resource")) as Record<string, string>;
		check(String(res["board-name"]).includes("CHR"), "expected a CHR board-name");
		console.log(`  RouterOS ${res.version} (${res["architecture-name"]}) — uptime ${res.uptime}`);

		const id = (await chr.rest("/system/identity")) as Record<string, string>;
		check(typeof id.name === "string", "system identity name should be a string");

		const ethers = (await chr.rest("/interface?type=ether")) as unknown[];
		check(Array.isArray(ethers) && ethers.length > 0, "expected at least one ethernet interface");
		console.log(`  ${ethers.length} ethernet interface(s); identity "${id.name}"`);
	});
}
