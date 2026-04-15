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
import { createLogger, type ProgressLogger } from "./log.ts";

/** Default timeout for waiting for a license change to propagate (ms). */
const LICENSE_VERIFY_TIMEOUT = 90_000;

/** Max attempts for the renew POST itself (retried on post-boot REST quirk). */
const MAX_RENEW_ATTEMPTS = 3;

/** Classify the response body from POST /rest/system/license/renew.
 *
 *  RouterOS returns different shapes depending on timing:
 *  - Array of {".section", status} objects: the duration= streaming output.
 *    Last entry with status="done" means the license server responded.
 *  - Object with "board-name"/"architecture-name": system resource data —
 *    a post-boot REST quirk where the endpoint isn't fully initialized yet.
 *    The renewal was NOT actually initiated; the POST must be retried.
 */
function classifyRenewResponse(text: string): "done" | "pending" | "not-ready" {
	try {
		const data = JSON.parse(text);

		if (Array.isArray(data)) {
			const last = data[data.length - 1];
			if (last && typeof last === "object" && last.status === "done") return "done";
			return "pending";
		}

		if (data && typeof data === "object") {
			// System resource data has board-name — not a license response.
			if ("board-name" in data || "architecture-name" in data) return "not-ready";
		}
	} catch { /* unparseable — treat as pending */ }

	return "pending";
}

/** Apply or renew a CHR trial license via /system/license/renew.
 *  @param httpPort   REST API port (e.g. 9180)
 *  @param opts       MikroTik account credentials + desired level
 *  @param chrUser    RouterOS admin username (default "admin")
 *  @param chrPass    RouterOS admin password (default "" for fresh CHR)
 *  @param logger     Optional progress logger
 *  @param authHeader Pre-built Authorization header (overrides chrUser/chrPass when provided)
 */
