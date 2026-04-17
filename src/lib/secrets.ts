/**
 * Cross-platform secret storage wrapper.
 *
 * Uses Bun.secrets when available (macOS Keychain, Linux libsecret, Windows
 * Credential Manager).  Falls back to a config file with 0o600 permissions
 * when Bun.secrets is unavailable (Node.js, older Bun, headless Linux without
 * a secret-service daemon).
 *
 * Callers should never touch Bun.secrets directly — this module handles the
 * runtime detection and fallback.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

function configDir(): string {
	return join(process.env.HOME ?? process.env.USERPROFILE ?? homedir(), ".config", "quickchr");
}

/** True when the Bun.secrets API is available at runtime. */
function hasBunSecrets(): boolean {
	try {
		return typeof Bun !== "undefined" && Bun.secrets != null;
	} catch {
		return false;
	}
}

// --- Config-file fallback helpers ---

function configPath(service: string): string {
	// One JSON file per service, keyed by name
	const safeName = service.replace(/[^a-zA-Z0-9._-]/g, "_");
	return join(configDir(), `${safeName}.json`);
}

function readConfigStore(service: string): Record<string, string> {
	const path = configPath(service);
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return {};
	}
}

function writeConfigStore(service: string, store: Record<string, string>): void {
	const path = configPath(service);
	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(path, JSON.stringify(store, null, 2), "utf8");
	chmodSync(path, 0o600);
}

// --- Public API ---

/** Retrieve a secret from the config file only (no OS keychain).
 *  Use for credentials that don't need OS-level security (e.g., per-instance CHR passwords). */
export function secretGetSync(service: string, name: string): string | null {
	return readConfigStore(service)[name] ?? null;
}

/** Store a secret in the config file only (no OS keychain). */
export function secretSetSync(service: string, name: string, value: string): void {
	const store = readConfigStore(service);
	store[name] = value;
	writeConfigStore(service, store);
}

/** Delete a secret from the config file only (no OS keychain).  Returns true if deleted. */
export function secretDeleteSync(service: string, name: string): boolean {
	const store = readConfigStore(service);
	if (!(name in store)) return false;
	delete store[name];
	writeConfigStore(service, store);
	return true;
}

/** Retrieve a secret.  Returns null when not found. */
export async function secretGet(service: string, name: string): Promise<string | null> {
	if (hasBunSecrets()) {
		try {
			return await Bun.secrets.get({ service, name });
		} catch {
			// Bun.secrets threw (e.g. no keyring daemon on Linux) — fall through
		}
	}
	return readConfigStore(service)[name] ?? null;
}

/** Store or update a secret. */
export async function secretSet(service: string, name: string, value: string): Promise<void> {
	if (hasBunSecrets()) {
		try {
			await Bun.secrets.set({ service, name, value });
			return;
		} catch {
			// fall through to config file
		}
	}
	const store = readConfigStore(service);
	store[name] = value;
	writeConfigStore(service, store);
}

/** Delete a secret.  Returns true if something was deleted. */
export async function secretDelete(service: string, name: string): Promise<boolean> {
	let deleted = false;
	if (hasBunSecrets()) {
		try {
			deleted = await Bun.secrets.delete({ service, name });
		} catch {
			// ignore
		}
	}
	// Always clean up config file entry too
	const store = readConfigStore(service);
	if (name in store) {
		delete store[name];
		writeConfigStore(service, store);
		deleted = true;
	}
	return deleted;
}

/** Human-readable label for where secrets are stored. */
export function secretStorageLabel(): string {
	if (hasBunSecrets()) return "OS credential store (via Bun.secrets)";
	return `config file (${configDir()})`;
}
