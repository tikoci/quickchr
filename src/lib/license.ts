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

/** Default timeout for waiting for a license change to propagate (ms). */
const LICENSE_VERIFY_TIMEOUT = 30_000;

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
	const body: Record<string, string> = {};
	if (opts.account) body.account = opts.account;
	if (opts.password) body.password = opts.password;
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

	// Verify the license change took effect by polling /system/license.
	// MikroTik license activation involves a server round-trip and is not
	// instantaneous — reading back immediately after a 200 response often
	// still returns "free".
	if (opts.level) {
		const deadline = Date.now() + LICENSE_VERIFY_TIMEOUT;
		while (Date.now() < deadline) {
			try {
				const info = await getLicenseInfo(httpPort, chrUser, chrPass);
				if (info.level === opts.level) return;
			} catch { /* transient read failure — keep polling */ }
			await Bun.sleep(1000);
		}
		throw new QuickCHRError(
			"PROCESS_FAILED",
			`License renewal accepted but level did not change to "${opts.level}" within ${LICENSE_VERIFY_TIMEOUT / 1000}s`,
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
