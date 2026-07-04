/**
 * quickchr's own user-scoped settings — global preferences with no per-machine
 * home, stored at ~/.config/quickchr/quickchr.env (dotenv-style: one
 * QUICKCHR_KEY=value line per managed setting).
 *
 * Precedence per key (highest wins): CLI flag > QUICKCHR_<KEY> env var >
 * quickchr.env > built-in default. This module only resolves the middle two
 * tiers (env, file) plus the built-in default — callers compose
 * `flagValue ?? resolveSetting(attr).value` themselves, so an explicit CLI
 * flag never runs through the settings validator.
 *
 * Does not read or write machine.json / MachineState — settings are CLI-start
 * input resolution, never per-machine config.
 */

import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, fsyncSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ARCHES, CHANNELS, QuickCHRError } from "./types.ts";
import type { Channel } from "./types.ts";
import { parseSizeString, DEFAULT_CACHE_MAX_BYTES } from "./cache.ts";
import { quickchrConfigDir } from "./paths.ts";

export type SettingsValue = string | number | boolean;
export type SettingsSource = "env" | "file" | "default";

export interface SettingsKeyDef {
	/** Kebab-case CLI-facing name, e.g. "default-channel". */
	attr: string;
	/** QUICKCHR_* env var name. */
	envKey: string;
	/** Parse + validate raw input (from env or file). Throws INVALID_SETTING_VALUE on bad input. */
	parse: (raw: string) => SettingsValue;
	/** Canonical on-disk/display form. */
	serialize: (value: SettingsValue) => string;
	/** Concrete built-in default when settings get/print should report one.
	 *  Omit only when "unset" has meaning distinct from a concrete value. */
	builtinDefault?: SettingsValue;
}

function parseChannel(raw: string): SettingsValue {
	if (!(CHANNELS as readonly string[]).includes(raw)) {
		throw new QuickCHRError("INVALID_SETTING_VALUE", `Invalid value "${raw}" for default-channel — must be one of ${CHANNELS.join(", ")}`);
	}
	return raw;
}

function parseArchSetting(raw: string): SettingsValue {
	const allowed = [...ARCHES, "auto"];
	if (!allowed.includes(raw)) {
		throw new QuickCHRError("INVALID_SETTING_VALUE", `Invalid value "${raw}" for default-arch — must be one of ${allowed.join(", ")}`);
	}
	return raw;
}

function parseCacheMaxSize(raw: string): SettingsValue {
	try {
		return parseSizeString(raw);
	} catch (e) {
		throw new QuickCHRError("INVALID_SETTING_VALUE", `Invalid value "${raw}" for cache-max-size — ${e instanceof Error ? e.message : String(e)}`);
	}
}

/** Shared with the CLI's own `--timeout-extra`/`-T` flag validation (cmdStart in
 *  src/cli/index.ts) so the same non-negative-integer rule applies whether the
 *  value comes from a flag, QUICKCHR_TIMEOUT_EXTRA, or quickchr.env. */
export function parseTimeoutExtraSeconds(raw: string): number {
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 0) {
		throw new QuickCHRError("INVALID_SETTING_VALUE", `Invalid value "${raw}" for timeout-extra — must be a non-negative integer number of seconds`);
	}
	return n;
}

function parseSecureLogin(raw: string): SettingsValue {
	const v = raw.trim().toLowerCase();
	if (["true", "1", "yes", "on"].includes(v)) return true;
	if (["false", "0", "no", "off"].includes(v)) return false;
	throw new QuickCHRError("INVALID_SETTING_VALUE", `Invalid value "${raw}" for secure-login — must be a boolean (true/false)`);
}

