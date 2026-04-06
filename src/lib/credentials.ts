/**
 * MikroTik account credential storage using the OS native secret store.
 *
 * Credential resolution order (highest priority first):
 *   1. Env vars: MIKROTIK_ACCOUNT + MIKROTIK_PASSWORD (CI / GitHub Actions)
 *   2. macOS Keychain (security CLI) — includes browser-saved mikrotik.com passwords
 *   3. Linux GNOME Keyring (secret-tool CLI) if available
 *   4. Windows Credential Manager (PowerShell cmdkey) if available
 *   5. Config file: ~/.config/quickchr/credentials.json (permissions 0o600)
 *
 * Saving always targets the native OS store when possible, with config file fallback.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export interface MikrotikCredentials {
	account: string;
	password: string;
}

const KEYCHAIN_SERVICE = "mikrotik.com";
const CONFIG_PATH = join(homedir(), ".config", "quickchr", "credentials.json");

// --- Public API ---

/** Read MikroTik credentials from env vars, OS keychain, or config file.
 *  Returns null when no credentials are found anywhere. */
export async function getStoredCredentials(): Promise<MikrotikCredentials | null> {
	// 1. Env vars — highest priority, always works in CI
	const envAccount = process.env.MIKROTIK_ACCOUNT;
	const envPassword = process.env.MIKROTIK_PASSWORD;
	if (envAccount && envPassword) {
		return { account: envAccount, password: envPassword };
	}

	// 2–4. OS native secret store
	const os = process.platform;
	if (os === "darwin") return readMacOsKeychain();
	if (os === "linux") return readLinuxSecret();
	if (os === "win32") return readWindowsCredential();

	// 5. Config file fallback
	return readConfigFile();
}

/** Save MikroTik credentials to the OS native secret store (or config file fallback). */
export async function saveCredentials(
	account: string,
	password: string,
): Promise<void> {
	const os = process.platform;
	if (os === "darwin") {
		await writeMacOsKeychain(account, password);
		return;
	}
	if (os === "linux") {
		const ok = await writeLinuxSecret(account, password);
		if (ok) return;
	}
	if (os === "win32") {
		const ok = await writeWindowsCredential(account, password);
		if (ok) return;
	}
	writeConfigFile(account, password);
}

/** Delete stored MikroTik credentials (clears keychain entry and config file). */
export async function deleteCredentials(): Promise<void> {
	const os = process.platform;
	if (os === "darwin") {
		Bun.spawnSync([
			"security",
			"delete-internet-password",
			"-s",
			KEYCHAIN_SERVICE,
		], { stdout: "pipe", stderr: "pipe" });
	} else if (os === "linux") {
		try {
			Bun.spawnSync(
				["secret-tool", "clear", "service", KEYCHAIN_SERVICE],
				{ stdout: "pipe", stderr: "pipe" },
			);
		} catch { /* ignore if secret-tool unavailable */ }
	} else if (os === "win32") {
		Bun.spawnSync(
			["cmdkey", `/delete:${KEYCHAIN_SERVICE}`],
			{ stdout: "pipe", stderr: "pipe" },
		);
	}
	// Always clean up config file too
	if (existsSync(CONFIG_PATH)) {
		try {
			const { unlinkSync } = await import("node:fs");
			unlinkSync(CONFIG_PATH);
		} catch { /* ignore */ }
	}
}

/** Describe where credentials are stored (for user-facing output). */
export function credentialStorageLabel(): string {
	const os = process.platform;
	if (os === "darwin") return "macOS Keychain";
	if (os === "linux") return "GNOME Keyring (secret-tool)";
	if (os === "win32") return "Windows Credential Manager";
	return `config file (${CONFIG_PATH})`;
}

// --- macOS Keychain ---

/**
 * Read credentials from macOS Keychain via `security` CLI.
 * Tries both "mikrotik.com" and "www.mikrotik.com" since browsers save with different server keys.
 * Note: on first access the OS may show a keychain access prompt.
 */
async function readMacOsKeychain(): Promise<MikrotikCredentials | null> {
	for (const server of [KEYCHAIN_SERVICE, `www.${KEYCHAIN_SERVICE}`]) {
		const result = Bun.spawnSync(
			["security", "find-internet-password", "-s", server, "-g"],
			{ stdout: "pipe", stderr: "pipe" },
		);

		if (result.exitCode !== 0) continue;

		// `security -g` writes password to stderr, attributes to stdout
		const out = new TextDecoder().decode(result.stdout);
		const err = new TextDecoder().decode(result.stderr);
		const combined = out + err;

		const account = /^\s*"acct"<blob>="(.+)"$/m.exec(combined)?.[1];
		const password = /^password: "(.+)"$/m.exec(combined)?.[1];

		if (account && password) {
			return { account, password };
		}
	}
	return readConfigFile();
}

