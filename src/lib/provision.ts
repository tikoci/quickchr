/**
 * Post-boot provisioning — user creation, admin disable via REST API.
 */

import { QuickCHRError } from "./types.ts";
import { saveInstanceCredentials } from "./credentials.ts";
import { generatePassword } from "./password.ts";

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

/** Wait for the REST API to become responsive.
 *
 * On a fresh CHR image with an expired admin (forced-password-change-on-first-login),
 * the REST API has a startup quirk where early GET /rest/system/resource requests
 * return the /user list instead of the resource object — a 200 response but with
 * the wrong payload. Poll until the response shape is the expected singleton object
 * (has `board-name`) so callers downstream can trust it. */
async function waitForRest(
	httpPort: number,
	timeoutMs: number = 60000,
): Promise<void> {
	const start = Date.now();
	const auth = `Basic ${btoa("admin:")}`;

	while (Date.now() - start < timeoutMs) {
		try {
			const response = await fetch(`http://127.0.0.1:${httpPort}/rest/system/resource`, {
				headers: { Authorization: auth },
				signal: AbortSignal.timeout(3000),
			});
			if (response.ok) {
				const body = await response.json().catch(() => null) as unknown;
				// Expect a singleton object shaped like { "board-name": ..., "architecture-name": ..., ... }.
				// Arrays (user list) or missing board-name mean the REST layer is still in
				// its first-call bootstrap state — keep polling.
				if (body && typeof body === "object" && !Array.isArray(body) && "board-name" in body) {
					return;
				}
			}
		} catch {
			// Not ready yet
		}
		await Bun.sleep(1000);
	}

	throw new QuickCHRError("BOOT_TIMEOUT", "REST API did not become available");
}

/** Clear admin's expired-password flag by re-setting its password as admin itself.
 *
 * A fresh CHR image ships with admin marked `expired: true` (forced
 * password change on first login). While expired, RouterOS REST will
 * sometimes return the `/user` list as the body of unrelated GETs (notably
 * `/system/resource`) — a startup quirk that breaks clients that trust the
 * response shape. Running `/user/set admin password=""` via `/rest/execute`
 * clears the expired flag without changing the effective password, ending
 * the quirky period. */
async function clearAdminExpiry(httpPort: number): Promise<void> {
	const auth = `Basic ${btoa("admin:")}`;
	try {
		await fetch(`http://127.0.0.1:${httpPort}/rest/execute`, {
			method: "POST",
			headers: { Authorization: auth, "Content-Type": "application/json" },
			body: JSON.stringify({ script: "/user/set admin password=\"\"", "as-string": "" }),
			signal: AbortSignal.timeout(10_000),
		});
	} catch { /* best-effort — provisioning still works without this */ }
}

/** Create a user via the REST API. */
export async function createUser(
	httpPort: number,
	name: string,
	password: string,
	group: string = "full",
): Promise<void> {
	await waitForRest(httpPort);
	await clearAdminExpiry(httpPort);

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
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
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

	// Use the RouterOS action endpoint /rest/user/disable — equivalent to the CLI
	// `/user disable admin` command. PATCH /rest/user/<name-or-id> is unreliable:
	// RouterOS user records are keyed by .id (e.g. *1), and encodeURIComponent
	// turns that into %2A1 which RouterOS may silently treat as a phantom resource.
	// The action endpoint accepts `numbers: "admin"` (the CLI-style name reference)
	// and is the same path the Winbox/CLI use.
	const disableResp = await fetch(`http://127.0.0.1:${httpPort}/rest/user/disable`, {
		method: "POST",
		headers: {
			Authorization: adminAuth,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ numbers: "admin" }),
		signal: AbortSignal.timeout(10_000),
	});

	if (!disableResp.ok) {
		const body = await disableResp.text();
		throw new QuickCHRError(
			"PROCESS_FAILED",
			`Failed to disable admin: HTTP ${disableResp.status} — ${body}`,
		);
	}

	// Verify the change took effect.
	// RouterOS REST uses "yes"/"no" strings for booleans (not JSON true/false).
	// Use alternate credentials if provided — after disabling admin, admin creds
	// may stop authenticating on subsequent requests.
	const readAuth = verifyAuth ?? adminAuth;
	const deadline = Date.now() + 45_000;
	while (Date.now() < deadline) {
		// Primary: read admin user via alternate creds and check the disabled field.
		// RouterOS omits disabled:"no" for enabled users; "yes" when actually disabled.
		try {
			const user = await readUser(httpPort, readAuth, "admin");
			const d = String(user?.disabled ?? "");
			if (d === "yes" || d === "true") return;
		} catch {
			// Transient error (new user creds propagating, network blip) — fall through
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
		"Admin disable timed out after 45s — admin user is still enabled",
	);
}

/** Run all provisioning steps based on the config.
 *
 * When `user` is provided, creates that exact user. When `user` is omitted
 * but `secureLogin` is true (or unset — it defaults to true), a `quickchr`
 * managed account is created automatically with a generated password.
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
): Promise<ProvisionResult> {
	// Determine what user to create.
	// Priority: explicit user > auto-create quickchr account (secureLogin defaults true)
	let effectiveUser = user ?? null;
	if (!effectiveUser && secureLogin !== false) {
		effectiveUser = { name: QUICKCHR_USER, password: generatePassword() };
	}

	if (!effectiveUser && !shouldDisableAdmin) {
		// No user, no disable — save admin:"" as instance creds for symmetry
		await saveInstanceCredentials(machineName, "admin", "");
		return { user: null };
	}

	await waitForRest(httpPort);

	if (effectiveUser) {
		await createUser(httpPort, effectiveUser.name, effectiveUser.password);
		// Persist to secret store so resolveAuth() picks it up
		await saveInstanceCredentials(machineName, effectiveUser.name, effectiveUser.password);
	}

	if (shouldDisableAdmin) {
		if (!effectiveUser) {
			console.warn("Warning: disabling admin without creating another user — you may lose access");
		}
		// Pass the new user's auth for verification — after disabling admin,
		// admin creds may stop working for REST queries.
		const verifyAuth = effectiveUser
			? `Basic ${btoa(`${effectiveUser.name}:${effectiveUser.password}`)}`
			: undefined;
		await disableAdmin(httpPort, verifyAuth);
	}

	return { user: effectiveUser };
}
