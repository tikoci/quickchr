import { describe, test, expect, afterAll } from "bun:test";
import type { ChrInstance } from "../../src/index.ts";
import { QuickCHR } from "../../src/index.ts";

/**
 * dude — ground an optional RouterOS *package* + its config against a real router
 *
 * A richer grounding loop than `grounding`: install the `dude` package
 * (`installPackage` downloads it from MikroTik and reboots to activate), then
 * configure The Dude server and read the setting back. Demonstrates that a
 * package-gated subsystem (`/dude`) only appears once its package is present.
 *
 * The `dude` server package is **x86-only** — this example skips on arm64.
 *
 * Re-run safety: a unique machine name per run; the assertions are on package
 * presence and a config setting, both deterministic on a freshly-installed CHR.
 *
 * Run:
 *   QUICKCHR_INTEGRATION=1 bun test examples/dude/dude.test.ts
 */

const SKIP = !process.env.QUICKCHR_INTEGRATION || process.arch === "arm64";
const NONCE = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

describe.skipIf(SKIP)("dude — install a package and ground its config (x86)", () => {
	let instance: ChrInstance | undefined;

	afterAll(async () => {
		try {
			await instance?.remove();
		} catch {
			/* ignore cleanup errors */
		}
	});

	test(
		"installing the dude package exposes /dude, and the setting round-trips",
		async () => {
			instance = await QuickCHR.start({
				name: `dude-${NONCE}`,
				channel: "stable",
				arch: "x86",
				background: true,
				secureLogin: false,
				cpu: 1,
				mem: 256,
			});

			// installPackage downloads the package, uploads it, and reboots to activate.
			const installed = await instance.installPackage("dude");
			expect(installed).toContain("dude");

			// The /dude menu only exists once the package is present.
			const before = (await instance.rest("/dude")) as { enabled?: string };
			expect(before).toBeObject();

			// Config round-trip: enable the server, read it back.
			await instance.exec("/dude/set enabled=yes");
			const after = (await instance.rest("/dude")) as { enabled?: string };
			expect(after.enabled).toBe("true");

			console.log(`  dude installed; /dude enabled=${after.enabled}`);
		},
		360_000,
	);
});
