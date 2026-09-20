// cspell:ignore hlep
/**
 * Known-flag registry for the machine-creating commands.
 *
 * `parseFlags` accepts any `--flag`, and `add`/`start` read only the ones they know.
 * An unrecognised flag was therefore inert: `quickchr add --hlep` created a machine and
 * downloaded 43 MB, and `quickchr add --help` did the same (#156). A typo that creates
 * state is not a good default, so these two commands check their flags first.
 *
 * Only `add` and `start` are strict. They are the commands that create machines and
 * download images; the read-only commands can keep tolerating stray arguments.
 */

/** Flag names as `parseFlags` reports them: no leading dashes, and `--no-x` arrives as `x`. */
const CREATE_FLAGS = [
	"version", "channel", "arch", "name", "cpu", "mem", "accel",
	"add-package", "install-all-packages",
	"port-base", "forward", "winbox", "api-ssl",
	"add-network", "network", "vmnet-shared", "vmnet-bridge",
	"boot-disk-format", "boot-size", "add-disk",
	"device-mode", "device-mode-enable", "device-mode-disable",
	"add-user", "disable-admin", "secure-login",
] as const;

/** `start` also boots, so it owns the run-time flags on top of the create set. */
const START_ONLY_FLAGS = [
	"all", "dry-run", "background", "bg", "fg", "foreground",
	"install-deps", "timeout-extra",
	"license-level", "license-account", "license-password",
] as const;

export const ADD_FLAGS: readonly string[] = CREATE_FLAGS;
export const START_FLAGS: readonly string[] = [...CREATE_FLAGS, ...START_ONLY_FLAGS];

/** Flags that are meaningless without a value.
 *
 *  `parseFlags` stores `true` when a flag is followed by another flag or by nothing,
 *  and `flag()` turns a boolean back into `undefined` — so `quickchr add --name
 *  --version 7.24.3` used to reach `add()` with no name at all and quietly create an
 *  auto-named machine. Checking names alone does not catch that; the value has to be
 *  checked too.
 *
 *  `--no-x` (which parses as `false`) is a deliberate negation, not a missing value,
 *  so only an explicit `true` is rejected. */
const VALUE_FLAGS = new Set([
	"version", "channel", "arch", "name", "cpu", "mem", "accel",
	"add-package", "port-base", "forward",
	"add-network", "vmnet-bridge",
	"boot-disk-format", "boot-size", "add-disk",
	"device-mode", "device-mode-enable", "device-mode-disable",
	"add-user", "timeout-extra",
	"license-level", "license-account", "license-password",
]);

/** Value-taking flags with a documented `--no-` spelling, where `false` is a real
 *  instruction rather than a value that went missing. `--no-device-mode` is the only
 *  one today; it is listed in `start --help`. */
const NEGATABLE_VALUE_FLAGS = new Set(["device-mode"]);

/** Flags given without the value they require.
 *
 *  Both spellings have to be caught. `--name` followed by another flag parses as
 *  `true`, and `--no-name` parses as `false`; either way `flag()` returns `undefined`
 *  and the machine gets an auto-generated name. Only a string (or a repeatable flag's
 *  string[]) is a value. */
export function valuelessFlags(
	flags: Record<string, string | boolean | string[]>,
	known: readonly string[],
): Array<{ name: string; negated: boolean }> {
	const result: Array<{ name: string; negated: boolean }> = [];
	for (const name of Object.keys(flags)) {
		if (!known.includes(name) || !VALUE_FLAGS.has(name)) continue;
		const value = flags[name];
		if (typeof value === "string" || Array.isArray(value)) continue;
		if (value === false && NEGATABLE_VALUE_FLAGS.has(name)) continue;
		result.push({ name, negated: value === false });
	}
	return result;
}

/** Human-readable complaint for `valuelessFlags()` output. Empty when nothing is missing. */
export function valuelessFlagMessage(
	valueless: ReadonlyArray<{ name: string; negated: boolean }>,
	command: string,
): string {
	if (valueless.length === 0) return "";
	const lines = valueless.map(({ name, negated }) =>
		negated
			? `  --no-${name}  (not a supported negation — --${name} takes a value)`
			: `  --${name} <value>`,
	);
	return [
		`Error: flag${valueless.length > 1 ? "s" : ""} for 'quickchr ${command}' missing a value:`,
		...lines,
		`Run 'quickchr ${command} --help' for the full list.`,
	].join("\n");
}

function editDistance(a: string, b: string): number {
	// One rolling row — the suggestion only needs the distance, never the edit script.
	let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const current = [i, ...Array<number>(b.length).fill(0)];
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			current[j] = Math.min(
				(previous[j] ?? 0) + 1,
				(current[j - 1] ?? 0) + 1,
				(previous[j - 1] ?? 0) + cost,
			);
		}
		previous = current;
	}
	return previous[b.length] ?? 0;
}

/** The closest known flag to `name`, when one is close enough to be worth suggesting. */
export function suggestFlag(name: string, known: readonly string[]): string | undefined {
	let best: string | undefined;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const candidate of known) {
		const d = editDistance(name, candidate);
		if (d < bestDistance) {
			bestDistance = d;
			best = candidate;
		}
	}
	// 1/3 of the flag's length, so short flags need a near-exact match and long ones
	// tolerate a transposition or two.
	return bestDistance <= Math.max(1, Math.floor(name.length / 3)) ? best : undefined;
}

/** Every flag in `flags` that `known` does not list, with a suggestion where there is one. */
export function unknownFlags(
	flags: Record<string, string | boolean | string[]>,
	known: readonly string[],
): Array<{ name: string; suggestion?: string }> {
	return Object.keys(flags)
		.filter((name) => !known.includes(name))
		.map((name) => ({ name, suggestion: suggestFlag(name, known) }));
}

/** Human-readable complaint for `unknownFlags()` output. Empty when nothing is unknown. */
export function unknownFlagMessage(
	unknown: Array<{ name: string; suggestion?: string }>,
	command: string,
): string {
	if (unknown.length === 0) return "";
	const lines = unknown.map(({ name, suggestion }) =>
		suggestion ? `  --${name}  (did you mean --${suggestion}?)` : `  --${name}`,
	);
	return [
		`Error: unknown flag${unknown.length > 1 ? "s" : ""} for 'quickchr ${command}':`,
		...lines,
		`Run 'quickchr ${command} --help' for the full list.`,
	].join("\n");
}