export async function renewLicense(
	httpPort: number,
	opts: LicenseOptions,
	chrUser = "admin",
	chrPass = "",
	logger?: ProgressLogger,
	authHeader?: string,
): Promise<void> {
	const log = logger ?? createLogger();
	const auth = authHeader ?? `Basic ${btoa(`${chrUser}:${chrPass}`)}`;
	const body: Record<string, string> = {};
	if (opts.account) body.account = opts.account;
	if (opts.password) body.password = opts.password;
	if (opts.level) body.level = opts.level;
	// duration=10s: ask RouterOS to wait up to 10s for the MikroTik license server
	// before responding. Without this, RouterOS does one short internal poll (~1-2s)
	// and returns before the activation has propagated, forcing a long polling loop.
	body.duration = "10s";

	// Wait for the license subsystem to be ready — right after boot, RouterOS may
	// return system resource data for all REST endpoints (see waitForBoot stage 4).
	await waitForLicenseApi(httpPort, chrUser, chrPass, 30_000, auth);

	for (let attempt = 1; attempt <= MAX_RENEW_ATTEMPTS; attempt++) {
		let response: Response;
		try {
			response = await fetch(`http://127.0.0.1:${httpPort}/rest/system/license/renew`, {
				method: "POST",
				headers: {
					Authorization: auth,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(30_000), // 10s for RouterOS wait + 20s net overhead
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

		const text = await response.text();
		log.debug(`License renew response body: ${text}`);
		const result = classifyRenewResponse(text);

		if (result === "not-ready") {
			if (attempt < MAX_RENEW_ATTEMPTS) {
				log.warn(`License renew attempt ${attempt}: got system resource data instead of renew status — retrying`);
				await Bun.sleep(5000);
				continue;
			}
			throw new QuickCHRError(
				"PROCESS_FAILED",
				"License renew endpoint returned system resource data after multiple attempts — REST API not fully initialized",
			);
		}

		if (!opts.level) return; // fire-and-forget, no level verification needed

		// result is "done" or "pending" — poll until the level matches.
		// "done" means the license server responded within the duration window;
		// a single verification poll should suffice but we use the same loop.
		const deadline = Date.now() + LICENSE_VERIFY_TIMEOUT;
		let pollCount = 0;
		while (Date.now() < deadline) {
			try {
				const info = await getLicenseInfo(httpPort, chrUser, chrPass, auth);
				pollCount++;
				log.debug(`License poll #${pollCount}: level=${info.level}, want=${opts.level}`);
				if (info.level === opts.level) return;
			} catch (e) {
				pollCount++;
				log.warn(`License poll #${pollCount} error: ${e instanceof Error ? e.message : String(e)}`);
			}
			await Bun.sleep(2000);
		}
		throw new QuickCHRError(
			"PROCESS_FAILED",
			`License renewal accepted but level did not change to "${opts.level}" within ${LICENSE_VERIFY_TIMEOUT / 1000}s`,
		);
	}
}

/** Wait until GET /rest/system/license returns actual license data.
 *  Right after boot, RouterOS may return system resource data for all endpoints.
 *  Real license data contains "system-id"; system resource data has "board-name". */
async function waitForLicenseApi(
	httpPort: number,
	chrUser: string,
	chrPass: string,
	timeoutMs = 30_000,
	authHeader?: string,
): Promise<void> {
	const auth = authHeader ?? `Basic ${btoa(`${chrUser}:${chrPass}`)}`;
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		try {
			const r = await fetch(`http://127.0.0.1:${httpPort}/rest/system/license`, {
				headers: { Authorization: auth },
				signal: AbortSignal.timeout(5000),
			});
			if (r.ok) {
				const data = await r.json() as Record<string, unknown>;
				if ("system-id" in data && !("board-name" in data)) return;
			}
		} catch { /* not ready */ }
		await Bun.sleep(2000);
	}
	// Don't throw — the renew POST itself will detect and retry on bad responses.
	console.warn("License API readiness check timed out — proceeding with renewal attempt");
}

/** Fetch the current license state from a running CHR.
 *  Uses GET /rest/system/license (standard REST read for a single-object menu).
 *  Normalises the response: RouterOS omits `level` for the implicit "free" tier,
 *  so we fill it in when absent.
 *  @param authHeader Pre-built Authorization header (overrides chrUser/chrPass when provided)
 */
export async function getLicenseInfo(
	httpPort: number,
	chrUser = "admin",
	chrPass = "",
	authHeader?: string,
): Promise<LicenseInfo> {
	const auth = authHeader ?? `Basic ${btoa(`${chrUser}:${chrPass}`)}`;

	// RouterOS briefly serves /system/resource data from /system/license immediately
	// after boot (REST routing startup race). Retry for up to 15s to let it settle.
	const deadline = Date.now() + 15_000;
	let lastError: unknown;

	while (Date.now() < deadline) {
		let response: Response;
		try {
			response = await fetch(`http://127.0.0.1:${httpPort}/rest/system/license`, {
				method: "GET",
				headers: { Authorization: auth },
				signal: AbortSignal.timeout(10_000),
			});
		} catch (e) {
			lastError = e;
			await Bun.sleep(1000);
			continue;
		}

		if (!response.ok) {
			const text = await response.text();
			throw new QuickCHRError(
				"PROCESS_FAILED",
				`Failed to get license info: HTTP ${response.status} — ${text}`,
			);
		}

		const info = await response.json() as LicenseInfo;
		// Post-boot REST quirk: /system/license may return /system/resource data briefly.
		// Retry until the endpoint stabilises rather than failing to the caller.
		if ("board-name" in info || "architecture-name" in info) {
			await Bun.sleep(1000);
			continue;
		}
		// RouterOS REST omits default / empty fields. A CHR with no registered license
		// is implicitly "free" — normalise to the explicit string so callers can always
		// read info.level without special-casing undefined.
		if (!info.level) info.level = "free";
		return info;
	}

	const msg = lastError instanceof Error ? lastError.message : String(lastError ?? "timed out");
	throw new QuickCHRError(
		"PROCESS_FAILED",
		`License info request failed after retries: ${msg}`,
	);
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
