import { describe, test, expect, afterAll } from "bun:test";
import type { ChrInstance } from "../../src/index.ts";
import { QuickCHR } from "../../src/index.ts";

/**
 * grounding — validate RouterOS config against a *real* router
 *
 * The canonical quickchr loop: boot a disposable CHR, **apply** a config snippet
 * with `exec()`, **read it back** with `rest()`, and assert it took. This is how
 * you ground a RouterOS config or script against real RouterOS behavior instead
 * of guessing — the same thing an agent should do before trusting generated config.
 *
 * Unlike `vienk` (which only reads built-in resources), this example *writes*.
 *
 * ### Re-run safety
 * Every run uses a unique `NONCE` baked into both the machine name **and** the
 * config values it asserts on (an address-list comment + the system identity). A
 * stale machine left by an interrupted run therefore can't make a later run pass
 * falsely — a fresh run creates a new machine, and the assertions only accept
 * values carrying *this* run's nonce.
 *
 * Run:
 *   QUICKCHR_INTEGRATION=1 bun test examples/grounding/grounding.test.ts
 */

const SKIP = !process.env.QUICKCHR_INTEGRATION;

const CHR_ARCH = process.arch === "arm64" ? ("arm64" as const) : ("x86" as const);

// Unique per run — drives the machine name and the asserted config values.
const NONCE = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

interface AddressListEntry {
	address?: string;
	list?: string;
	comment?: string;
}

describe.skipIf(SKIP)("grounding — apply config, read it back", () => {
	let instance: ChrInstance | undefined;

	afterAll(async () => {
		try {
			await instance?.remove();
		} catch {
			/* ignore cleanup errors */
		}
	});

	test(
		"a config write via exec() is observable via rest()",
		async () => {
			// start() resolves REST-ready — no second waitForBoot() needed here.
			instance = await QuickCHR.start({
				name: `grounding-${NONCE}`,
				channel: "stable",
				arch: CHR_ARCH,
				background: true,
				secureLogin: false,
				cpu: 1,
				mem: 256,
			});

			// 1. Apply config — a nonce-tagged firewall address-list entry.
			const tag = `grounded-${NONCE}`;
			await instance.exec(
				`/ip/firewall/address-list/add list=quickchr-grounding address=10.99.99.99 comment="${tag}"`,
			);

			// 2. Read it back and assert the *nonce-bearing* entry is present.
			const entries = (await instance.rest("/ip/firewall/address-list")) as AddressListEntry[];
			expect(Array.isArray(entries)).toBe(true);
			const hit = entries.find((e) => e.comment === tag);
			expect(hit).toBeDefined();
			expect(hit?.address).toBe("10.99.99.99");

			console.log(`  grounded address-list entry: ${hit?.address} (${hit?.comment})`);
		},
		240_000,
	);

	test("a config write round-trips through a fresh REST read (system identity)", async () => {
		if (!instance) throw new Error("CHR instance was not initialized by the first test.");

		const ident = `chr-${NONCE}`;
		await instance.exec(`/system/identity/set name=${ident}`);

		const id = (await instance.rest("/system/identity")) as { name?: string };
		expect(id.name).toBe(ident);
		console.log(`  grounded system identity: ${id.name}`);
	});
});
