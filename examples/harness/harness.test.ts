import { describe, test, expect, afterAll } from "bun:test";
import { join } from "node:path";
import type { ChrInstance } from "../../src/index.ts";
import { QuickCHR } from "../../src/index.ts";

/**
 * harness — point an *external* tool at a live CHR via the connection surface
 *
 * When you need to drive a separate process (a schema extractor like
 * `tikoci/restraml`, a protocol suite like `tikoci/centrs`, a CLI) against a
 * running CHR, don't read `machine.json`. Use the stable connection surface:
 *
 *   - `instance.subprocessEnv()` → env vars (`URLBASE`, `BASICAUTH`, …) to hand a child
 *   - `instance.descriptor()`    → a structured `{ urls, auth, ports, status, … }` record
 *
 * Both are **secret-bearing** (they carry the real credentials) — treat their
 * output like a password: don't log it, don't write it to artifacts.
 *
 * Re-run safety comes from the unique machine name; the child only ever reads.
 *
 * Run:
 *   QUICKCHR_INTEGRATION=1 bun test examples/harness/harness.test.ts
 */

const SKIP = !process.env.QUICKCHR_INTEGRATION;

const CHR_ARCH = process.arch === "arm64" ? ("arm64" as const) : ("x86" as const);
const NONCE = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

describe.skipIf(SKIP)("harness — drive an external process against the CHR", () => {
	let instance: ChrInstance | undefined;

	afterAll(async () => {
		try {
			await instance?.remove();
		} catch {
			/* ignore cleanup errors */
		}
	});

	test(
		"a child process reaches the CHR using only subprocessEnv()",
		async () => {
			// secureLogin: true → a managed user with a real password, so the
			// connection surface carries an actual secret (the realistic case).
			instance = await QuickCHR.start({
				name: `harness-${NONCE}`,
				channel: "stable",
				arch: CHR_ARCH,
				background: true,
				secureLogin: true,
				cpu: 1,
				mem: 256,
			});

			// The structured descriptor — what a harness records instead of machine.json.
			const desc = await instance.descriptor();
			expect(desc.status).toBe("running");
			expect(desc.urls.rest).toContain("/rest");

			// Hand the connection env to a separate process and let it talk to the CHR.
			const env = await instance.subprocessEnv();
			expect(env.URLBASE).toContain("/rest");
			expect(env.BASICAUTH).toContain(":"); // raw user:password, not a header

			const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "child.ts")], {
				env: { ...process.env, ...env },
				stdout: "pipe",
				stderr: "pipe",
			});
			const out = (await new Response(proc.stdout).text()).trim();
			const code = await proc.exited;

			expect(code).toBe(0);
			expect(out).toContain("CHR");
		},
		240_000,
	);
});
