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
 * too long` (CHR 7.25.2). Names quickchr creates now are ASCII and at most 64
 * characters, so they fit; a longer name from an older release fails the step, and
 * `--no-identity` is the way to start that machine.
 */

import { FACTORY_AUTH_HEADER } from "./device-mode.ts";
import { restGet, restPost, type RestResponse } from "./rest.ts";
import { QuickCHRError } from "./types.ts";

export interface IdentityIo {
	post: (url: string, auth: string, body: Record<string, unknown>, timeoutMs: number) => Promise<RestResponse>;
	get: (url: string, auth: string, timeoutMs: number) => Promise<RestResponse>;
	sleep: (ms: number) => Promise<void>;
	now: () => number;
}

const defaultIo: IdentityIo = {
	post: (url, auth, body, timeoutMs) => restPost(url, auth, body, timeoutMs),
	get: (url, auth, timeoutMs) => restGet(url, auth, timeoutMs),
	sleep: (ms) => Bun.sleep(ms),
	now: () => Date.now(),
};

/** Per-request ceiling, as `restGet`/`restPost` default to; capped to what is left. */
const REQUEST_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 1000;

/** True for another menu's data answering a `/system/identity` request: the
 *  post-boot REST race documented in provisioning.instructions.md, observed as
 *  `/system/resource` (`{"board-name":"CHR",...}`) on `license/renew` (license.ts).
 *  A real `set` answers `[]`, and a real read-back has `name`. */
function isWrongMenuBody(body: string): boolean {
	try {
		const data: unknown = JSON.parse(body);
		return !!data && typeof data === "object" && !Array.isArray(data) &&
			("board-name" in data || "architecture-name" in data);
	} catch {
		return false;
	}
}

function refused(name: string, what: string, status: number, body: string): QuickCHRError {
	return new QuickCHRError(
		"PROCESS_FAILED",
		`Setting the RouterOS identity to "${name}" failed: ${what} answered HTTP ${status} ${body}`,
	);
}

/**
 * Set `/system/identity` to `name` and wait until it reads back.
 *
 * `/system/identity` is one of the endpoints hit by the post-boot REST race
 * (provisioning.instructions.md), so a request can briefly answer with another
 * menu's data. A `set` answered that way did not land and is sent again (it is
 * idempotent); the read-back is polled until `name` matches. A RouterOS 4xx on
 * either request is final and throws with RouterOS's answer; connection errors and
 * 5xx retry. Every request timeout and retry delay is capped to what is left of
 * `budgetMs`, so the step ends within it.
 */
export async function applyIdentity(
	httpPort: number,
	name: string,
	auth: string = FACTORY_AUTH_HEADER,
	budgetMs = 30_000,
	io: IdentityIo = defaultIo,
): Promise<void> {
	const base = `http://127.0.0.1:${httpPort}/rest/system/identity`;
	const deadline = io.now() + budgetMs;
	const remaining = () => deadline - io.now();
	// At least 1 ms: a zero budget still makes one attempt, and a 0 ms timeout is not "none".
	const requestTimeout = () => Math.max(1, Math.min(REQUEST_TIMEOUT_MS, remaining()));
	let written = false;
	/** One try: undefined once the name reads back, else what stood in the way. */
	const attempt = async (): Promise<string | undefined> => {
		if (!written) {
			const set = await io.post(`${base}/set`, auth, { name }, requestTimeout());
			if (set.status >= 400 && set.status < 500) throw refused(name, "set", set.status, set.body);
			if (set.status < 200 || set.status >= 300) return `set: HTTP ${set.status} ${set.body}`;
			if (isWrongMenuBody(set.body)) return `set answered another menu's data: ${set.body.slice(0, 120)}`;
			written = true;
		}
		if (remaining() <= 0) return "the set landed, with no time left to read it back";
		const got = await io.get(base, auth, requestTimeout());
		if (got.status >= 400 && got.status < 500) throw refused(name, "read-back", got.status, got.body);
		if (got.status < 200 || got.status >= 300) return `read back: HTTP ${got.status} ${got.body}`;
		const parsed = JSON.parse(got.body) as { name?: unknown } | null;
		if (parsed?.name === name) return undefined;
		return `read back ${got.body.slice(0, 120)}`;
	};
	let last: string;
	do {
		let outcome: string | undefined;
		try {
			outcome = await attempt();
		} catch (e) {
			if (e instanceof QuickCHRError) throw e;
			outcome = e instanceof Error ? e.message : String(e);
		}
		if (outcome === undefined) return;
		last = outcome;
		const wait = Math.min(RETRY_DELAY_MS, remaining());
		if (wait > 0) await io.sleep(wait);
	} while (remaining() > 0);
	throw new QuickCHRError(
		"PROCESS_FAILED",
		`The RouterOS identity did not read back as "${name}" within ${Math.round(budgetMs / 1000)} s (last: ${last}).`,
	);
}