export const SETTINGS_KEYS: readonly SettingsKeyDef[] = [
	{
		attr: "default-channel",
		envKey: "QUICKCHR_DEFAULT_CHANNEL",
		builtinDefault: "stable" satisfies Channel,
		parse: parseChannel,
		serialize: (v) => String(v),
	},
	{
		attr: "default-arch",
		envKey: "QUICKCHR_DEFAULT_ARCH",
		builtinDefault: "auto",
		parse: parseArchSetting,
		serialize: (v) => String(v),
	},
	{
		attr: "cache-max-size",
		envKey: "QUICKCHR_CACHE_MAX_SIZE",
		builtinDefault: DEFAULT_CACHE_MAX_BYTES,
		parse: parseCacheMaxSize,
		serialize: (v) => String(v),
	},
	{
		attr: "timeout-extra",
		envKey: "QUICKCHR_TIMEOUT_EXTRA",
		builtinDefault: 0,
		parse: parseTimeoutExtraSeconds,
		serialize: (v) => String(v),
	},
	{
		// No builtinDefault: unlike the other 4 keys, the wizard needs to distinguish
		// "not configured" from "explicitly false" (src/cli/wizard.ts's userChoice
		// initialValue only pre-highlights "admin" when the setting is concretely
		// false) — a builtinDefault here would collapse that distinction and always
		// show "admin" even when nothing is configured. `resolveSecureLoginFlag`'s
		// own `=== true` check is unaffected either way. "(unset)" in `settings print`
		// means the consumer's own default (false / blank-admin) applies — see
		// MANUAL.md's settings table.
		attr: "secure-login",
		envKey: "QUICKCHR_SECURE_LOGIN",
		parse: parseSecureLogin,
		serialize: (v) => (v ? "true" : "false"),
	},
];

export const SETTINGS_FILE_NAME = "quickchr.env";

/** ~/.config/quickchr/quickchr.env */
export function settingsFilePath(): string {
	return join(quickchrConfigDir(), SETTINGS_FILE_NAME);
}

/** Accepts "default-channel" | "QUICKCHR_DEFAULT_CHANNEL" | "DEFAULT_CHANNEL" | "default_channel". */
export function lookupSettingsKey(input: string): SettingsKeyDef | undefined {
	let name = input.trim();
	if (/^quickchr[_-]/i.test(name)) {
		name = name.replace(/^quickchr[_-]/i, "");
	}
	name = name.toLowerCase().replace(/_/g, "-");
	return SETTINGS_KEYS.find((def) => def.attr === name);
}

function unknownKeyError(input: string): QuickCHRError {
	return new QuickCHRError(
		"INVALID_SETTING_KEY",
		`"${input}" is not a recognized quickchr setting.`,
		"Run 'quickchr settings print' to see the managed keys.",
	);
}

// --- File IO ---

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

function lineEnvKey(line: string): string | undefined {
	const trimmed = line.trim();
	if (trimmed.length === 0 || trimmed.startsWith("#")) return undefined;
	const eq = trimmed.indexOf("=");
	if (eq <= 0) return undefined;
	return trimmed.slice(0, eq).trim();
}

function matchingLineIndices(lines: readonly string[], envKey: string): number[] {
	const indices: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (lineEnvKey(lines[i] ?? "") === envKey) indices.push(i);
	}
	return indices;
}

function rawValueAtLine(lines: readonly string[], index: number): string {
	const line = (lines[index] ?? "").trim();
	return line.slice(line.indexOf("=") + 1).trim();
}

/** Atomic write: temp file in the same dir + fsync + rename, single .bak copy. Creates the dir on first write. */
function writeSettingsFileLinesSync(lines: readonly string[]): void {
	const path = settingsFilePath();
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true });
	if (existsSync(path)) {
		try {
			copyFileSync(path, `${path}.bak`);
		} catch {
			// best-effort
		}
	}
	const content = lines.length > 0 ? `${lines.join("\n")}\n` : "";
	const tempPath = join(dir, `.${basename(path)}.tmp.${process.pid}.${Date.now().toString(36)}`);
	writeFileSync(tempPath, content, "utf-8");
	const fd = openSync(tempPath, "r+");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	try {
		renameSync(tempPath, path);
	} catch (e) {
		try {
			unlinkSync(tempPath);
		} catch {
			// ignore
		}
		throw e;
	}
}

// --- Resolution ---

export interface ResolvedSetting {
	value: SettingsValue | undefined;
	source: SettingsSource;
}

/**
 * 3-tier resolver: env > file > builtinDefault (undefined if none). Throws
 * INVALID_SETTING_KEY for an unrecognized attr, INVALID_SETTING_VALUE if the
 * env var or file line's value fails validation. Never sees a CLI flag value —
 * callers compose `flagValue ?? resolveSetting(attr).value` themselves.
 */
