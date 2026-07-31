/**
 * The one way integration tests talk to a CHR's REST API.
 *
 * Two jobs, both of them about tikoci/quickchr#69.
 *
 * **1. One client.** `src/lib/rest.ts` (`node:http`, `agent: false`,
 * `Connection: close`) is what the library itself uses; tests that reached CHR
 * through Bun's `fetch()` were exercising a different connection-reuse policy
 * than the code under test, which made "is this the client or the guest?" an
 * open question on every `ECONNRESET`. That question is now closed by
 * construction — not because `fetch()` was proven guilty. It was not: run
 * 30507484030 reset through `restGet` too, and `test/lab/bun-pool/` failed to
 * reproduce the pooling bug at all. This is **confound removal**.
 *
 * **2. Evidence.** A reset here used to surface as a one-line error against a
 * machine that had already passed readiness, so there was nothing to diagnose
 * from. {@link chrGet} runs the full boot-failure instrument set on failure —
 * guest snapshot, per-port slirp classification, monitor state, embedded logs —
 * and records which request died and what credential change preceded it.
 *
 * Assertions on `status` are the caller's: a 401 is an answer, not a failure,
 * and several tests assert exactly that. Only a *thrown* error — reset, timeout,
 * refused — trips the capture.
 */

import { captureRunningFailure } from "../../src/lib/quickchr.ts";
import { restGet, type RestResponse } from "../../src/lib/rest.ts";
import type { ChrInstance } from "../../src/lib/types.ts";

/** HTTP Basic header value. Tests write credentials as a pair, not as base64. */
export function basicAuth(user: string, password: string): string {
	return `Basic ${btoa(`${user}:${password}`)}`;
}

export interface ChrGetOptions {
	/** Per-request timeout. Default 10 s, matching `restGet`'s own default. */
	timeoutMs?: number;
	/**
	 * The credential or database change immediately preceding this request —
	 * #69's suspected precondition, e.g. `"createUser(testuser)"` or
	 * `"clean() then relaunch"`.
	 *
	 * Stated by the caller rather than inferred: the helper can see the auth
	 * header, but "which user this request authenticates as" and "what just
	 * changed on the guest" are different facts, and only the test knows the
	 * second one. Omit it when nothing changed — an absent field reads as "not
	 * recorded", which is honest, where a guessed one would not be.
	 */
	after?: string;
}

/**
 * GET a CHR REST path, capturing post-readiness forensics if the request throws.
 *
 * @param instance  A running, already-REST-ready machine.
 * @param path      REST path including the leading slash, e.g. `/rest/user`.
 * @param auth      Authorization header value — see {@link basicAuth}.
 */
export async function chrGet(
	instance: ChrInstance,
	path: string,
	auth: string,
	opts: ChrGetOptions = {},
): Promise<RestResponse> {
	const url = `http://127.0.0.1:${instance.ports.http}${path}`;
	try {
		return await restGet(url, auth, opts.timeoutMs ?? 10_000);
	} catch (error) {
		// The report's summary already opens with "Failed after readiness: <op> …
		// — <error>" and closes with its own "Full report: <path>", so this adds
		// no prefix or suffix of its own; doing either printed both twice.
		//
		// captureRunningFailure() never throws, but it is still guarded: this runs
		// on the failure path, where an exception raised while collecting evidence
		// would replace the real error with a worse one. The fallback therefore
		// has to state the error itself — it is the branch where nothing else did.
		let summary: string;
		try {
			const report = await captureRunningFailure(instance.state, "post-readiness-rest", {
				operation: `GET ${path}`,
				error: describeError(error),
				credentialTransition: opts.after,
			});
			summary = report.summary;
		} catch (capture) {
			summary = `Failed after readiness: GET ${path} — ${describeError(error)}\n` +
				`<forensics failed: ${capture instanceof Error ? capture.message : String(capture)}>`;
		}
		// Rethrown, not swallowed: the capture is extra evidence attached to the
		// failure, never a reason for the test to keep going. `cause` keeps the
		// original error reachable, codes and all, for anything matching on it.
		throw new Error(summary, { cause: error });
	}
}

/** `ECONNRESET` is carried on `code`/`errno`/`syscall`, not in the message —
 *  and telling a reset from a timeout from a refusal is the first thing anyone
 *  reading a #69 report needs. */
function describeError(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const e = error as Error & { code?: string; errno?: number; syscall?: string };
	const parts = [`${e.name}: ${e.message}`];
	if (e.code) parts.push(`code=${e.code}`);
	if (e.errno !== undefined) parts.push(`errno=${e.errno}`);
	if (e.syscall) parts.push(`syscall=${e.syscall}`);
	return parts.join(" ");
}
