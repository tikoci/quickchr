/**
 * Post-boot provisioning — user creation, admin disable via REST API,
 * with a console transport fallback when REST is unavailable.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { QuickCHRError } from "./types.ts";
import { saveInstanceCredentials } from "./credentials.ts";
import { generatePassword } from "./password.ts";
import { waitForBoot } from "./qemu.ts";
import { consoleExec } from "./console.ts";
import { createLogger, type ProgressLogger } from "./log.ts";

/** The default user name created by quickchr for managed CHR access. */
export const QUICKCHR_USER = "quickchr";

export interface ProvisionResult {
	/** The user that was created (or null if none). */
	user: { name: string; password: string } | null;
}

async function readUser(httpPort: number, auth: string, name: string): Promise<Record<string, unknown> | undefined> {
	// Fetch the full user list and filter client-side.  RouterOS REST filter
	// query syntax differs across versions and is unreliable for name-based
	// lookups; fetching all users is safe given the small number of entries.
	const response = await fetch(`http://127.0.0.1:${httpPort}/rest/user`, {
		headers: { Authorization: auth },
		signal: AbortSignal.timeout(5000),
	});

	if (!response.ok) {
		const body = await response.text();
		throw new QuickCHRError(
			"PROCESS_FAILED",
			`Failed to read user list: HTTP ${response.status} — ${body}`,
		);
	}

	const users = await response.json() as Record<string, unknown>[];
	if (!Array.isArray(users)) return undefined;
	return users.find((u) => u.name === name);
}

/** Wait for the REST API to be fully ready on a fresh (unprovisioned) CHR.
 *
 * Delegates to the shared waitForBoot which guards against the startup race
 * (wrong body briefly after boot) and requires two consecutive stable
 * responses before declaring boot complete. */
async function waitForRest(
	httpPort: number,
	timeoutMs: number = 60_000,
): Promise<void> {
	// Provisioning always runs on a fresh CHR — use admin: (empty password)
	const booted = await waitForBoot(httpPort, timeoutMs, `Basic ${btoa("admin:")}`);
	if (!booted) {
		throw new QuickCHRError("BOOT_TIMEOUT", "REST API did not become available");
	}
}

/** Create a user via the REST API. */
export async function createUser(
	httpPort: number,
	name: string,
	password: string,
	group: string = "full",
): Promise<void> {
	await waitForRest(httpPort);

	const auth = `Basic ${btoa("admin:")}`;
	const response = await fetch(`http://127.0.0.1:${httpPort}/rest/user/add`, {
		method: "POST",
		headers: {
			Authorization: auth,
			"Content-Type": "application/json",
		},
		signal: AbortSignal.timeout(10_000),
		body: JSON.stringify({ name, password, group }),
	});

	if (!response.ok) {
		const body = await response.text();
		throw new QuickCHRError(
			"PROCESS_FAILED",
			`Failed to create user "${name}": HTTP ${response.status} — ${body}`,
		);
	}

	// RouterOS can acknowledge /user/add before the user record becomes visible.
	// Verify visibility (and group) so callers get deterministic behavior.
	const expectedGroup = group.trim().toLowerCase();
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		try {
			const user = await readUser(httpPort, auth, name);
			if (user) {
				const actualGroup = String(user.group ?? "").trim().toLowerCase();
				if (!actualGroup) {
					await Bun.sleep(500);
					continue;
				}
				if (actualGroup !== expectedGroup) {
					throw new QuickCHRError(
						"PROCESS_FAILED",
						`User "${name}" created with unexpected group (expected=${expectedGroup}, actual=${actualGroup})`,
					);
				}
				return;
			}
		} catch (e) {
			// Rethrow deliberate group mismatch errors; retry transient HTTP failures
			if (e instanceof QuickCHRError && e.message.includes("unexpected group")) throw e;
		}

		await Bun.sleep(500);
	}

	throw new QuickCHRError(
		"PROCESS_FAILED",
		`User "${name}" creation was acknowledged but did not become visible in RouterOS`,
	);
}