export function resolveSetting(attr: string, env: NodeJS.ProcessEnv = process.env): ResolvedSetting {
	const def = lookupSettingsKey(attr);
	if (!def) throw unknownKeyError(attr);

	const envRaw = env[def.envKey];
	if (envRaw !== undefined) {
		return { value: def.parse(envRaw), source: "env" };
	}

	const fileDefaults = loadSettingsFileDefaults();
	const fileRaw = fileDefaults[def.envKey];
	if (fileRaw !== undefined) {
		return { value: def.parse(fileRaw), source: "file" };
	}

	return { value: def.builtinDefault, source: "default" };
}

export interface SettingsGetResult extends ResolvedSetting {
	key: string;
}

/** Strict — throws on an unrecognized key or a malformed env/file value. */
export function settingsGet(attr: string, env: NodeJS.ProcessEnv = process.env): SettingsGetResult {
	const def = lookupSettingsKey(attr);
	if (!def) throw unknownKeyError(attr);
	return { key: def.attr, ...resolveSetting(attr, env) };
}

/** Tolerant — a malformed single value reports its raw string + source rather than throwing,
 *  so one bad line doesn't break the whole table. */
export function settingsPrint(env: NodeJS.ProcessEnv = process.env): SettingsGetResult[] {
	return SETTINGS_KEYS.map((def) => {
		try {
			return { key: def.attr, ...resolveSetting(def.attr, env) };
		} catch {
			const envRaw = env[def.envKey];
			if (envRaw !== undefined) return { key: def.attr, value: envRaw, source: "env" as const };
			const fileRaw = loadSettingsFileDefaults()[def.envKey];
			return { key: def.attr, value: fileRaw, source: "file" as const };
		}
	});
}

export interface SettingsSetResult {
	key: string;
	previous: SettingsValue | undefined;
	value: SettingsValue;
}

/** Validates, writes ONE line, preserves all other file content (comments, blank lines,
 *  foreign vars) byte-for-byte verbatim. */
export function settingsSet(attr: string, rawValue: string): SettingsSetResult {
	const def = lookupSettingsKey(attr);
	if (!def) throw unknownKeyError(attr);

	const parsed = def.parse(rawValue);

	const lines = readSettingsFileLines();
	const indices = matchingLineIndices(lines, def.envKey);
	const index = indices.at(-1) ?? -1;
	const previousRaw = index >= 0 ? rawValueAtLine(lines, index) : undefined;
	let previous: SettingsValue | undefined;
	if (previousRaw !== undefined) {
		try {
			previous = def.parse(previousRaw);
		} catch {
			previous = previousRaw;
		}
	}

	const newLine = `${def.envKey}=${def.serialize(parsed)}`;
	if (index >= 0) {
		lines[index] = newLine;
		for (let i = indices.length - 2; i >= 0; i--) {
			lines.splice(indices[i] ?? -1, 1);
		}
	} else {
		lines.push(newLine);
	}
	writeSettingsFileLinesSync(lines);

	return { key: def.attr, previous, value: parsed };
}

export interface SettingsResetResult {
	cleared: string[];
}

/** No attr → clears every managed-key line, preserving foreign/comment lines. reset ALWAYS
 *  deletes the line, never blanks it (a blank "KEY=" line is still "set" to a bash-sourced file). */
export function settingsReset(attr?: string): SettingsResetResult {
	if (attr !== undefined) {
		const def = lookupSettingsKey(attr);
		if (!def) throw unknownKeyError(attr);
		const lines = readSettingsFileLines();
		const indices = matchingLineIndices(lines, def.envKey);
		if (indices.length === 0) return { cleared: [] };
		for (let i = indices.length - 1; i >= 0; i--) {
			lines.splice(indices[i] ?? -1, 1);
		}
		writeSettingsFileLinesSync(lines);
		return { cleared: [def.attr] };
	}

	const lines = readSettingsFileLines();
	const managedEnvKeys = new Map(SETTINGS_KEYS.map((def) => [def.envKey, def.attr]));
	const cleared: string[] = [];
	const kept = lines.filter((line) => {
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith("#")) return true;
		const eq = trimmed.indexOf("=");
		if (eq <= 0) return true;
		const key = trimmed.slice(0, eq).trim();
		const attrName = managedEnvKeys.get(key);
		if (attrName === undefined) return true;
		cleared.push(attrName);
		return false;
	});
	if (cleared.length > 0) {
		writeSettingsFileLinesSync(kept);
	}
	return { cleared };
}
