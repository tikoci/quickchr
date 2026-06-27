#!/usr/bin/env bun
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ChrInstance } from "../../src/index.ts";
import { QuickCHR } from "../../src/index.ts";
import { exampleMachineName } from "../lib.ts";

/**
 * grounding — validate RouterOS config against a *real* router (the `bun:test` reference)
 *
 * The canonical quickchr loop: boot a disposable CHR, **apply** config with
 * `exec()`, **read it back** with `rest()`, and assert it took. This is how you
 * ground generated RouterOS config/scripts against real RouterOS instead of
 * guessing — what an agent should do before trusting its own output.
 *
 * ── Why this one is a `bun:test` (and the others aren't) ──
 * Every other example is a runnable script you `bun run` — because the real-world
 * thing a consumer writes is a script that *does something*. This example is a
 * `bun:test` because here the **assertions ARE the documentation**: a regression
 * suite that proves the apply→read-back contract still holds. Reach for `bun:test`
 * when that's the point; otherwise write a runnable script (and an agent can wrap
 * any script in `test()` trivially). This file also doubles as the reference for
 * the bun:test patterns other projects reuse against a CHR:
 *   - `beforeAll`/`afterAll` to share one booted instance across tests
 *   - several focused `test()` blocks instead of one mega-test
 *   - `test.skipIf(...)` to gate a case on a runtime condition
 *   - a spread of `expect` matchers (`toContain`, `toBeArray`, `toMatchObject`, …)
 *
 * Re-run safety: a unique NONCE drives the machine name AND the asserted values,
 * so a stale machine from an interrupted run can't make a later run pass falsely.
 *
 * Run:  QUICKCHR_INTEGRATION=1 bun test examples/grounding/grounding.test.ts
 */

const SKIP = !process.env.QUICKCHR_INTEGRATION;

// Unique per run — drives the machine name and the asserted config values.
const NONCE = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 8)}`;

interface AddressListEntry {
	address?: string;
	list?: string;
	comment?: string;
}

describe.skipIf(SKIP)("grounding — apply config, read it back", () => {
	let chr: ChrInstance;

	// One booted CHR shared by every test() below. `QuickCHR.start()` resolves
	// REST-ready, so no separate waitForBoot() is needed.
	beforeAll(async () => {
		chr = await QuickCHR.start({
			name: exampleMachineName(`grounding-${NONCE}`),
			channel: "stable",
			secureLogin: false,
			mem: 256,
		});
	});

	afterAll(async () => {
		try {
			await chr?.remove();
		} catch {
			/* ignore cleanup errors */
		}
	});

	test("the router is REST-reachable (read-only sanity)", async () => {
		const res = (await chr.rest("/system/resource")) as Record<string, string>;
		expect(res).toBeObject();
		expect(res["board-name"]).toContain("CHR");
		expect(res.version).toBeDefined();
	});

	test(
		"a config write via exec() is observable via rest() (firewall address-list)",
		async () => {
			const tag = `grounded-${NONCE}`;
			await chr.exec(
				`/ip/firewall/address-list/add list=quickchr-grounding address=10.99.99.99 comment="${tag}"`,
			);

			const entries = (await chr.rest("/ip/firewall/address-list")) as AddressListEntry[];
			expect(entries).toBeArray();

			const hit = entries.find((e) => e.comment === tag);
			expect(hit).toBeDefined();
			// toMatchObject asserts a subset of fields — handy for REST records.
			expect(hit).toMatchObject({ address: "10.99.99.99", list: "quickchr-grounding" });
			console.log(`  grounded address-list entry: ${hit?.address} (${hit?.comment})`);
		},
		240_000,
	);

	test("a config write round-trips through a fresh REST read (system identity)", async () => {
		const ident = `chr-${NONCE}`;
		await chr.exec(`/system/identity/set name=${ident}`);

		const id = (await chr.rest("/system/identity")) as { name?: string };
		expect(id.name).toBe(ident);
		console.log(`  grounded system identity: ${id.name}`);
	});

	// `test.skipIf` gates a case on a runtime condition — here, only assert the
	// serialize→JSON path on a RouterOS that supports `:serialize` (7.x always does,
	// but this shows the pattern for version-gated behavior).
	const noSerialize = false;
	test.skipIf(noSerialize)("exec() output can be JSON via :serialize (agent-friendly read)", async () => {
		const r = await chr.exec(
			":local v [/system/resource/print as-value]; :put [:serialize to=json $v]",
		);
		const parsed = JSON.parse(r.output);
		const board = Array.isArray(parsed) ? parsed[0]["board-name"] : parsed["board-name"];
		expect(board).toMatch(/^CHR/);
	});
});