/** Disable the admin user via the REST API. */
export async function disableAdmin(httpPort: number, verifyAuth?: string): Promise<void> {
	await waitForRest(httpPort);

	const adminAuth = `Basic ${btoa("admin:")}`;

	// Prefer alternate credentials when available — RouterOS silently ignores
	// a user disabling itself via REST PATCH (returns 200 but no-ops).
	// The newly-created user with "full" group can disable admin reliably.
	const actionAuth = verifyAuth ?? adminAuth;

	// Look up admin's internal .id (e.g. "*1") so we can target it precisely.
	// RouterOS REST action endpoints interpret `numbers` as position/ID, not name,
	// so `numbers: "admin"` silently no-ops. PATCH by .id is reliable: the `*`
	// in the ID is a sub-delimiter (RFC 3986 path segments) and is NOT
	// percent-encoded by the WHATWG URL constructor or Bun's fetch.
	//
	// Retry the lookup: the /rest/user endpoint can return wrong data or HTTP 500
	// briefly after boot (startup race). Poll until we get a valid admin record.
	let adminUser: Record<string, unknown> | undefined;
	const lookupDeadline = Date.now() + 15_000;
	while (Date.now() < lookupDeadline) {
		try {
			adminUser = await readUser(httpPort, actionAuth, "admin");
			if (adminUser?.[".id"]) break;
		} catch {
			// Transient error (HTTP 500 during startup, auth propagation) — retry
		}
		await Bun.sleep(500);
	}
	if (!adminUser) {
		throw new QuickCHRError("PROCESS_FAILED", "Cannot disable admin: user not found in user list after 15s of retries");
	}
	const adminId = String(adminUser[".id"] ?? "");
	if (!adminId) {
		throw new QuickCHRError("PROCESS_FAILED", "Cannot disable admin: user record has no .id");
	}

	const disableResp = await fetch(`http://127.0.0.1:${httpPort}/rest/user/${adminId}`, {
		method: "PATCH",
		headers: {
			Authorization: actionAuth,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ disabled: "yes" }),
		signal: AbortSignal.timeout(10_000),
	});

	if (!disableResp.ok) {
		const body = await disableResp.text();
		throw new QuickCHRError(
			"PROCESS_FAILED",
			`Failed to disable admin: HTTP ${disableResp.status} — ${body}`,
		);
	}

	// Validate the PATCH response body — RouterOS returns the updated user object.
	// If the response confirms disabled=true, we know the change was applied.
	// If the response body is unexpected (boot race), fall through to verification loop.
	let patchConfirmed = false;
	try {
		const patchBody = await disableResp.json() as Record<string, unknown>;
		const patchDisabled = String(patchBody?.disabled ?? "");
		patchConfirmed = patchDisabled === "true" || patchDisabled === "yes";
	} catch { /* non-JSON body — fall through to verification loop */ }

	if (patchConfirmed) return;

	// PATCH didn't confirm the change in its body — poll until the change is visible.
	const readAuth = verifyAuth ?? adminAuth;
	let lastDiag = "";
	const deadline = Date.now() + 45_000;
	while (Date.now() < deadline) {
		// Primary: read admin user via alternate creds and check the disabled field.
		try {
			const user = await readUser(httpPort, readAuth, "admin");
			const d = String(user?.disabled ?? "");
			if (d === "yes" || d === "true") return;
			lastDiag = `readUser(auth=${verifyAuth ? "verifyAuth" : "adminAuth"}) returned disabled=${JSON.stringify(user?.disabled)}`;
		} catch (e) {
			lastDiag = `readUser threw: ${e instanceof Error ? e.message : String(e)}`;
		}

		// Secondary: if admin credentials get 401, admin auth is rejected = disabled.
		try {
			const probe = await fetch(`http://127.0.0.1:${httpPort}/rest/system/resource`, {
				headers: { Authorization: adminAuth },
				signal: AbortSignal.timeout(3000),
			});
			if (probe.status === 401) return;
		} catch { /* ignore */ }

		await Bun.sleep(500);
	}

	throw new QuickCHRError(
		"PROCESS_FAILED",
		`Admin disable timed out after 45s — admin user is still enabled. Last diagnostic: ${lastDiag}`,
	);
}

