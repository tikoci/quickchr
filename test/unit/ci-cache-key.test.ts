import { describe, expect, test } from "bun:test";
import { CACHE_KEY_GENERATION, cacheIdentity, resolveTargets } from "../../scripts/ci-cache-key.ts";
import type { Channel } from "../../src/lib/types.ts";

// Anchor tests for the CHR image cache identity (scripts/ci-cache-key.ts, #104).
// The contract these pin: a key names a PLATFORM and a CONCRETE VERSION, so an
// exact hit means "the entry already holds what this leg needs" and the skipped
// save is correct. A key that varied per run (or named a channel alias) breaks
// that reasoning — see the module header.

const stubResolver = async (channel: Channel) =>
	({ stable: "7.22.1", "long-term": "7.20.8", testing: "7.23.1", development: "7.24beta2" })[channel];

describe("cacheIdentity", () => {
	test("key carries the generation, platform and resolved version", () => {
		const { key } = cacheIdentity("linux-x86", "7.22.1");
		expect(key).toBe(`chr-images-${CACHE_KEY_GENERATION}-linux-x86-7.22.1`);
	});

	test("no run id or attempt in the key — the same version reuses the same entry", () => {
		expect(cacheIdentity("macos-x86", "7.22.1")).toEqual(cacheIdentity("macos-x86", "7.22.1"));
	});

	test("a different resolved version is a different entry", () => {
		expect(cacheIdentity("linux-x86", "7.22.1").key).not.toBe(cacheIdentity("linux-x86", "7.22.2").key);
	});

	test("platforms never share an entry", () => {
		const keys = ["linux-x86", "linux-arm64", "macos-arm64", "macos-x86", "windows-x86"].map(
			(p) => cacheIdentity(p, "7.22.1").key,
		);
		expect(new Set(keys).size).toBe(keys.length);
	});

	test("restore-key prefix matches the platform's own keys and nothing else", () => {
		const [prefix] = cacheIdentity("linux-arm64", "7.22.1").restoreKeys;
		expect(cacheIdentity("linux-arm64", "7.20.8").key.startsWith(prefix ?? "")).toBe(true);
		expect(cacheIdentity("linux-x86", "7.20.8").key.startsWith(prefix ?? "")).toBe(false);
	});
});

describe("resolveTargets", () => {
	test("channel aliases resolve to concrete versions", async () => {
		expect(await resolveTargets(["stable", "long-term"], stubResolver)).toEqual({
			stable: "7.22.1",
			"long-term": "7.20.8",
		});
	});

	test("a version-shaped target resolves to itself and never hits the network", async () => {
		const fail = async () => {
			throw new Error("resolver must not be called for a pinned version");
		};
		expect(await resolveTargets(["7.24beta2"], fail)).toEqual({ "7.24beta2": "7.24beta2" });
	});

	test("duplicates and blanks collapse to one lookup per distinct target", async () => {
		let calls = 0;
		const counting = async (c: Channel) => {
			calls++;
			return stubResolver(c);
		};
		expect(await resolveTargets(["stable", " stable", ""], counting)).toEqual({ stable: "7.22.1" });
		expect(calls).toBe(1);
	});

	test("a plausible-but-wrong channel name throws instead of producing a key", async () => {
		// "latest" is not one of RouterOS's four channels. A key naming a version
		// no leg will boot is worse than a failed plan, so this must not resolve.
		expect(resolveTargets(["latest"], stubResolver)).rejects.toThrow(/Invalid RouterOS target/);
	});
});
