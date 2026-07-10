/**
 * Post-boot provisioning — user creation, admin disable via REST API,
 * with a console transport fallback when REST is unavailable.
 * cspell:ignore NUL
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { QuickCHRError, type ManagedSshKey } from "./types.ts";
import { saveInstanceCredentials } from "./credentials.ts";
import { generatePassword } from "./password.ts";
import { waitForBoot } from "./qemu.ts";
import { consoleExec } from "./console.ts";
import { createLogger, type ProgressLogger } from "./log.ts";
import { restGet, restPost, restPatch } from "./rest.ts";

/** The default user name created by quickchr for managed CHR access. */
export const QUICKCHR_USER = "quickchr";

export interface ProvisionResult {
	/** The user that was created (or null if none). */
	user: { name: string; password: string } | null;
	/** The managed SSH key installed for that user, if provisioning installed one
	 *  (issue #74). Absent when no key was installed. */
	managedSshKey?: ManagedSshKey;
}

async function readUser(httpPort: number, auth: string, name: string): Promise<Record<string, unknown> | undefined> {
	// Fetch the full user list and filter client-side.  RouterOS REST filter
	// query syntax differs across versions and is unreliable for name-based
	// lookups; fetching all users is safe given the small number of entries.
	const { status, body } = await restGet(
		`http://127.0.0.1:${httpPort}/rest/user`,
		auth,
		5000,
	);

	if (status < 200 || status >= 300) {
		throw new QuickCHRError(
			"PROCESS_FAILED",
			`Failed to read user list: HTTP ${status} — ${body}`,
		);
	}

	let users: Record<string, unknown>[];
	try { users = JSON.parse(body) as Record<string, unknown>[]; } catch {
		return undefined;
	}
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
	const { status, body: respBody } = await restPost(
		`http://127.0.0.1:${httpPort}/rest/user/add`,
		auth,
		{ name, password, group },
		10_000,
	);

	if (status < 200 || status >= 300) {
		throw new QuickCHRError(
			"PROCESS_FAILED",
			`Failed to create user "${name}": HTTP ${status} — ${respBody}`,
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

	const { status: patchStatus, body: patchRawBody } = await restPatch(
		`http://127.0.0.1:${httpPort}/rest/user/${adminId}`,
		actionAuth,
		{ disabled: "yes" },
		10_000,
	);

	if (patchStatus < 200 || patchStatus >= 300) {
		throw new QuickCHRError(
			"PROCESS_FAILED",
			`Failed to disable admin: HTTP ${patchStatus} — ${patchRawBody}`,
		);
	}

	// Validate the PATCH response body — RouterOS returns the updated user object.
	// If the response confirms disabled=true, we know the change was applied.
	// If the response body is unexpected (boot race), fall through to verification loop.
	let patchConfirmed = false;
	try {
		const patchBody = JSON.parse(patchRawBody) as Record<string, unknown>;
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
			const { status: probeStatus } = await restGet(
				`http://127.0.0.1:${httpPort}/rest/system/resource`,
				adminAuth,
				3000,
			);
			if (probeStatus === 401) return;
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
	portBase?: number,
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
			portBase,
		);
		saveInstanceCredentials(machineName, effectiveUser.name, effectiveUser.password);
		log.debug(`User "${effectiveUser.name}" created via console`);
	}

	if (shouldDisableAdmin) {
		log.status("  Disabling admin via serial console...");
		// Use newly-created user to disable admin — RouterOS silently ignores
		// disabling your own account while the current session is authenticated as that user.
		const disableUser = effectiveUser?.name ?? "admin";
		const disablePass = effectiveUser?.password ?? "";
		await consoleExec(machineDir, "/user set [find name=admin] disabled=yes", disableUser, disablePass, 30_000, portBase);
		log.debug("Admin disabled via console");
	}

	return { user: effectiveUser };
}

/**
 * Console markers that mean RouterOS rejected a `/user/ssh-keys/add`. RouterOS
 * reports rejection inline (no status code) — these are the parser/command error
 * prefixes it emits. Kept deliberately specific (not bare "expected"/"invalid",
 * which appear in benign output) so it doesn't false-positive. Exported so the
 * ssh-keys lab runner classifies rejections identically instead of duplicating it.
 */
export const SSH_KEY_REJECTION_PATTERN = /failure:|syntax error|no such item|bad command name|expected end of/i;

/** Managed-key algorithm quickchr generates. Grounded as accepted across the
 *  provisioning floor (7.20.8) and current stable in REPORT.md — issue #74. */
const MANAGED_SSH_KEY_ALGORITHM = "ed25519";
export const SSH_NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

export type SshKeyListRow = {
	user?: string;
	info?: string;
	"key-owner"?: string;
	"key-type"?: string;
	fingerprint?: string;
};

function sshKeyOwner(row: SshKeyListRow): string {
	return row.info ?? row["key-owner"] ?? "";
}

export function opensshSha256Fingerprint(publicKey: string): string | undefined {
	const keyBlob = publicKey.trim().split(/\s+/)[1];
	if (!keyBlob) return undefined;
	try {
		const digest = createHash("sha256").update(Buffer.from(keyBlob, "base64")).digest("base64").replace(/=+$/, "");
		return `SHA256:${digest}`;
	} catch {
		return undefined;
	}
}

function normalizeSshFingerprint(fingerprint: string): string {
	return fingerprint.replace(/=+$/, "");
}

export function matchesManagedSshKey(row: SshKeyListRow, username: string, keyComment: string, fingerprint?: string): boolean {
	if (row.user !== username) return false;
	if (sshKeyOwner(row) !== keyComment) return false;
	if (row["key-type"] && row["key-type"] !== MANAGED_SSH_KEY_ALGORITHM) return false;
	if (fingerprint && row.fingerprint && normalizeSshFingerprint(row.fingerprint) !== normalizeSshFingerprint(fingerprint)) return false;
	return true;
}

const SSH_KEY_LIST_BUDGET_MS = 30_000;

export interface SshKeyListingVerification {
	listed: boolean;
	attempts: number;
	elapsedMs: number;
	lastDiagnostic: string;
}

/** Wait for RouterOS to expose the generated key through `/user/ssh-keys`.
 *  A request receives the full remaining convergence budget because the first
 *  read of this endpoint can itself take many seconds under TCG. */
export async function waitForManagedSshKeyListing(
	httpPort: number,
	auth: string,
	username: string,
	keyComment: string,
	fingerprint: string,
	timeoutMs = SSH_KEY_LIST_BUDGET_MS,
): Promise<SshKeyListingVerification> {
	const startedAt = Date.now();
	const deadline = startedAt + timeoutMs;
	let attempts = 0;
	let lastDiagnostic = "no REST attempt completed";

	while (Date.now() < deadline) {
		attempts++;
		const remainingMs = Math.max(1, deadline - Date.now());
		try {
			const { status, body } = await restGet(
				`http://127.0.0.1:${httpPort}/rest/user/ssh-keys`,
				auth,
				remainingMs,
			);
			if (status >= 200 && status < 300) {
				let keys: SshKeyListRow[] | undefined;
				try {
					keys = JSON.parse(body) as SshKeyListRow[];
				} catch (parseErr) {
					lastDiagnostic = `HTTP ${status}: non-JSON body (${String(parseErr)}): ${body}`;
				}
				if (Array.isArray(keys)) {
					if (keys.some((key) => matchesManagedSshKey(key, username, keyComment, fingerprint))) {
						return { listed: true, attempts, elapsedMs: Date.now() - startedAt, lastDiagnostic: body };
					}
					lastDiagnostic = `HTTP ${status}: no matching key in ${keys.length} row(s)`;
				} else if (keys !== undefined) {
					lastDiagnostic = `HTTP ${status}: expected an array, received ${body}`;
				}
			} else {
				lastDiagnostic = `HTTP ${status}: ${body}`;
			}
		} catch (e) {
			lastDiagnostic = String(e);
		}

		const sleepMs = Math.min(500, Math.max(0, deadline - Date.now()));
		if (sleepMs > 0) await Bun.sleep(sleepMs);
	}

	return { listed: false, attempts, elapsedMs: Date.now() - startedAt, lastDiagnostic };
}

/** Attempt a real host-OpenSSH batch login with the managed private key — the
 *  exact mode (`BatchMode=yes`, `PasswordAuthentication=no`, `IdentitiesOnly=yes`,
 *  ignoring ssh_config) that centrs and the #71 descriptor need. Returns true only
 *  on a clean passwordless login. Best-effort: never throws, and is killed after
 *  15s rather than hanging provisioning. */
async function verifyBatchLogin(sshPort: number, username: string, privateKeyPath: string): Promise<boolean> {
	// No SSH port forwarded (or not passed in) → can't prove batch auth from the host.
	if (!sshPort || sshPort <= 0) return false;
	try {
		const proc = Bun.spawn(
			[
				"ssh",
				"-F", SSH_NULL_DEVICE,
				"-o", "StrictHostKeyChecking=no",
				"-o", `UserKnownHostsFile=${SSH_NULL_DEVICE}`,
				"-o", "PasswordAuthentication=no",
				"-o", "IdentitiesOnly=yes",
				"-o", "BatchMode=yes",
				"-o", "ConnectTimeout=10",
				"-i", privateKeyPath,
				`${username}@127.0.0.1`, "-p", String(sshPort),
				':put "quickchr-ssh-batch-ok"',
			],
			{ stdout: "pipe", stderr: "pipe", stdin: "ignore" },
		);
		const timer = setTimeout(() => { try { proc.kill(); } catch { /* already gone */ } }, 15_000);
		try {
			const [out, err] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			await proc.exited;
			return (out + err).includes("quickchr-ssh-batch-ok");
		} finally {
			clearTimeout(timer);
		}
	} catch {
		return false;
	}
}

/**
 * Generate an ed25519 SSH keypair and install the public key on the CHR for `username`,
 * then verify it works for a host-OpenSSH batch login.
 * Keys are stored in `<machineDir>/ssh/id_ed25519` (private) and `.pub` (public).
 * This enables SSH transport without passwords for the quickchr managed user.
 *
 * Returns the {@link ManagedSshKey} fact (key path, algorithm, and whether a real
 * `BatchMode=yes` login succeeded) so callers can persist it for the #71 descriptor.
 */
export async function installSshKey(
	httpPort: number,
	sshPort: number,
	username: string,
	machineName: string,
	machineDir: string,
	portBase?: number,
	logger?: ProgressLogger,
): Promise<ManagedSshKey> {
	const sshDir = join(machineDir, "ssh");
	mkdirSync(sshDir, { recursive: true });

	const privateKeyPath = join(sshDir, "id_ed25519");
	const keyComment = `quickchr@${machineName}`;

	const keygen = Bun.spawnSync(
		["ssh-keygen", "-t", MANAGED_SSH_KEY_ALGORITHM, "-f", privateKeyPath, "-N", "", "-C", keyComment],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (keygen.exitCode !== 0) {
		throw new QuickCHRError("SPAWN_FAILED", `ssh-keygen failed: ${new TextDecoder().decode(keygen.stderr)}`);
	}

	const pubKey = (await Bun.file(`${privateKeyPath}.pub`).text()).trim();
	const expectedFingerprint = opensshSha256Fingerprint(pubKey);
	if (!expectedFingerprint) {
		throw new QuickCHRError("PROCESS_FAILED", "Could not compute fingerprint for quickchr-generated SSH public key");
	}

	// Install via serial console — commits synchronously unlike the REST endpoint
	// which may return 200 OK before the key is durable in RouterOS storage.
	const { output: addOutput } = await consoleExec(
		machineDir,
		`/user/ssh-keys/add user="${username}" key="${pubKey}"`,
		"admin",
		"",
		30_000,
		portBase,
	);

	// RouterOS reports key rejection (e.g. an unsupported algorithm on the running
	// version, or a malformed key) inline on the console rather than by any status
	// code. Surface it immediately so the failure is diagnosable, instead of letting
	// it masquerade as the generic "did not appear in REST listing" timeout below.
	if (SSH_KEY_REJECTION_PATTERN.test(addOutput)) {
		throw new QuickCHRError("EXEC_FAILED", `RouterOS rejected the SSH key for ${username}: ${addOutput.trim()}`);
	}

	// Verify the generated key appears in the REST listing. Match the public-key
	// comment (`key-owner` on older 7.x, `info` on newer 7.x) rather than just the
	// user, so an older key for the same user cannot satisfy this check.
	const listResult = await waitForManagedSshKeyListing(
		httpPort,
		`Basic ${btoa("admin:")}`,
		username,
		keyComment,
		expectedFingerprint,
	);
	if (!listResult.listed) {
		throw new QuickCHRError(
			"PROCESS_FAILED",
			`SSH key for ${username} installed via console but did not appear in REST listing within 30s ` +
				`after ${listResult.attempts} attempt(s) and ${listResult.elapsedMs}ms ` +
				`(console output: ${addOutput.trim() || "<empty>"}; last REST attempt: ${listResult.lastDiagnostic})`,
		);
	}
	if (listResult.attempts > 1 || listResult.elapsedMs > 5_000) {
		logger?.status(`  SSH key listing verified after ${listResult.attempts} attempt(s) in ${listResult.elapsedMs}ms`);
	}

	// Presence in the listing is necessary but not sufficient — prove the key
	// actually authenticates a host-OpenSSH batch client. Non-fatal: an unverified
	// key is still installed, we just record batchVerified=false so the #71
	// descriptor won't advertise batch key auth it can't stand behind.
	const batchVerified = await verifyBatchLogin(sshPort, username, privateKeyPath);
	return {
		privateKeyPath,
		algorithm: MANAGED_SSH_KEY_ALGORITHM,
		batchVerified,
		verifiedAt: batchVerified ? new Date().toISOString() : undefined,
	};
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
	portBase?: number,
	sshPort?: number,
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
		saveInstanceCredentials(machineName, "admin", "");
		return { user: null };
	}

	// Try REST provisioning. When machineDir is provided, use a shorter timeout
	// so the console fallback can engage sooner if REST isn't available.
	const restTimeout = machineDir ? 30_000 : 60_000;
	try {
		await waitForRest(httpPort, restTimeout);
	} catch (e) {
		if (machineDir) {
			log.warn("REST API unavailable — falling back to serial console provisioning");
			const result = await consoleProvision(machineDir, machineName, effectiveUser, !!shouldDisableAdmin, logger, portBase);
			// After console provisioning the machine is booted; REST comes up shortly.
			// Attempt SSH key install for the managed quickchr user — non-fatal if REST is still unavailable.
			if (secureLogin && !user && effectiveUser) {
				try {
					await waitForRest(httpPort, 30_000);
					result.managedSshKey = await installSshKey(httpPort, sshPort ?? 0, effectiveUser.name, machineName, machineDir, portBase, log);
				} catch (keyErr) {
					log.warn(`SSH key install failed after console provisioning (SSH transport will fall back to password): ${keyErr}`);
				}
			}
			return result;
		}
		throw e;
	}

	// REST provisioning path. The console fallback above always returns early,
	// so reaching here means REST came up and we provision over it.
	if (effectiveUser) {
		await createUser(httpPort, effectiveUser.name, effectiveUser.password);
		// Persist to secret store so resolveAuth() picks it up
		saveInstanceCredentials(machineName, effectiveUser.name, effectiveUser.password);
	}

	let managedSshKey: ManagedSshKey | undefined;
	if (secureLogin && !user && effectiveUser && machineDir) {
		// Brief pause so RouterOS propagates the new user to all subsystems
		// (including the SSH key store) before we attempt key installation.
		await Bun.sleep(1000);
		try {
			managedSshKey = await installSshKey(httpPort, sshPort ?? 0, effectiveUser.name, machineName, machineDir, portBase, log);
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

	return { user: effectiveUser, managedSshKey };
}