async function writeMacOsKeychain(account: string, password: string): Promise<void> {
	const result = Bun.spawnSync(
		[
			"security",
			"add-internet-password",
			"-s", KEYCHAIN_SERVICE,
			"-a", account,
			"-w", password,
			"-U", // -U: update if exists
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (result.exitCode !== 0) {
		// Fallback to config file if keychain write fails (e.g. permission denied)
		writeConfigFile(account, password);
	}
}

// --- Linux GNOME Keyring via secret-tool ---

async function readLinuxSecret(): Promise<MikrotikCredentials | null> {
	// secret-tool is in package libsecret-tools (Ubuntu/Debian) or libsecret (Arch/Fedora)
	const which = Bun.spawnSync(["which", "secret-tool"], { stdout: "pipe", stderr: "pipe" });
	if (which.exitCode !== 0) return readConfigFile();

	// Try to look up account stored with our own save
	const result = Bun.spawnSync(
		["secret-tool", "lookup", "service", KEYCHAIN_SERVICE, "type", "quickchr"],
		{ stdout: "pipe", stderr: "pipe" },
	);

	if (result.exitCode !== 0) return readConfigFile();

	// secret-tool lookup outputs json: {"password": "...", "account": "..."}
	try {
		const text = new TextDecoder().decode(result.stdout).trim();
		const parsed = JSON.parse(text) as { account?: string; password?: string };
		if (parsed.account && parsed.password) {
			return { account: parsed.account, password: parsed.password };
		}
	} catch { /* malformed output */ }

	return readConfigFile();
}

async function writeLinuxSecret(account: string, password: string): Promise<boolean> {
	const which = Bun.spawnSync(["which", "secret-tool"], { stdout: "pipe", stderr: "pipe" });
	if (which.exitCode !== 0) return false;

	// Store as JSON to carry both account and password in a single entry
	const value = JSON.stringify({ account, password });
	const proc = Bun.spawn(
		["secret-tool", "store", "--label", `MikroTik Account (${account})`, "service", KEYCHAIN_SERVICE, "type", "quickchr"],
		{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
	);
	proc.stdin.write(new TextEncoder().encode(value));
	proc.stdin.end();
	const exit = await proc.exited;
	return exit === 0;
}

// --- Windows Credential Manager ---

async function readWindowsCredential(): Promise<MikrotikCredentials | null> {
	// Read via PowerShell — requires Windows.Security.Credentials API
	const script = `
[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]
try {
  $vault = New-Object Windows.Security.Credentials.PasswordVault
  $creds = $vault.FindAllByResource('${KEYCHAIN_SERVICE}')
  $cred = $creds[0]
  $cred.RetrievePassword()
  Write-Output ("{""account"":""$($cred.UserName)"",""password"":""$($cred.Password)""}")
} catch { Write-Output "" }
`.trim();

	const result = Bun.spawnSync(
		["powershell", "-NonInteractive", "-Command", script],
		{ stdout: "pipe", stderr: "pipe" },
	);

	if (result.exitCode !== 0) return readConfigFile();

	try {
		const text = new TextDecoder().decode(result.stdout).trim();
		const parsed = JSON.parse(text) as { account?: string; password?: string };
		if (parsed.account && parsed.password) {
			return { account: parsed.account, password: parsed.password };
		}
	} catch { /* ignore */ }

	return readConfigFile();
}

async function writeWindowsCredential(account: string, password: string): Promise<boolean> {
	const script = `
[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]
$vault = New-Object Windows.Security.Credentials.PasswordVault
$cred = New-Object Windows.Security.Credentials.PasswordCredential('${KEYCHAIN_SERVICE}', '${account.replace(/'/g, "''")}', '${password.replace(/'/g, "''")}')
$vault.Add($cred)
`.trim();

	const result = Bun.spawnSync(
		["powershell", "-NonInteractive", "-Command", script],
		{ stdout: "pipe", stderr: "pipe" },
	);

	return result.exitCode === 0;
}

// --- Config file fallback ---

function readConfigFile(): MikrotikCredentials | null {
	if (!existsSync(CONFIG_PATH)) return null;
	try {
		const raw = readFileSync(CONFIG_PATH, "utf8");
		const parsed = JSON.parse(raw) as { account?: string; password?: string };
		if (parsed.account && parsed.password) {
			return { account: parsed.account, password: parsed.password };
		}
	} catch { /* corrupt file */ }
	return null;
}

function writeConfigFile(account: string, password: string): void {
	const dir = dirname(CONFIG_PATH);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(CONFIG_PATH, JSON.stringify({ account, password }, null, 2), "utf8");
	// 0o600: owner-read/write only
	chmodSync(CONFIG_PATH, 0o600);
}
