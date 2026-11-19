/**
 * Shared filesystem paths: the user's home directory and quickchr's config-tier
 * (XDG_CONFIG-like) files.
 */

import { isAbsolute, join } from "node:path";
import { homedir, userInfo } from "node:os";
import { QuickCHRError } from "./types.ts";

/** True when `path` names the same place from any working directory. On Windows
 *  that means a drive-qualified (`C:\x`) or UNC (`\\server\share`) path:
 *  `isAbsolute()` also accepts a drive-relative `\x`, which lands on whichever
 *  drive the working directory is on (#276). */
export function isFullyQualifiedPath(path: string, platform: NodeJS.Platform = process.platform): boolean {
	// A UNC root needs both components: \\server\share.
	if (platform === "win32") return /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.test(path);
	return isAbsolute(path);
}

/** The value of an environment variable when it is a fully qualified path. An
 *  unset, empty or relative value counts as unset, so it can never root a
 *  quickchr path in the current working directory (#276). */
export function absoluteEnvPath(name: string): string | undefined {
	const value = process.env[name];
	return value && isFullyQualifiedPath(value) ? value : undefined;
}

/** The OS account's home directory from the user database, ignoring `HOME`
 *  (which `os.homedir()` echoes back even when it is relative). */
function accountHomeDir(): string | undefined {
	try {
		const home = userInfo().homedir;
		return home && isFullyQualifiedPath(home) ? home : undefined;
	} catch {
		return undefined;
	}
}

/** The user's home directory: `HOME`, then `USERPROFILE`, then `os.homedir()`,
 *  then the OS account record, each taken only when it is a fully qualified path.
 *  The one rule behind the data dir, the config dir and the completion paths, so
 *  they cannot disagree when `HOME` is unset (launchd, cron, a child spawned with a
 *  minimal env). Throws `STATE_ERROR` rather than return a relative path (#276). */
export function userHomeDir(): string {
	const fromEnv = absoluteEnvPath("HOME") ?? absoluteEnvPath("USERPROFILE");
	if (fromEnv) return fromEnv;
	const fromOs = homedir();
	if (fromOs && isFullyQualifiedPath(fromOs)) return fromOs;
	const fromAccount = accountHomeDir();
	if (fromAccount) return fromAccount;
	throw new QuickCHRError(
		"STATE_ERROR",
		"Cannot find the user's home directory: HOME and USERPROFILE are unset or not absolute paths, and the OS account has no home directory.",
		"Set HOME to an absolute path. QUICKCHR_DATA_DIR moves only the data tree; settings and stored credentials still live under ~/.config/quickchr.",
	);
}

/** ~/.config/quickchr — used by secrets.ts (credential fallback files) and
 *  settings.ts (quickchr.env). Single source of truth so those modules never
 *  drift on the home-directory rule. */
export function quickchrConfigDir(): string {
	return join(userHomeDir(), ".config", "quickchr");
}
