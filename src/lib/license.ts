/**
 * CHR license management — renew/get via /system/license REST endpoint.
 *
 * Free CHR runs at 1 Mbps. A trial license from MikroTik unlocks full speed:
 *   p1  → 1 Gbps
 *   p10 → 10 Gbps
 *   unlimited → no cap
 *
 * License is applied by POST /rest/system/license/renew with MikroTik.com
 * account credentials. No reboot required — takes effect immediately.
 */

import type { LicenseLevel, LicenseOptions } from "./types.ts";
import { QuickCHRError } from "./types.ts";

/** Apply or renew a CHR trial license via /system/license/renew.
 *  @param httpPort  REST API port (e.g. 9180)
 *  @param opts      MikroTik account credentials + desired level
 *  @param chrUser   RouterOS admin username (default "admin")
 *  @param chrPass   RouterOS admin password (default "" for fresh CHR)
 */
export async function renewLicense(
	httpPort: number,
	opts: LicenseOptions,
	chrUser = "admin",
	chrPass = "",
): Promise<void> {
	const auth = `Basic ${btoa(`${chrUser}:${chrPass}`)}`;
	const body: Record<string, string> = {
		account: opts.account,
		password: opts.password,
	};
	if (opts.level) {
		body.level = opts.level;
	}

	let response: Response;
	try {
		response = await fetch(`http://127.0.0.1:${httpPort}/rest/system/license/renew`, {
			method: "POST",
			headers: {
				Authorization: auth,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(30_000),
		});
	} catch (e) {
		throw new QuickCHRError(
			"PROCESS_FAILED",
			`License renewal request failed: ${e instanceof Error ? e.message : String(e)}`,
		);
	}

	if (!response.ok) {
		const text = await response.text();
		throw new QuickCHRError(
			"PROCESS_FAILED",
			`License renewal failed: HTTP ${response.status} — ${text}`,
		);
	}
}

/** Fetch the current license state from a running CHR.
 *  Uses GET /rest/system/license (standard REST read for a single-object menu).
 *  Normalises the response: RouterOS omits `level` for the implicit "free" tier,
 *  so we fill it in when absent.
 */
export async function getLicenseInfo(
	httpPort: number,
	chrUser = "admin",
	chrPass = "",
): Promise<LicenseInfo> {
	const auth = `Basic ${btoa(`${chrUser}:${chrPass}`)}`;

	let response: Response;
	try {
		response = await fetch(`http://127.0.0.1:${httpPort}/rest/system/license`, {
			method: "GET",
			headers: { Authorization: auth },
			signal: AbortSignal.timeout(10_000),
		});
	} catch (e) {
		throw new QuickCHRError(
			"PROCESS_FAILED",
			`License info request failed: ${e instanceof Error ? e.message : String(e)}`,
		);
	}

	if (!response.ok) {
		const text = await response.text();
		throw new QuickCHRError(
			"PROCESS_FAILED",
			`Failed to get license info: HTTP ${response.status} — ${text}`,
		);
	}

	const info = await response.json() as LicenseInfo;
	// RouterOS REST omits default / empty fields. A CHR with no registered license
	// is implicitly "free" — normalise to the explicit string so callers can always
	// read info.level without special-casing undefined.
	if (!info.level) info.level = "free";
	return info;
}

/** Parsed response from /rest/system/license/get */
export interface LicenseInfo {
	/** License level: "free", "p1", "p10", "unlimited", etc. */
	level?: LicenseLevel | "free" | string;
	/** Deadline in ISO-8601 format if on a trial. */
	deadline?: string;
	/** System ID used for activation. */
	"system-id"?: string;
	/** Any other fields RouterOS returns. */
	[key: string]: unknown;
}
