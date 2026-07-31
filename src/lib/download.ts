/**
 * One bounded, classified download path for both `images.ts` and `packages.ts`.
 *
 * Why this exists (tikoci/quickchr#116, B13 of #110): both callers used to bound
 * a transfer by **total duration**, with a number nothing had measured, and they
 * did not even agree on that — `images.ts` aborted at a flat 120 s per attempt
 * with three retries, `packages.ts` had no deadline and no retries at all.
 *
 * A total-duration deadline cannot tell "slow" from "stuck". It fires on a
 * healthy transfer whose only sin is being large, and on the retry path it then
 * re-downloads from zero — turning one slow transfer into three. That is not a
 * hypothetical: two independent measurements caught it.
 *
 *   - Run 30606079288 (hosted linux-x86, first genuinely cold cache after #104):
 *     `all_packages-arm64-7.22.1.zip`, 52.2 MB, exceeded 120 s at ~0.35 MB/s and
 *     was reported as a timeout — while the *next test in the file* logged
 *     `Using cached packages: 7.22.1 (arm64)`. The transfer had completed.
 *   - B7's local full suite: `provisioning.test.ts` spent 619 s of its 992 s with
 *     **zero QEMU processes alive**, on 41.5 MB images "needing two retries
 *     each". 41.5 MB at 0.35 MB/s sits exactly on the 120 s edge, so those
 *     retries were the deadline firing on healthy transfers.
 *
 * ## Two bounds, not one
 *
 * Stall detection alone is not enough — a transfer trickling at one byte per
 * second would reset its stall deadline forever and never terminate. So a
 * transfer is bounded by both, and the failure says which one fired:
 *
 *   1. {@link DOWNLOAD_STALL_MS} — a resettable deadline, reset on every chunk
 *      received. A *moving* transfer is never aborted for being slow.
 *   2. A transfer budget derived from `content-length` and
 *      {@link COLD_DOWNLOAD_FLOOR_BYTES_PER_S}, so a trickle still terminates.
 *
 * ## Retry policy, and why "too slow" is not retriable
 *
 * Retrying a stall makes sense: a wedged socket is transient and the next attempt
 * usually moves. Retrying a transfer that exhausted a budget already sized at
 * ~3× the slowest throughput ever observed does not — it re-downloads from zero
 * on a link already known to be slower than the floor, which is precisely the
 * "one slow transfer becomes three" behavior this module exists to remove. So
 * `DOWNLOAD_TOO_SLOW` is terminal, and it is a signal that the floor is wrong (or
 * the link genuinely is), not something to paper over with another attempt.
 *
 * Resuming a partial transfer with a `Range` request would be strictly better
 * than either, and is deliberately out of scope here (#116 bounds and classifies
 * a transfer; it does not change the transport).
 */

import { unlinkSync, existsSync, renameSync } from "node:fs";
import { QuickCHRError } from "./types.ts";
import { fetchResilient } from "./net.ts";
import { createLogger, type ProgressLogger } from "./log.ts";

/**
 * Throughput to assume when budgeting a COLD download from MikroTik, in bytes
 * per second. Deliberately a floor, not an average.
 *
 * Grounded rather than guessed, in run 30606079288 — the first genuinely cold
 * cache after #104 gave the image cache resolved-version keys (nothing to fall
 * back to, so both all-packages zips downloaded fresh on a hosted linux-x86
 * runner):
 *
 *   all_packages-x86-7.22.1.zip     9.8 MB   16.2 s   ~0.60 MB/s   passed
 *   all_packages-arm64-7.22.1.zip  52.2 MB   >120 s   ~0.35 MB/s   blew a flat 120 s
 *
 * 120 000 B/s is roughly a third of the slower observation, which keeps a
 * slow-but-moving link inside its budget while a genuinely dead link still
 * terminates well inside the enclosing test, file and step budgets.
 *
 * **This is the single home for that number.** `test/integration/timeouts.ts`
 * imports it rather than keeping a copy — #116 asks the library budget and the
 * test budget not to drift, and two constants asked not to drift are how they
 * drift. If a better measurement turns up, change it here.
 */
