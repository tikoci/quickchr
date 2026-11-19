/**
 * Shared filesystem paths: the user's home directory and quickchr's config-tier
 * (XDG_CONFIG-like) files.
 */

import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { QuickCHRError } from "./types.ts";

/** The value of an environment variable when it is an absolute path. An unset,
 *  empty or relative value counts as unset, so it can never root a quickchr
 *  path in the current working directory (#276). */
export function absoluteEnvPath(name: string): string | undefined {
	const value = process.env[name];
	return value && isAbsolute(value) ? value : undefined;
}

/** The user's home directory: `HOME`, then `USERPROFILE`, then the OS account
 *  record (`os.homedir()`), each taken only when it is an absolute path. The one
 *  rule behind the data dir, the config dir and the completion paths, so they
 *  cannot disagree when `HOME` is unset (launchd, cron, a child spawned with a
 *  minimal env). Throws `STATE_ERROR` rather than return a relative path (#276). */
export function userHomeDir(): string {
	const fromEnv = absoluteEnvPath("HOME") ?? absoluteEnvPath("USERPROFILE");
	if (fromEnv) return fromEnv;
	const fromOs = homedir();
	if (fromOs && isAbsolute(fromOs)) return fromOs;
	throw new QuickCHRError(
		"STATE_ERROR",
		"Cannot find the user's home directory: HOME and USERPROFILE are unset (or not absolute paths) and the OS account has no home directory.",
		"Set HOME, or set QUICKCHR_DATA_DIR to an absolute path.",
	);
}

/** ~/.config/quickchr — used by secrets.ts (credential fallback files) and
 *  settings.ts (quickchr.env). Single source of truth so those modules never
 *  drift on the home-directory rule. */
export function quickchrConfigDir(): string {
	return join(userHomeDir(), ".config", "quickchr");
}
