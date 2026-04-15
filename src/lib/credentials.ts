/**
 * Credential storage for quickchr.
 *
 * Two separate credential scopes:
 *
 * 1. **MikroTik web account** — mikrotik.com login for CHR trial licensing.
 *    One set of credentials, no per-machine variation.
 *    Env vars: MIKROTIK_WEB_ACCOUNT / MIKROTIK_WEB_PASSWORD.
 *
 * 2. **Instance credentials** — per-CHR username/password for REST API, exec, SSH.
 *    Stored per machine name.  Created automatically during provisioning (the
 *    `quickchr` managed account) or explicitly via --user/--password.
 *
 * Both scopes use the secrets.ts wrapper (Bun.secrets → config file fallback).
 */

import { secretGet, secretSet, secretDelete, secretStorageLabel, secretGetSync, secretSetSync, secretDeleteSync } from "./secrets.ts";

export interface MikrotikCredentials {
	account: string;
	password: string;
}

export interface InstanceCredentials {
	user: string;
	password: string;
}

const WEB_SERVICE = "com.quickchr.mikrotik-web";
const INSTANCE_SERVICE = "com.quickchr.instance";

// --- MikroTik Web Account (licensing) ---

/** Read MikroTik web account credentials from env vars or secret store.
 *  Returns null when no credentials are found anywhere. */
export async function getStoredCredentials(): Promise<MikrotikCredentials | null> {
	// Env vars — highest priority.  New names first, legacy fallback.
	const envAccount = process.env.MIKROTIK_WEB_ACCOUNT;
	const envPassword = process.env.MIKROTIK_WEB_PASSWORD;
	if (envAccount && envPassword) {
		return { account: envAccount, password: envPassword };
	}

	const account = await secretGet(WEB_SERVICE, "account");
	const password = await secretGet(WEB_SERVICE, "password");
	if (account && password) {
		return { account, password };
	}
	return null;
}

/** Save MikroTik web account credentials to the secret store. */
export async function saveCredentials(account: string, password: string): Promise<void> {
	await secretSet(WEB_SERVICE, "account", account);
	await secretSet(WEB_SERVICE, "password", password);
}

/** Delete stored MikroTik web account credentials. */
export async function deleteCredentials(): Promise<void> {
	await secretDelete(WEB_SERVICE, "account");
	await secretDelete(WEB_SERVICE, "password");
}

/** Describe where credentials are stored (for user-facing output). */
export function credentialStorageLabel(): string {
	return secretStorageLabel();
}

// --- Per-Instance Credentials (CHR login) ---

/** Read stored credentials for a CHR instance.  Returns null if none saved.
 *  Uses config file storage (not OS keychain) — instance credentials are ephemeral
 *  and don't require keychain-level security.  Avoids blocking macOS auth dialogs
 *  in non-interactive contexts (tests, background processes). */
export function getInstanceCredentials(machineName: string): InstanceCredentials | null {
	const raw = secretGetSync(INSTANCE_SERVICE, machineName);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as { user?: string; password?: string };
		if (parsed.user !== undefined && parsed.password !== undefined) {
			return { user: parsed.user, password: parsed.password };
		}
	} catch { /* corrupt entry */ }
	return null;
}

/** Save credentials for a CHR instance (config file, not keychain). */
export function saveInstanceCredentials(
	machineName: string,
	user: string,
	password: string,
): void {
	secretSetSync(INSTANCE_SERVICE, machineName, JSON.stringify({ user, password }));
}

/** Delete stored credentials for a CHR instance (config file, not keychain). */
export function deleteInstanceCredentials(machineName: string): void {
	secretDeleteSync(INSTANCE_SERVICE, machineName);
}
