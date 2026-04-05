/**
 * Post-boot provisioning — user creation, admin disable via REST API.
 */

import { QuickCHRError } from "./types.ts";

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
		body: JSON.stringify({ name, password, group }),
	});

	if (!response.ok) {
		const body = await response.text();
		throw new QuickCHRError(
			"PROCESS_FAILED",
			`Failed to create user "${name}": HTTP ${response.status} — ${body}`,
		);
	}
}

/** Disable the admin user via the REST API. */
export async function disableAdmin(httpPort: number): Promise<void> {
	await waitForRest(httpPort);

	const auth = `Basic ${btoa("admin:")}`;
	// First find admin's .id
	const listResp = await fetch(`http://127.0.0.1:${httpPort}/rest/user?name=admin`, {
		headers: { Authorization: auth },
	});

	if (!listResp.ok) {
		throw new QuickCHRError(
			"PROCESS_FAILED",
			`Failed to find admin user: HTTP ${listResp.status}`,
		);
	}

	const users = (await listResp.json()) as { ".id": string }[];
	if (users.length === 0) return;

	const adminId = users[0][".id"];
	const patchResp = await fetch(`http://127.0.0.1:${httpPort}/rest/user/${adminId}`, {
		method: "PATCH",
		headers: {
			Authorization: auth,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ disabled: "yes" }),
	});

	if (!patchResp.ok) {
		const body = await patchResp.text();
		throw new QuickCHRError(
			"PROCESS_FAILED",
			`Failed to disable admin: HTTP ${patchResp.status} — ${body}`,
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