/** Provision a CHR via the serial console — fallback when REST is unavailable.
 *  Creates a user and optionally disables admin by sending RouterOS CLI commands
 *  over the serial socket. All commands run as admin with an empty password (fresh CHR). */
async function consoleProvision(
	machineDir: string,
	machineName: string,
	effectiveUser: { name: string; password: string } | null,
	shouldDisableAdmin: boolean,
	logger?: ProgressLogger,
): Promise<ProvisionResult> {
	const log = logger ?? createLogger();

	if (effectiveUser) {
		log.status(`  Creating user "${effectiveUser.name}" via serial console...`);
		// RouterOS CLI syntax: /user add name=... password=... group=full
		await consoleExec(
			machineDir,
			`/user add name="${effectiveUser.name}" password="${effectiveUser.password}" group=full`,
			"admin",
			"",
			30_000,
		);
		await saveInstanceCredentials(machineName, effectiveUser.name, effectiveUser.password);
		log.debug(`User "${effectiveUser.name}" created via console`);
	}

	if (shouldDisableAdmin) {
		log.status("  Disabling admin via serial console...");
		// Use newly-created user to disable admin — RouterOS silently ignores
		// disabling your own account while the current session is authenticated as that user.
		const disableUser = effectiveUser?.name ?? "admin";
		const disablePass = effectiveUser?.password ?? "";
		await consoleExec(machineDir, "/user set [find name=admin] disabled=yes", disableUser, disablePass, 30_000);
		log.debug("Admin disabled via console");
	}

	return { user: effectiveUser };
}

/**
 * Generate an ed25519 SSH keypair and install the public key on the CHR for `username`.
 * Keys are stored in `<machineDir>/ssh/id_ed25519` (private) and `.pub` (public).
 * This enables SSH transport without passwords for the quickchr managed user.
 */
