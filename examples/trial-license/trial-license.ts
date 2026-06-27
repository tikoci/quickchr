#!/usr/bin/env bun
/**
 * trial-license — apply a CHR trial license (p1) and read it back
 *
 * MANUAL-ONLY. Renewing a trial license calls MikroTik's licensing server with
 * your mikrotik.com credentials (MIKROTIK_WEB_ACCOUNT / MIKROTIK_WEB_PASSWORD).
 * MikroTik rate-limits repeated trial requests per account/IP, so this example is
 * **excluded from CI** — run it by hand. Without the env vars it degrades to
 * read-only (prints the current level and skips the apply) rather than failing.
 *
 * Run:  MIKROTIK_WEB_ACCOUNT=you@example.com MIKROTIK_WEB_PASSWORD=… \
 *         bun run examples/trial-license/trial-license.ts
 * Time: ~30–60 s (license server round-trip).
 */
import { QuickCHR } from "../../src/index.ts";
import { check, exampleMachineName, runExample } from "../lib.ts";

if (import.meta.main) {
	await runExample(async (track) => {
		const account = process.env.MIKROTIK_WEB_ACCOUNT;
		const password = process.env.MIKROTIK_WEB_PASSWORD;

		const chr = track(
			await QuickCHR.start({
				name: exampleMachineName("trial-license"),
				channel: "stable",
				secureLogin: false,
				mem: 256,
			}),
		);

		const before = (await chr.rest("/system/license")) as Record<string, string>;
		console.log(`  current license level: ${before.level ?? "(free)"}`);

		if (!account || !password) {
			console.log("  MIKROTIK_WEB_ACCOUNT / MIKROTIK_WEB_PASSWORD not set — skipping the apply.");
			console.log("  (Manual-only: set both env vars to actually renew a p1 trial.)");
			return;
		}

		await chr.license({ account, password, level: "p1" });
		const after = (await chr.rest("/system/license")) as Record<string, string>;
		check(String(after.level ?? "").length > 0, "license level should be present after renew");
		console.log(`  license applied: level=${after.level}`);
	});
}
