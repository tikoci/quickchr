#!/usr/bin/env bun
/**
 * device-mode — provision /system/device-mode and read it back
 *
 * device-mode gates powerful features (containers, routerboard hardware access,
 * …). Set it at first boot with `StartOptions.deviceMode` and confirm via REST.
 * Here: enable the `container` feature so `/container` becomes usable.
 *
 * Uses the long-term channel — provisioning flows are validated on RouterOS
 * 7.20.8+, and long-term is the safe default for feature work.
 *
 * Run:  bun run examples/device-mode/device-mode.ts
 * Time: ~30–50 s.
 */
import { QuickCHR } from "../../src/index.ts";
import { check, exampleMachineName, runExample } from "../lib.ts";

if (import.meta.main) {
	await runExample(async (track) => {
		const chr = track(
			await QuickCHR.start({
				name: exampleMachineName("device-mode"),
				channel: "long-term",
				secureLogin: false,
				mem: 256,
				deviceMode: { enable: ["container"] },
			}),
		);

		const dm = (await chr.rest("/system/device-mode")) as Record<string, string>;
		check(
			["yes", "true"].includes(String(dm.container)),
			`container should be enabled, got container=${dm.container}`,
		);
		console.log(`  device-mode: mode=${dm.mode} container=${dm.container}`);
	});
}