export const COLD_DOWNLOAD_FLOOR_BYTES_PER_S = 120_000;

/**
 * How long a transfer may receive **nothing** before it is called stuck. Reset
 * on every chunk, so it bounds silence, not slowness.
 *
 * Generous enough to ride out a TCP retransmit or a CDN hiccup on a healthy
 * connection, short enough that a genuinely wedged socket fails in seconds
 * rather than in the minutes a total-duration deadline took.
 */
export const DOWNLOAD_STALL_MS = 30_000;

/** Fixed slack in the transfer budget for connect, TLS, and response headers —
 *  the part of a download whose cost does not scale with the artifact. */
export const DOWNLOAD_BUDGET_BASE_MS = 30_000;

/**
 * Transfer budget for a response that arrives without a `content-length`, where
 * a size-derived budget cannot be computed. Stated here rather than left
 * unbounded, and named in the failure so a log says which budget applied.
 *
 * 15 minutes is ~2× the budget the largest artifact quickchr downloads (the
 * 52.2 MB all-packages zip, ~7.3 min at the floor above) would have received.
 */
export const DOWNLOAD_NO_LENGTH_BUDGET_MS = 15 * 60_000;

/** Default attempts for a retriable failure. */
export const DOWNLOAD_MAX_ATTEMPTS = 3;

/**
 * Transfer budget in ms for an artifact of `bytes`, or {@link
 * DOWNLOAD_NO_LENGTH_BUDGET_MS} when the size is unknown.
 *
 * A known size of 0 is a *known* size, not an unknown one — it gets the base and
 * nothing more. Only a missing/invalid `content-length` takes the fallback,
 * because that is the case where a size-derived budget cannot be computed at all.
 *
 * Transfer time rounds **up** to the next whole second. Flooring would
 * under-budget by up to a second on every artifact, which is the direction that
 * turns a completed download back into a failure — the whole defect in #116.
 */
export function transferBudgetMs(bytes: number | undefined): number {
	if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
		return DOWNLOAD_NO_LENGTH_BUDGET_MS;
	}
	return DOWNLOAD_BUDGET_BASE_MS + Math.ceil((bytes / COLD_DOWNLOAD_FLOOR_BYTES_PER_S) * 1000);
}

/** Which of the two bounds ended a transfer. */
export type DownloadDeadline = "stall" | "transfer-budget";

/** What a transfer had achieved when it ended — the evidence a CI log needs to
 *  answer "was this slow, stalled, or refused?" without re-running it. */
export interface TransferOutcome {
	/** Bytes actually received. */
	bytes: number;
	/** `content-length`, when the server sent one. */
	expected?: number;
	elapsedMs: number;
	/** Observed bytes per second over the whole transfer. */
	throughputBytesPerS: number;
	/** Set when a deadline ended the transfer; absent for other failures. */
	deadline?: DownloadDeadline;
	/** The budget the transfer was held to, in ms. */
	budgetMs: number;
}

