/**
 * Post-boot provisioning — user creation, admin disable via REST API.
 */

import { QuickCHRError } from "./types.ts";

async function readUser(httpPort: number, auth: string, name: string): Promise<Record<string, unknown> | undefined> {
	const response = await fetch(`http://127.0.0.1:${httpPort}/rest/user?name=${encodeURIComponent(name)}`, {
		headers: { Authorization: auth },
		signal: AbortSignal.timeout(5000),
	});

	if (!response.ok) {
		const body = await response.text();
		throw new QuickCHRError(
			"PROCESS_FAILED",
			`Failed to read user "${name}": HTTP ${response.status} — ${body}`,
		);
	}

	const users = await response.json() as Record<string, unknown>[];
	if (!Array.isArray(users) || users.length === 0) return undefined;
	return users.find((u) => String(u.name ?? "") === name) ?? users[0];
}

/** Wait for the REST API to become responsive. */
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
			if (response.ok) return;
		} catch {
			// Not ready yet
		}
		await Bun.sleep(1000);
	}

	throw new QuickCHRError("BOOT_TIMEOUT", "REST API did not become available");
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

	// Resolve the admin user's internal .id so we can PATCH by resource path.
	let adminUser: Record<string, unknown> | undefined;
	const findDeadline = Date.now() + 10_000;
	while (Date.now() < findDeadline) {
		try {
			adminUser = await readUser(httpPort, adminAuth, "admin");
			if (adminUser) break;
		} catch {
			// Transient REST errors — keep trying
		}
		await Bun.sleep(500);
	}
	if (!adminUser) {
		throw new QuickCHRError("PROCESS_FAILED", "Admin user not found after 10s");
	}
	const adminId = String(adminUser[".id"] ?? "");
	if (!adminId) {
		throw new QuickCHRError("PROCESS_FAILED", "Admin user .id not found");
	}

	const setResp = await fetch(`http://127.0.0.1:${httpPort}/rest/user/${encodeURIComponent(adminId)}`, {
		method: "PATCH",
		headers: {
			Authorization: adminAuth,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ disabled: "yes" }),
		signal: AbortSignal.timeout(10_000),
	});

	if (!setResp.ok) {
		const body = await setResp.text();
		throw new QuickCHRError(
			"PROCESS_FAILED",
			`Failed to disable admin: HTTP ${setResp.status} — ${body}`,
		);
	}

	// Verify the disabled flag reads back as "true".
	// Use alternate credentials if provided — after disabling admin, the admin
	// account may stop authenticating on subsequent requests.
	const readAuth = verifyAuth ?? adminAuth;
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		try {
			const user = await readUser(httpPort, readAuth, "admin");
			if (user && String(user.disabled) === "true") return;
		} catch {
			// Transient errors (401 from disabled admin, network blip) — retry
		}
		await Bun.sleep(500);
	}

	throw new QuickCHRError(
		"PROCESS_FAILED",
		"Admin disable request succeeded but admin user is still enabled after 20s",
	);
}

/** Run all provisioning steps based on the config. */
export async function provision(
	httpPort: number,
	user?: { name: string; password: string },
	shouldDisableAdmin?: boolean,
): Promise<void> {
	if (!user && !shouldDisableAdmin) return;

	await waitForRest(httpPort);

	if (user) {
		await createUser(httpPort, user.name, user.password);
	}

	if (shouldDisableAdmin) {
		if (!user) {
			console.warn("Warning: disabling admin without creating another user — you may lose access");
		}
		// Pass the new user's auth for verification — after disabling admin,
		// admin creds may stop working for REST queries.
		const verifyAuth = user
			? `Basic ${btoa(`${user.name}:${user.password}`)}`
			: undefined;
		await disableAdmin(httpPort, verifyAuth);
	}
}