export async function installSshKey(
	httpPort: number,
	username: string,
	machineName: string,
	machineDir: string,
): Promise<void> {
	const sshDir = join(machineDir, "ssh");
	mkdirSync(sshDir, { recursive: true });

	const privateKeyPath = join(sshDir, "id_ed25519");

	const keygen = Bun.spawnSync(
		["ssh-keygen", "-t", "ed25519", "-f", privateKeyPath, "-N", "", "-C", `quickchr@${machineName}`],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (keygen.exitCode !== 0) {
		throw new Error(`ssh-keygen failed: ${new TextDecoder().decode(keygen.stderr)}`);
	}

	const pubKey = (await Bun.file(`${privateKeyPath}.pub`).text()).trim();
	const auth = `Basic ${btoa("admin:")}`;
	const response = await fetch(`http://127.0.0.1:${httpPort}/rest/user/ssh-keys/add`, {
		method: "POST",
		headers: { Authorization: auth, "Content-Type": "application/json" },
		body: JSON.stringify({ user: username, key: pubKey }),
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`Failed to install SSH key for ${username}: HTTP ${response.status} ${body}`);
	}
	// Drain response body, then poll until the key appears in the listing.
	// RouterOS may accept the POST before the key store is queryable,
	// especially under load when internal async commits are delayed.
	await response.text().catch(() => "");
	const deadline = Date.now() + 60_000;
	let lastListBody = "";
	while (Date.now() < deadline) {
		try {
			const listResp = await fetch(`http://127.0.0.1:${httpPort}/rest/user/ssh-keys`, {
				headers: { Authorization: auth },
				signal: AbortSignal.timeout(5_000),
			});
			if (listResp.ok) {
				const body = await listResp.text();
				lastListBody = body;
				const keys = JSON.parse(body) as Array<{ user?: string }>;
				if (Array.isArray(keys) && keys.some((k) => k.user === username)) return;
			} else {
				lastListBody = `HTTP ${listResp.status}`;
			}
		} catch (e) {
			lastListBody = String(e);
		}
		await Bun.sleep(500);
	}
	throw new Error(`SSH key for ${username} was accepted by RouterOS but did not appear in the listing within 60s (last listing: ${lastListBody})`);
}

/** Run all provisioning steps based on the config.
 *
 * When `user` is provided, creates that exact user. When `user` is omitted
 * but `secureLogin` is true (or unset — it defaults to true), a `quickchr`
 * managed account is created automatically with a generated password.
 *
 * When `machineDir` is provided and the REST API does not become available within
 * 30 seconds, provisioning falls back to the serial console transport.
 *
 * Returns the user that was created (if any) so callers can display the
 * password and store it.
 */
export async function provision(
	httpPort: number,
	machineName: string,
	user?: { name: string; password: string },
	shouldDisableAdmin?: boolean,
	secureLogin?: boolean,
	logger?: ProgressLogger,
	machineDir?: string,
): Promise<ProvisionResult> {
	const log = logger ?? createLogger();

	// Determine what user to create.
	// Priority: explicit user > auto-create quickchr account (secureLogin must be explicit true)
	let effectiveUser = user ?? null;
	if (!effectiveUser && secureLogin === true) {
		effectiveUser = { name: QUICKCHR_USER, password: generatePassword() };
	}

	if (!effectiveUser && !shouldDisableAdmin) {
		// No user, no disable — save admin:"" as instance creds for symmetry
		await saveInstanceCredentials(machineName, "admin", "");
		return { user: null };
	}

	// Try REST provisioning. When machineDir is provided, use a shorter timeout
	// so the console fallback can engage sooner if REST isn't available.
	const restTimeout = machineDir ? 30_000 : 60_000;
	let usedConsolePath = false;
	try {
		await waitForRest(httpPort, restTimeout);
	} catch (e) {
		if (machineDir) {
			log.warn("REST API unavailable — falling back to serial console provisioning");
			const result = await consoleProvision(machineDir, machineName, effectiveUser, !!shouldDisableAdmin, logger);
			usedConsolePath = true;
			// After console provisioning the machine is booted; REST comes up shortly.
			// Attempt SSH key install for the managed quickchr user — non-fatal if REST is still unavailable.
			if (secureLogin && !user && effectiveUser) {
				try {
					await waitForRest(httpPort, 30_000);
					await installSshKey(httpPort, effectiveUser.name, machineName, machineDir);
				} catch (keyErr) {
					log.warn(`SSH key install failed after console provisioning (SSH transport will fall back to password): ${keyErr}`);
				}
			}
			return result;
		}
		throw e;
	}

	if (!usedConsolePath) {
		if (effectiveUser) {
			await createUser(httpPort, effectiveUser.name, effectiveUser.password);
			// Persist to secret store so resolveAuth() picks it up
			await saveInstanceCredentials(machineName, effectiveUser.name, effectiveUser.password);
		}

		if (secureLogin && !user && effectiveUser && machineDir) {
			// Brief pause so RouterOS propagates the new user to all subsystems
			// (including the SSH key store) before we attempt key installation.
			await Bun.sleep(1000);
			try {
				await installSshKey(httpPort, effectiveUser.name, machineName, machineDir);
			} catch (e) {
				log.warn(`SSH key install failed (SSH transport will fall back to password): ${e}`);
			}
		}

		if (shouldDisableAdmin) {
			if (!effectiveUser) {
				log.warn("Warning: disabling admin without creating another user — you may lose access");
			}
			// Pass the new user's auth for verification — after disabling admin,
			// admin creds may stop working for REST queries.
			const verifyAuth = effectiveUser
				? `Basic ${btoa(`${effectiveUser.name}:${effectiveUser.password}`)}`
				: undefined;
			await disableAdmin(httpPort, verifyAuth);
		}
	}

	return { user: effectiveUser };
}
