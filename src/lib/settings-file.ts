/**
 * The `quickchr.env` file tier of the settings system — path, raw read, and
 * dotenv-style parse.
 *
 * Split out of settings.ts as a **leaf** module (node:fs + paths.ts only) so
 * platform.ts can resolve the `accel` override's file tier without pulling in
 * settings.ts's transitive graph (settings → cache → state → network →
 * platform). That cycle loads eagerly at CLI startup and measurably slows every
 * `quickchr` invocation. settings.ts re-exports everything here, so this split
 * is invisible to callers.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { quickchrConfigDir } from "./paths.ts";

export const SETTINGS_FILE_NAME = "quickchr.env";

/** ~/.config/quickchr/quickchr.env */
export function settingsFilePath(): string {
	return join(quickchrConfigDir(), SETTINGS_FILE_NAME);
}

/** Raw non-empty lines, in file order. [] if the file doesn't exist. */
export function readSettingsFileLines(): string[] {
	const path = settingsFilePath();
	if (!existsSync(path)) return [];
	const text = readFileSync(path, "utf-8");
	const lines = text.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** Parse QUICKCHR_*=value lines into a flat map. Blank/comment lines ignored; later dup wins. */
export function parseSettingsFileLines(lines: readonly string[]): Record<string, string> {
	const result: Record<string, string> = {};
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
		result[key] = line.slice(eq + 1).trim();
	}
	return result;
}

/** The `file` tier every resolver call reads. {} when the file is absent. */
export function loadSettingsFileDefaults(): Record<string, string> {
	return parseSettingsFileLines(readSettingsFileLines());
}
