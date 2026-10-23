/**
 * Publish-by-rename that survives Windows' transient sharing violations.
 */

import { renameSync } from "node:fs";

/** Codes Windows returns while another process (Defender, the Search indexer) still
 *  holds a handle on a file it is scanning — typically one we just wrote. */
const TRANSIENT_WINDOWS_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800];

/**
 * `renameSync`, retried on Windows while the failure looks like a sharing violation
 * (#202). Every quickchr publish writes a temp file or directory and renames it into
 * place, which is exactly when a scanner has the fresh file open. libuv does not retry
 * this case. The budget is bounded (about 1.6 s); after it, the last error is thrown
 * unchanged. Elsewhere this is a plain `renameSync`.
 */
export function renameWithRetry(
	from: string,
	to: string,
	opts: { platform?: NodeJS.Platform; rename?: (from: string, to: string) => void; sleep?: (ms: number) => void } = {},
): void {
	const rename = opts.rename ?? renameSync;
	if ((opts.platform ?? process.platform) !== "win32") {
		rename(from, to);
		return;
	}
	const sleep = opts.sleep ?? Bun.sleepSync;
	for (const delay of RETRY_DELAYS_MS) {
		try {
			rename(from, to);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (!code || !TRANSIENT_WINDOWS_CODES.has(code)) throw error;
			sleep(delay);
		}
	}
	rename(from, to);
}
