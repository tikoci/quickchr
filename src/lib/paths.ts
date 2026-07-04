/**
 * Shared filesystem paths for quickchr's config-tier (XDG_CONFIG-like) files.
 */

import { join } from "node:path";
import { homedir } from "node:os";

/** ~/.config/quickchr — used by secrets.ts (credential fallback files) and
 *  settings.ts (quickchr.env). Single source of truth so those modules never
 *  drift on the HOME/USERPROFILE fallback chain. */
export function quickchrConfigDir(): string {
	return join(process.env.HOME ?? process.env.USERPROFILE ?? homedir(), ".config", "quickchr");
}
