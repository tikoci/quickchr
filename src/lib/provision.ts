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
export async function disableAdmin(httpPort: number): Promise<void> {
	await waitForRest(httpPort);

	const auth = `Basic ${btoa("admin:")}`;

	// Use /user/set to set disabled=yes on admin.
	// POST /rest/user/set maps to CLI `/user set disabled=yes numbers=admin`.
	// The disable/enable sub-commands use a `numbers` selector; so does set.
	const setResp = await fetch(`http://127.0.0.1:${httpPort}/rest/user/set`, {
		method: "POST",
		headers: {
			Authorization: auth,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ numbers: "admin", disabled: "yes" }),
	});

	if (!setResp.ok) {
		const body = await setResp.text();
		throw new QuickCHRError(
			"PROCESS_FAILED",
			`Failed to disable admin: HTTP ${setResp.status} — ${body}`,
		);
	}
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
		await disableAdmin(httpPort);
	}
}
