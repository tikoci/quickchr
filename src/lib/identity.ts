/**
 * `/system/identity` provisioning step (#265).
 *
 * When quickchr provisions a machine, it also sets the RouterOS identity to the
 * machine name, so machines are told apart in WinBox, MNDP neighbor lists, the
 * console prompt and `/app` container hostnames. The identity is a passenger: it
 * runs only when `_provisionInstance()` runs for other steps, never triggers
 * provisioning by itself, and `StartOptions.identity: false` (`--no-identity`)
 * skips it. `set` never renames.
 *
 * RouterOS takes up to 64 bytes and stores `.`, `_`, spaces, `;` and non-ASCII
 * as given; 65 bytes or more is refused with `failure: could not change identity:
 * too long` (CHR 7.25.2). quickchr's own names are ASCII and at most 64
 * characters, so every name created today fits.
 */

import { FACTORY_AUTH_HEADER } from "./device-mode.ts";
import { restGet, restPost, type RestResponse } from "./rest.ts";
import { QuickCHRError } from "./types.ts";

export interface IdentityIo {
	post: (url: string, auth: string, body: Record<string, unknown>) => Promise<RestResponse>;
	get: (url: string, auth: string) => Promise<RestResponse>;
	sleep: (ms: number) => Promise<void>;
}

const defaultIo: IdentityIo = {
	post: (url, auth, body) => restPost(url, auth, body),
	get: (url, auth) => restGet(url, auth),
	sleep: (ms) => Bun.sleep(ms),
};

/**
 * Set `/system/identity` to `name` and wait until it reads back.
 *
 * `/system/identity` is one of the endpoints hit by the post-boot REST race
 * (provisioning.instructions.md), so a GET can briefly answer with another
 * menu's data. The read-back is polled until `name` matches. A RouterOS
 * `failure:` (HTTP 4xx) is final and throws; connection errors and 5xx retry
 * until `budgetMs`.
 */
export async function applyIdentity(
	httpPort: number,
	name: string,
	auth: string = FACTORY_AUTH_HEADER,
	budgetMs = 30_000,
	io: IdentityIo = defaultIo,
): Promise<void> {
	const base = `http://127.0.0.1:${httpPort}/rest/system/identity`;
	const deadline = Date.now() + budgetMs;
	let last = "no response";
	let written = false;
	do {
		try {
			if (!written) {
				const set = await io.post(`${base}/set`, auth, { name });
				if (set.status >= 400 && set.status < 500) {
					throw new QuickCHRError(
						"PROCESS_FAILED",
						`Setting the RouterOS identity to "${name}" failed: HTTP ${set.status} ${set.body}`,
					);
				}
				if (set.status < 200 || set.status >= 300) {
					last = `set: HTTP ${set.status} ${set.body}`;
					await io.sleep(1000);
					continue;
				}
				written = true;
			}
			const got = await io.get(base, auth);
			if (got.status >= 200 && got.status < 300) {
				const parsed = JSON.parse(got.body) as { name?: unknown };
				if (parsed.name === name) return;
				last = `read back ${JSON.stringify(got.body).slice(0, 120)}`;
			} else {
				last = `read back: HTTP ${got.status}`;
			}
		} catch (e) {
			if (e instanceof QuickCHRError) throw e;
			last = e instanceof Error ? e.message : String(e);
		}
		await io.sleep(1000);
	} while (Date.now() < deadline);
	throw new QuickCHRError(
		"PROCESS_FAILED",
		`The RouterOS identity did not read back as "${name}" within ${Math.round(budgetMs / 1000)} s (last: ${last}).`,
	);
}
