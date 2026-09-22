/**
 * Resource-name validation — machine names and named-socket names.
 *
 * Both become a path segment under the data dir (`machines/<name>/`,
 * `networks/<name>.json`), so a name is not free text: it has to be safe to join
 * onto a path and safe to type back into a command. A name starting with `-`
 * also reads as a flag everywhere it is echoed (`quickchr remove --help`), which
 * is how `networks sockets create --help` persisted a socket called `--help` (#156).
 */

import { QuickCHRError } from "./types.ts";

/** Letters, digits, dot, underscore, hyphen — the charset already produced by
 *  `generateMachineName()` (e.g. `7.24.4-x86-1`), minus anything a shell or a
 *  path would reinterpret. */
const VALID_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const MAX_NAME_LENGTH = 64;

/** Throw `INVALID_NAME` unless `name` is safe as both a path segment and a CLI argument.
 *  `kind` names the resource in the message ("machine", "named socket"). */
export function assertValidResourceName(name: string, kind: string): void {
	const reject = (why: string) => {
		throw new QuickCHRError("INVALID_NAME", `Invalid ${kind} name "${name}" — ${why}`);
	};

	if (name.length === 0) reject("names cannot be empty");
	if (name.startsWith("-")) reject(`names cannot start with "-" (it would be read as a flag)`);
	if (name.length > MAX_NAME_LENGTH) reject(`names are limited to ${MAX_NAME_LENGTH} characters`);
	if (!VALID_NAME.test(name)) {
		reject("names may contain only letters, digits, dot, underscore and hyphen, and must start with a letter or digit");
	}
}

/** The weaker rule that applies to a name being *used*, not created.
 *
 *  `assertValidResourceName()` cannot guard a lookup or a delete: machines created
 *  under the older, looser rules have to stay addressable. But a name still becomes a
 *  path segment, and `join(machinesDir, name)` happily normalizes `..` into the data
 *  directory itself — so `removeOrphan("..")` would `rmSync` every machine, the cache
 *  and the socket registry. This is the minimum that stops that while passing every
 *  name a real machine can have. */
export function isPathSafeName(name: string): boolean {
	if (name.length === 0) return false;
	if (name === "." || name === "..") return false;
	if (name.includes("/") || name.includes("\0")) return false;
	// `\` is a path separator on Windows and an ordinary filename character on POSIX.
	// Rejecting it everywhere would strand a machine named `lab\old` under the older,
	// looser creation rules: `list` still shows it, so `remove` has to still clear it.
	if (process.platform === "win32" && name.includes("\\")) return false;
	return true;
}

/** Throwing form of {@link isPathSafeName}, for the paths that delete. */
export function assertPathSafeName(name: string, kind: string): void {
	if (!isPathSafeName(name)) {
		throw new QuickCHRError(
			"INVALID_NAME",
			`Invalid ${kind} name ${JSON.stringify(name)} — a name cannot be empty, "." or "..", or contain a path separator`,
		);
	}
}

/** Non-throwing form, for callers that want to branch rather than fail. */
export function isValidResourceName(name: string): boolean {
	try {
		assertValidResourceName(name, "resource");
		return true;
	} catch {
		return false;
	}
}

/** POSIX-shell-safe form of `value`, for a command quickchr prints for someone to run.
 *
 *  Needed because `assertValidResourceName()` only guards names at *creation*. A
 *  lookup has to keep older, looser names addressable — `isPathSafeName()` above
 *  rejects only empty, `.`, `..` and a path separator — so a real machine can be
 *  called `lab old` or `my;lab`, and `quickchr set lab old --device-mode rose` pasted
 *  into a shell addresses a machine called `lab`. Device-mode feature names have the
 *  same problem from the other end: `resolveDeviceModeOptions()` deliberately passes
 *  unknown features through for forward compatibility, so a typo with a space in it
 *  reaches the printed command intact.
 *
 *  Values that need no quoting are returned unchanged, because the overwhelmingly
 *  common case is an ordinary name and a command in quotes reads like machine output
 *  rather than something a person would type.
 *
 *  What this does **not** fix: a legacy name starting with `-` is read as a flag no
 *  matter how it is quoted, since quoting is the shell's business and the flag parse
 *  is quickchr's. New names cannot start with `-` (#156); an old one that does needs
 *  renaming, not escaping. */
export function shellQuote(value: string): string {
	if (value.length > 0 && /^[A-Za-z0-9._:=@,+/-]+$/.test(value)) return value;
	return `'${value.replaceAll("'", "'\\''")}'`;
}
