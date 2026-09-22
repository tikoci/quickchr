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
	"add-network", "network",
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

/** `set` applies a change to a machine that has already booted, so it takes the
 *  post-boot subset of the provisioning flags plus `--license`'s credential flags.
 *
 *  It is listed here for the **valueless** check, not for strictness: `set` still
 *  tolerates an unknown flag like every other non-creating command. The check that
 *  matters is arity — `quickchr set lab --device-mode` with no value parses as a
 *  boolean and would otherwise reach "Nothing to set", which blames the user for the
 *  wrong thing. */
const SET_ONLY_FLAGS = [
	"name", "license", "level", "account", "password",
	"device-mode", "device-mode-enable", "device-mode-disable",
] as const;

export const ADD_FLAGS: readonly string[] = CREATE_FLAGS;
export const START_FLAGS: readonly string[] = [...CREATE_FLAGS, ...START_ONLY_FLAGS];
export const SET_FLAGS: readonly string[] = SET_ONLY_FLAGS;

/** Every flag that takes a value, across every command — `parseFlags`'s arity table.
 *
 *  This is the parser's input, not only a validation list. Without it `parseFlags`
 *  guessed each flag's arity from the shape of the next argument — *if it does not start
 *  with `--`, consume it as the value* — which is one rule doing two jobs and getting one
 *  of them wrong: a boolean flag swallowed the following positional, so
 *  `quickchr start --vmnet-shared lab` set `vmnet-shared="lab"` and lost the machine name
 *  (#164). A flag absent from this set is boolean and never consumes an argument.
 *
 *  It is also what makes a missing value visible. `parseFlags` stores `true` when a
 *  value-taking flag is followed by another flag or by nothing, and `flag()` turns a
 *  boolean back into `undefined` — so `quickchr add --name --version 7.24.3` used to
 *  reach `add()` with no name at all and quietly create an auto-named machine. Checking
 *  names alone does not catch that; the value has to be checked too.
 *
 *  `--no-x` (which parses as `false`) is a deliberate negation, not a missing value,
 *  so only an explicit `true` is rejected.
 *
 *  Both directions are asserted mechanically against the CLI source in
 *  `test/unit/cli-flag-arity.test.ts` — every name read as a value is here, and no name
 *  read as a boolean is — and the scan covers direct access (`flags["older-than"]`) as
 *  well as the helpers, because that is where the first gap was. A new flag cannot skip
 *  this table by being forgotten; the audit is the test's job, not a reviewer's. */
export const VALUE_FLAGS: ReadonlySet<string> = new Set([
	// add / start
	"version", "channel", "arch", "name", "cpu", "mem", "accel",
	"add-package", "port-base", "forward",
	"add-network",
	"boot-disk-format", "boot-size", "add-disk",
	"device-mode", "device-mode-enable", "device-mode-disable",
	"add-user", "timeout-extra",
	"license-level", "license-account", "license-password",
	// exec / qga / console
	"via", "user", "password", "timeout", "path", "data", "script",
	// set --license
	"account", "level",
	// networks sockets create
	"mode", "port", "group",
	// completions / logs
	"shell", "lines",
	// cache prune
	"older-than", "max-age", "max-size",
]);

/** Flags that quickchr used to accept, and what to write instead.
 *
 *  `--vmnet-shared` / `--vmnet-bridge <iface>` were special cases for one network type
 *  that `--add-network` already expresses in general (#164). Removing them silently would
 *  repeat the defect they were removed for: a flag that is accepted and does nothing. A
 *  removed name stays known for as long as anyone might still type it, and says what
 *  replaced it. */
export const REMOVED_FLAGS: ReadonlyMap<string, string> = new Map([
	["vmnet-shared", "--add-network shared"],
	["vmnet-bridge", "--add-network bridged:<iface>"],
]);

/** Value-taking flags with a documented `--no-` spelling, where `false` is a real
 *  instruction rather than a value that went missing. `--no-device-mode` is the only
 *  one today; it is listed in `start --help`. Exported for the arity audit, which would
 *  otherwise read `flags["device-mode"] === false` as proof that it is a boolean. */
export const NEGATABLE_VALUE_FLAGS: ReadonlySet<string> = new Set(["device-mode"]);

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