function mb(bytes: number): string {
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** One-line rendering of a transfer's evidence, used in every failure message. */
export function describeTransfer(o: TransferOutcome): string {
	const of = o.expected === undefined ? " of unknown size" : ` of ${mb(o.expected)}`;
	const rate = `${(o.throughputBytesPerS / 1024 / 1024).toFixed(3)} MB/s`;
	const budget = `budget ${(o.budgetMs / 1000).toFixed(0)}s`;
	const which = o.expected === undefined ? `${budget}, no content-length` : budget;
	return `${mb(o.bytes)}${of} in ${(o.elapsedMs / 1000).toFixed(1)}s (${rate}, ${which})`;
}

/** Thrown when a deadline ends a transfer. Carries the evidence for the caller
 *  and for the retry decision — a stall is retriable, an exhausted budget is not. */
export class DownloadDeadlineError extends Error {
	readonly outcome: TransferOutcome;
	constructor(outcome: TransferOutcome, url: string) {
		super(
			outcome.deadline === "stall"
				? `Download stalled: no data for ${(DOWNLOAD_STALL_MS / 1000).toFixed(0)}s — ${describeTransfer(outcome)} from ${url}`
				: `Download exceeded its transfer budget — ${describeTransfer(outcome)} from ${url}`,
		);
		this.name = "DownloadDeadlineError";
		this.outcome = outcome;
	}
}

export interface DownloadOptions {
	logger?: ProgressLogger;
	/** Attempts for retriable failures. Defaults to {@link DOWNLOAD_MAX_ATTEMPTS}. */
	maxAttempts?: number;
	/** Override the silence deadline. Tests use this; callers should not need to. */
	stallMs?: number;
	/**
	 * Override the transfer budget, bypassing {@link transferBudgetMs}.
	 *
	 * A test lever, like `stallMs`: the real budget starts at
	 * {@link DOWNLOAD_BUDGET_BASE_MS}, so exercising the trickle branch honestly
	 * would cost 30 s of wall clock per assertion. The derived value is pinned
	 * separately as a pure function, and `downloadToFile` is asserted to *use* it
	 * when this is absent. Production callers should not set it.
	 */
	budgetMs?: number;
}

/** True for an HTTP status worth another attempt: server-side, or a CDN's
 *  transient 408/429. Every other 4xx is the server telling us we are wrong. */
function isRetriableStatus(status: number): boolean {
	if (status === 408 || status === 429) return true;
	return status >= 500;
}

/**
 * Stream `url` to `destPath`, bounded by a stall deadline and a transfer budget.
 *
 * Writes to `<destPath>.part` and renames only on a complete, length-verified
 * transfer, so an interrupted download can never leave a truncated file that a
 * later `existsSync()` would treat as cached.
 *
 * @throws {QuickCHRError} `DOWNLOAD_STALLED` when the connection went silent,
 *   `DOWNLOAD_TOO_SLOW` when a moving transfer could not finish inside its
 *   size-derived budget, `DOWNLOAD_FAILED` for everything else. All three carry
 *   bytes/expected/elapsed/throughput.
 */
export async function downloadToFile(
	url: string,
	destPath: string,
	opts: DownloadOptions = {},
): Promise<TransferOutcome> {
	const log = opts.logger ?? createLogger();
	const maxAttempts = opts.maxAttempts ?? DOWNLOAD_MAX_ATTEMPTS;
	const stallMs = opts.stallMs ?? DOWNLOAD_STALL_MS;
	const partPath = `${destPath}.part`;

	let lastError: Error | undefined;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const outcome = await attemptDownload(url, partPath, stallMs, opts.budgetMs, log);
			// Rename, not copy: `<dest>.part` is in the destination's own directory,
			// so this is a same-filesystem move and the artifact appears at its final
			// path atomically. Copying would re-write every byte (52 MB for the
			// largest artifact) for no benefit.
			renameSync(partPath, destPath);
			log.status(`  Saved (${describeTransfer(outcome)})`);
			return outcome;
		} catch (e) {
			removeIfPresent(partPath);
			// Terminal: a client error, or a budget already sized at ~3x the slowest
			// throughput we have ever measured. Retrying either just spends the
			// budget again — see the retry-policy note at the top of this file.
			if (e instanceof QuickCHRError) throw e;
			if (e instanceof DownloadDeadlineError && e.outcome.deadline === "transfer-budget") {
				throw new QuickCHRError("DOWNLOAD_TOO_SLOW", e.message);
			}
			lastError = e instanceof Error ? e : new Error(String(e));
			if (attempt < maxAttempts) {
				log.status(`  ${lastError.message}`);
				log.status(`  Retrying (attempt ${attempt + 1}/${maxAttempts}) in ${attempt * 2}s...`);
				await Bun.sleep(attempt * 2000);
			}
		}
	}

	const detail = lastError?.message ?? "unknown error";
	if (lastError instanceof DownloadDeadlineError) {
		throw new QuickCHRError(
			"DOWNLOAD_STALLED",
			`Download stalled on all ${maxAttempts} attempts: ${detail}`,
		);
	}
	throw new QuickCHRError(
		"DOWNLOAD_FAILED",
		`Download failed after ${maxAttempts} attempts: ${detail}`,
	);
}

