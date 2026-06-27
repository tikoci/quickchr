#!/usr/bin/env bun
/**
 * <name> — <one-line outcome>
 *
 * Skeleton for a runnable quickchr example. Copy this directory, rename to your
 * <name>, and replace the body. Examples are runnable scripts (you `bun run`
 * them), not tests — reach for `bun:test` only when assertions ARE the point
 * (see ../grounding/). An agent can wrap this in `test()` trivially.
 *
 * Run:  bun run <name>.ts
 */
import { QuickCHR } from "../../src/index.ts";
import { check, exampleMachineName, runExample } from "../lib.ts";

if (import.meta.main) {
	await runExample(async (track) => {
		// `track()` registers the instance for guaranteed teardown (success OR
		// failure). Never call process.exit() before the finally runs — that would
		// strand a running QEMU machine.
		const chr = track(
			await QuickCHR.start({
				name: exampleMachineName("template"),
				channel: "stable",
				secureLogin: false,
				mem: 256,
			}),
		);

		// ... do something real, then check() the observable result ...
		const res = (await chr.rest("/system/resource")) as Record<string, string>;
		check(String(res["board-name"]).includes("CHR"), "expected a CHR board-name");

		console.log(`  RouterOS ${res.version} (${res["architecture-name"]})`);
	});
}
