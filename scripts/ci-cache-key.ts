#!/usr/bin/env bun
/**
 * ci-cache-key — CHR image cache identity for integration.yml (issue #104).
 *
 * The cache entry a leg reads and (sometimes) writes is identified by the
 * PLATFORM it runs on and the CONCRETE RouterOS version it will boot — never by
 * run id, never by channel alias. Two modes:
 *
 * resolve — run in the `plan` job, once per dispatch:
 *             bun scripts/ci-cache-key.ts resolve stable,7.21.5
 *           Prints a JSON map {target: concrete version} on stdout. Channel
 *           aliases go through the library's resolveVersion(), so CI and
 *           `quickchr start --channel` read the same upgrade server through the
 *           same code. A version-shaped target resolves to itself.
 *
 * leg     — run inside an integration/examples leg, before the cache step:
 *             bun scripts/ci-cache-key.ts leg --version 7.22.1 \
 *               --platform linux-x86 --owner true
 *           Emits path/key/restore_keys/owner to $GITHUB_OUTPUT (and a human
 *           line to stdout). `path` comes from getCacheDir(), so the workflow
 *           cannot drift from the directory quickchr actually downloads into.
 *
 * verify  — run in an owner leg immediately BEFORE saving:
 *             bun scripts/ci-cache-key.ts verify --version 7.22.1
 *           Emits `matches=true|false` — does the cache directory actually hold
 *           an image of the version the key names? See THE DRIFT GUARD below.
 *
 * WHY THE KEY MUST NOT ROTATE ANY MORE (and why that is safe now):
 * `actions/cache` skips its post-job save whenever the primary key hit exactly.
 * The old `-v1` key was static AND version-blind, so once populated it hit
 * forever and a newly-resolved RouterOS version re-downloaded on every run
 * (#91). #101 fixed that by keying on run id/attempt — which made every leg of
 * every run write a fresh ~250-520 MB entry (~1 GB per push to main), pushing
 * the repo past its 10 GB quota (#104) and leaving cold download an
 * uncontrolled variable in every timing measurement (#106, and see B7's
 * measurement in ci.instructions.md).
 *
 * Keying on the RESOLVED version fixes both: the key changes exactly when the
 * content it names changes, so an exact hit legitimately means "this entry
 * already holds what this leg needs" and skipping the save is correct.
 *
 * OWNERSHIP. An exact hit skipping the save is only sound while the entry's
 * content is a function of its key, so exactly one configuration may WRITE a
 * given key: an integration leg running the FULL, unfiltered suite. That leg
 * downloads the whole set — the resolved target plus the version-pinned images
 * and package archives the suite fixes (7.20.7/7.20.8 in provisioning, 7.22.1
 * in license/library-api). Everything else — filtered dispatches, the tcg-smoke
 * subset, and the examples-smoke job — restores read-only. A partial run must
 * never own the key: its thinner content would hit exactly on a later full run,
 * which would then skip its save and re-download the missing pinned images
 * forever. That is #91 again in a different dress.
 *
 * THE DRIFT GUARD. `plan` fixes `matrix.resolved` at planning time, but a leg
 * boots `matrix.target` — and for a channel target, every `start()` re-resolves
 * it independently. So a release landing mid-dispatch means the leg downloads
 * 7.23.3 while its key says 7.23.2. On an exact hit nothing is written and the
 * drift is harmless. On a MISS the leg would save 7.23.3 content under the
 * 7.23.2 key, and that is not self-correcting: every later leg targeting a
 * pinned 7.23.2 exact-hits an entry without its image, re-downloads, and cannot
 * save — #91 once more, permanently, for that key.
 *
 * So an owner verifies before it saves: the cache directory must actually hold
 * an image of the version the key names, read through the library's own cache
 * parser rather than a filename guess. If it does not, the leg skips the save
 * and says why. Nothing is poisoned, and the next dispatch resolves the new
 * version, misses a new key, and saves correctly.
 */
import { appendFileSync } from "node:fs";
import { listCacheEntries } from "../src/lib/cache.ts";
import { getCacheDir } from "../src/lib/state.ts";
import { CHANNELS, type Channel } from "../src/lib/types.ts";
import { isValidVersion, resolveVersion } from "../src/lib/versions.ts";

/** Bump when the CONTENT CONTRACT of an entry changes (not when a key input
 *  does — the inputs are in the key). `v3` = resolved-version keys with a single
 *  owner; `v2` was the per-run rotation. Old generations age out under the LRU. */