async function attemptDownload(
	url: string,
	partPath: string,
	stallMs: number,
	budgetOverrideMs: number | undefined,
	log: ProgressLogger,
): Promise<TransferOutcome> {
	const controller = new AbortController();
	const started = Bun.nanoseconds();
	let fired: DownloadDeadline | undefined;
	let stallTimer: ReturnType<typeof setTimeout> | undefined;
	let budgetTimer: ReturnType<typeof setTimeout> | undefined;
	let bytes = 0;
	let expected: number | undefined;
	// Until the headers arrive we do not know the size, so the connect phase is
	// held to the stall deadline alone and the budget starts with the body.
	let budgetMs = budgetOverrideMs ?? transferBudgetMs(undefined);

	const elapsedMs = () => (Bun.nanoseconds() - started) / 1e6;
	const outcome = (): TransferOutcome => {
		const ms = elapsedMs();
		return {
			bytes,
			expected,
			elapsedMs: ms,
			throughputBytesPerS: ms > 0 ? bytes / (ms / 1000) : 0,
			deadline: fired,
			budgetMs,
		};
	};
	const armStall = () => {
		if (stallTimer) clearTimeout(stallTimer);
		stallTimer = setTimeout(() => {
			fired = "stall";
			controller.abort();
		}, stallMs);
	};
	const clearTimers = () => {
		if (stallTimer) clearTimeout(stallTimer);
		if (budgetTimer) clearTimeout(budgetTimer);
	};

	armStall();
	try {
		const response = await fetchResilient(url, { signal: controller.signal });

		if (!response.ok) {
			// Non-retriable client errors are the server telling us the request is
			// wrong; a retry cannot change that. Surface immediately.
			if (!isRetriableStatus(response.status)) {
				throw new QuickCHRError(
					"DOWNLOAD_FAILED",
					`Download failed: HTTP ${response.status} for ${url}`,
				);
			}
			throw new Error(`HTTP ${response.status}`);
		}

		const lengthHeader = response.headers.get("content-length");
		expected = lengthHeader === null ? undefined : Number(lengthHeader);
		if (expected !== undefined && !Number.isFinite(expected)) expected = undefined;
		budgetMs = budgetOverrideMs ?? transferBudgetMs(expected);
		budgetTimer = setTimeout(() => {
			fired = "transfer-budget";
			controller.abort();
		}, budgetMs);

		log.status(
			expected === undefined
				? `  Transferring (size unknown, budget ${(budgetMs / 1000).toFixed(0)}s)`
				: `  Transferring ${mb(expected)} (budget ${(budgetMs / 1000).toFixed(0)}s)`,
		);

		if (!response.body) throw new Error("response had no body");

		// Streamed rather than buffered through `arrayBuffer()`: per-chunk arrival
		// is what makes "moving" observable at all, and it is also what the old
		// `Bun.write(path, response)` note in images.ts was working around.
		const sink = Bun.file(partPath).writer();
		try {
			for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
				bytes += chunk.byteLength;
				sink.write(chunk);
				armStall();
			}
			await sink.end();
		} catch (e) {
			// Close the sink without masking the failure that got us here — an
			// aborted body leaves an open fd otherwise.
			try {
				await sink.end();
			} catch {
				// Already failed; the .part file is removed by the caller regardless.
			}
			throw e;
		}

		// Defense in depth. Measured against a raw stub: when a server declares a
		// length and then closes early, Bun's fetch already throws ECONNRESET while
		// reading the body, so this rarely fires. It still has to be here — a
		// short-but-clean framing would otherwise be written out as a complete
		// artifact and cached forever.
		if (expected !== undefined && bytes !== expected) {
			throw new Error(`truncated transfer — ${describeTransfer(outcome())}`);
		}
		clearTimers();
		return outcome();
	} catch (e) {
		clearTimers();
		if (fired !== undefined) throw new DownloadDeadlineError(outcome(), url);
		throw e;
	}
}

function removeIfPresent(path: string): void {
	if (existsSync(path)) {
		try {
			unlinkSync(path);
		} catch {
			// Best effort: a leftover .part is never mistaken for the finished file.
		}
	}
}
