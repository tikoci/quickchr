#!/usr/bin/env bun
/**
 * harness — point an *external* tool at a live CHR via the connection surface
 *
 * When you drive a separate process (a schema extractor like `tikoci/restraml`,
 * a protocol suite like `tikoci/centrs`, any CLI) against a running CHR, don't
 * read `machine.json`. Use the stable connection surface:
 *
 *   - `instance.subprocessEnv()` → env vars (`URLBASE`, `BASICAUTH`, …) for a child
 *   - `instance.descriptor()`    → a structured `{ services, status, … }` (issue #71)
 *
 * Both are **secret-bearing** (real credentials) — treat their output like a
 * password: don't log it, don't write it to artifacts. `BASICAUTH` is the raw
 * `user:password` string, not a ready-made header (base64-encode it yourself).
 *
 * The "external tool" here is `tool/child.ts`, which receives nothing but the env.
 *
 * Run:  bun run examples/harness/harness.ts
 * Time: ~40–60 s.
 */
import { join } from "node:path";
import { QuickCHR } from "../../src/index.ts";
import { check, exampleMachineName, runExample } from "../lib.ts";

if (import.meta.main) {
	await runExample(async (track) => {
		// secureLogin: true → a managed user with a real password, so the connection
		// surface carries an actual secret (the realistic case for a harness).
		const chr = track(
			await QuickCHR.start({
				name: exampleMachineName("harness"),
				channel: "stable",
				secureLogin: true,
				mem: 256,
			}),
		);

		// The structured descriptor — what a harness records instead of machine.json.
		const desc = await chr.descriptor();
		check(desc.status === "running", "descriptor status should be running");
		const restApi = desc.services["rest-api"];
		check(restApi.available, "rest-api service should be available");
		check(restApi.available && restApi.url?.includes("/rest") === true, "descriptor REST url should contain /rest");

		// Hand the connection env to a separate process; let it talk to the CHR.
		const env = await chr.subprocessEnv();
		check(env.URLBASE?.includes("/rest"), "URLBASE should contain /rest");
		check(env.BASICAUTH?.includes(":"), "BASICAUTH should be raw user:password");

		const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "tool", "child.ts")], {
			env: { ...process.env, ...env },
			stdout: "pipe",
			stderr: "pipe",
		});
		const out = (await new Response(proc.stdout).text()).trim();
		const code = await proc.exited;

		check(code === 0, `external tool exited ${code}`);
		check(out.includes("CHR"), `external tool should report a CHR board-name, got "${out}"`);
		console.log(`  external tool reached CHR via subprocessEnv() — board-name: ${out}`);
	});
}