export const CACHE_KEY_GENERATION = "v3";

export interface CacheIdentity {
	key: string;
	restoreKeys: string[];
}

/** Cache identity for one leg. The platform id is the content partition (guest
 *  arch and host OS both follow from it); the version is what makes the key
 *  change exactly when the cached set does. */
export function cacheIdentity(platform: string, version: string): CacheIdentity {
	const prefix = `chr-images-${CACHE_KEY_GENERATION}-${platform}-`;
	return { key: `${prefix}${version}`, restoreKeys: [prefix] };
}

/** True when this target is a channel alias needing a network lookup. */
function isChannel(target: string): target is Channel {
	return (CHANNELS as readonly string[]).includes(target);
}

/** Resolve each target to a concrete RouterOS version. Channels hit the upgrade
 *  server (in parallel); version-shaped targets are already concrete. Throws on
 *  anything else — a malformed target must fail the plan, cheaply, rather than
 *  produce a key naming a version no leg will ever boot. */
export async function resolveTargets(
	targets: string[],
	resolver: (channel: Channel) => Promise<string> = resolveVersion,
): Promise<Record<string, string>> {
	const unique = [...new Set(targets.map((t) => t.trim()).filter(Boolean))];
	const pairs = await Promise.all(
		unique.map(async (t) => {
			if (isChannel(t)) return [t, await resolver(t)] as const;
			if (isValidVersion(t)) return [t, t] as const;
			throw new Error(`Invalid RouterOS target "${t}" — expected a channel (${CHANNELS.join(", ")}) or a version like 7.22.1`);
		}),
	);
	return Object.fromEntries(pairs);
}

/** Does the cache hold an image of `version`? The versions come from the
 *  library's own cache parser, so this asks the same question `quickchr cache
 *  list` answers rather than guessing at filenames and arch suffixes. */
export function cacheHoldsVersion(version: string, entries: Array<{ version: string }>): boolean {
	return entries.some((e) => e.version === version);
}

function flag(args: string[], name: string): string | undefined {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : undefined;
}

/** Append step outputs to $GITHUB_OUTPUT (multi-line values use the heredoc
 *  form) and echo them, so the leg's log states its own cache identity. Append,
 *  never write: the file accumulates every output of the step. */
function emit(outputs: Record<string, string>): void {
	const text = Object.entries(outputs)
		.map(([k, v]) => (v.includes("\n") ? `${k}<<__EOF__\n${v}\n__EOF__` : `${k}=${v}`))
		.join("\n");
	const file = process.env.GITHUB_OUTPUT;
	if (file) appendFileSync(file, `${text}\n`);
	console.log(text);
}

if (import.meta.main) {
	const [mode, ...args] = process.argv.slice(2);
	// Failures surface as a GitHub annotation, not a Bun stack trace: this runs
	// in the plan job, where a bad target must read as one actionable line.
	try {
		if (mode === "resolve") {
			const map = await resolveTargets((args[0] ?? "").split(","));
			console.log(JSON.stringify(map));
		} else if (mode === "leg") {
			const version = flag(args, "version") ?? "";
			const platform = flag(args, "platform") ?? "";
			const owner = flag(args, "owner") === "true";
			if (!isValidVersion(version)) throw new Error(`--version must be a concrete RouterOS version, got "${version}"`);
			if (!platform) throw new Error("--platform is required");
			const { key, restoreKeys } = cacheIdentity(platform, version);
			emit({
				path: getCacheDir(),
				key,
				restore_keys: restoreKeys.join("\n"),
				owner: String(owner),
			});
		} else if (mode === "verify") {
			const version = flag(args, "version") ?? "";
			if (!isValidVersion(version)) throw new Error(`--version must be a concrete RouterOS version, got "${version}"`);
			const entries = listCacheEntries();
			const matches = cacheHoldsVersion(version, entries);
			const held = [...new Set(entries.map((e) => e.version))].sort().join(", ") || "(empty)";
			// Always print what was found, not just the verdict: a skipped save is
			// only diagnosable if the log says which versions were actually there.
			console.log(`cache holds: ${held}`);
			emit({ matches: String(matches) });
		} else {
			throw new Error("usage: ci-cache-key.ts resolve <targets-csv> | leg --version <v> --platform <id> --owner <bool> | verify --version <v>");
		}
	} catch (err) {
		console.error(`::error::ci-cache-key${mode ? ` ${mode}` : ""}: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}
}
