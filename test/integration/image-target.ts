import { CHANNELS, type Channel } from "../../src/lib/types.ts";

/**
 * RouterOS image selection for integration tests that just need "the default release".
 *
 * `QUICKCHR_TEST_TARGET` (set by integration.yml from the `routeros-target` dispatch
 * input) overrides the default so a single dispatch can point every platform's CHR boot
 * at one channel or a pinned version. Unset/empty → channel "stable" — preserves prior
 * behavior, so push CI, publish, and local `bun test` runs are unchanged.
 *
 * A channel name resolves to `{ channel }` (avoids the lenient channel-as-version warning
 * on `StartOptions.version`); anything else is treated as an explicit `{ version }`.
 *
 * Tests that intentionally pin a specific version (e.g. provisioning old-version coverage)
 * must NOT use this — they pass `version:` directly. Pinning an *old* target here makes the
 * version-gated provisioning/device-mode tests fail; that is expected and informative, not
 * a harness bug. All four channels satisfy the 7.20.8 provisioning baseline.
 */
export function imageTarget(): { channel: Channel } | { version: string } {
	const target = process.env.QUICKCHR_TEST_TARGET?.trim();
	if (!target) return { channel: "stable" };
	return (CHANNELS as readonly string[]).includes(target)
		? { channel: target as Channel }
		: { version: target };
}
