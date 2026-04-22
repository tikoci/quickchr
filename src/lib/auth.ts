/**
 * Credential resolution for CHR instances.
 *
 * Centralises the logic for choosing which username:password to use when
 * talking to a running RouterOS instance.  Today this is a thin helper;
 * it becomes the extension point for credential profiles, SSH keys, and
 * user-preference overrides.
 */

import type { MachineState } from "./types.ts";
import { getInstanceCredentials } from "./credentials.ts";

export interface ResolvedAuth {
	/** HTTP Basic Authorization header value. */
	header: string;
	/** Username that was resolved (for display / logging). */
	user: string;
}

export interface ResolvedCreds {
	user: string;
	password: string;
}

/**
 * Resolve the best credentials for a machine.
 *
 * Priority:
 *   1. Explicit overrides (`user` + `password` args) — caller knows best.
 *   2. Provisioned user stored in machine.json (`state.user`).
 *   3. Per-instance credentials stored in config file (written during provisioning).
 *   4. CHR default: `admin` with empty password.
 *
 * When `state.disableAdmin` is true and no provisioned user exists the
 * default admin credentials are unlikely to work.  We still return them
 * (the caller will get a 401) rather than throwing — the caller may have
 * re-enabled admin or created a user out-of-band.
 */
export function resolveAuth(
	state: Pick<MachineState, "name" | "user" | "disableAdmin">,
	user?: string,
	password?: string,
): ResolvedAuth {
	if (user !== undefined) {
		return {
			header: `Basic ${btoa(`${user}:${password ?? ""}`)}`,
			user,
		};
	}

	// state.user is the canonical provisioned user written to machine.json.
	// Check this first — no I/O, no keychain, no blocking.
	if (state.user) {
		return {
			header: `Basic ${btoa(`${state.user.name}:${state.user.password}`)}`,
			user: state.user.name,
		};
	}

	// Check per-instance credentials stored in config file (sync, no keychain).
	const stored = getInstanceCredentials(state.name);
	if (stored) {
		return {
			header: `Basic ${btoa(`${stored.user}:${stored.password}`)}`,
			user: stored.user,
		};
	}

	return {
		header: `Basic ${btoa("admin:")}`,
		user: "admin",
	};
}

/**
 * Resolve raw username + password for a machine (same priority as {@link resolveAuth}).
 * Used by transports that need the password in cleartext — SCP, SSH, SFTP.
 */
export function resolveCreds(
	state: Pick<MachineState, "name" | "user" | "disableAdmin">,
	user?: string,
	password?: string,
): ResolvedCreds {
	if (user !== undefined) return { user, password: password ?? "" };
	if (state.user) return { user: state.user.name, password: state.user.password };
	const stored = getInstanceCredentials(state.name);
	if (stored) return { user: stored.user, password: stored.password };
	return { user: "admin", password: "" };
}
