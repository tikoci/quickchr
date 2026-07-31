/**
 * Anchor tests for the bounded download path (#116, B13 of #110).
 *
 * Everything here runs against a **local stub server**, never
 * download.mikrotik.com — #116's done-when is explicit that no test may depend
 * on a real host being slow. The stub trickles, goes silent mid-body, omits or
 * misstates `content-length`, and refuses; that is what makes the three branches
 * (moving-but-slow, trickle, wedged) testable at all.
 *
 * ## Why the stub is a raw TCP listener and not `Bun.serve`
 *
 * Measured while writing these tests: `Bun.serve` **drops an explicit
 * `content-length`** whenever the body is a `ReadableStream` and frames the
 * response `transfer-encoding: chunked` instead. A stub built on it therefore
 * cannot exercise the size-derived transfer budget at all — every response looks
 * like an unknown-length one. Writing the HTTP response bytes directly is the
 * only way to control framing, and framing is half of what is under test.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "bun";
import {
	downloadToFile,
	transferBudgetMs,
	describeTransfer,
	COLD_DOWNLOAD_FLOOR_BYTES_PER_S,
	DOWNLOAD_BUDGET_BASE_MS,
	DOWNLOAD_NO_LENGTH_BUDGET_MS,
	DOWNLOAD_STALL_MS,
	type TransferOutcome,
} from "../../src/lib/download.ts";
import { QuickCHRError } from "../../src/lib/types.ts";

const silentLogger = { status() {}, debug() {}, warn() {} };

const stubs: Array<{ stop: (force?: boolean) => void }> = [];
const dirs: string[] = [];

afterEach(() => {
	for (const s of stubs.splice(0)) s.stop(true);
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
	const d = mkdtempSync(join(tmpdir(), "quickchr-dl-"));
	dirs.push(d);
	return d;
}

interface StubOptions {
	/** Bytes actually written to the socket. */
	size: number;
	/** `Content-Length` to declare. `null` omits it (close-delimited body).
	 *  Defaults to `size`. */
	declareLength?: number | null;
	/** Bytes per write. Defaults to the whole body in one go. */
	chunk?: number;
	/** Delay between writes, ms. */
	gapMs?: number;
	/** Stop writing after this many bytes and hold the socket open forever — a
	 *  wedged transfer, as opposed to a slow one. */
	silentAfter?: number;
	/** Reply with this status instead of 200. */
	status?: number;
	/** Reply 503 for this many attempts before serving the body. */
	failFirst?: number;
}

/** A raw HTTP/1.1 stub. Returns its URL and an attempt counter. */
function startStub(opts: StubOptions): { url: string; attempts: () => number } {
	let attempts = 0;
	const served = new WeakSet<Socket<undefined>>();

	const listener = Bun.listen<undefined>({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			data(sock) {
				// One response per connection; `data` can fire more than once.
				if (served.has(sock)) return;
				served.add(sock);
				attempts++;
				void respond(sock, attempts);
			},
			error() {},
			close() {},
		},
	});

	async function respond(sock: Socket<undefined>, attempt: number): Promise<void> {
		if (opts.status && opts.status !== 200) {
			sock.write(`HTTP/1.1 ${opts.status} Nope\r\nContent-Length: 4\r\nConnection: close\r\n\r\nnope`);
			sock.flush();
			sock.end();
			return;
		}
		if (opts.failFirst && attempt <= opts.failFirst) {
			sock.write("HTTP/1.1 503 Busy\r\nContent-Length: 4\r\nConnection: close\r\n\r\nbusy");
			sock.flush();
			sock.end();
			return;
		}

		const declared = opts.declareLength === undefined ? opts.size : opts.declareLength;
		const lengthHeader = declared === null ? "" : `Content-Length: ${declared}\r\n`;
		sock.write(`HTTP/1.1 200 OK\r\n${lengthHeader}Connection: close\r\n\r\n`);
		sock.flush();

		const chunk = opts.chunk ?? opts.size;
		let sent = 0;
		while (sent < opts.size) {
			if (opts.silentAfter !== undefined && sent >= opts.silentAfter) return; // hold open, send nothing
			const n = Math.min(chunk, opts.size - sent);
			sock.write(new Uint8Array(n).fill(65));
			sock.flush();
			sent += n;
			if (opts.gapMs) await Bun.sleep(opts.gapMs);
		}
		sock.end();
	}

	stubs.push(listener);
	return { url: `http://127.0.0.1:${listener.port}/artifact.zip`, attempts: () => attempts };
}

async function expectQuickCHRError(p: Promise<unknown>): Promise<QuickCHRError> {
	try {
		await p;
	} catch (e) {
		expect(e).toBeInstanceOf(QuickCHRError);
		return e as QuickCHRError;
	}
	throw new Error("expected the download to throw, but it resolved");
}

describe("transferBudgetMs", () => {
	test("derives the budget from size and the named floor throughput", () => {
		const arm64Zip = 52_216_933;
		expect(transferBudgetMs(arm64Zip)).toBe(
			DOWNLOAD_BUDGET_BASE_MS + Math.ceil((arm64Zip / COLD_DOWNLOAD_FLOOR_BYTES_PER_S) * 1000),
		);
	});

	test("the 52.2 MB zip now clears the flat 120 s that failed it while completing", () => {
		// Run 30606079288: this transfer finished at ~0.35 MB/s and was still
		// reported as a timeout. Its budget must comfortably exceed both the 120 s
		// it was given and the ~149 s it actually took.
		const budget = transferBudgetMs(52_216_933);
		expect(budget).toBeGreaterThan(120_000);
		expect(budget).toBeGreaterThan(149_000);
	});

	test("the 41.5 MB image that 'needed two retries' now fits in one attempt", () => {
		// B7's local suite: 41.5 MB at ~0.35 MB/s is ~119 s, sitting exactly on the
		// old flat 120 s edge — which is why it retried twice while being healthy.
		expect(transferBudgetMs(41_500_000)).toBeGreaterThan(119_000 * 2);
	});

	test("an unknown size takes the stated fallback, not an unbounded wait", () => {
		expect(transferBudgetMs(undefined)).toBe(DOWNLOAD_NO_LENGTH_BUDGET_MS);
		expect(transferBudgetMs(Number.NaN)).toBe(DOWNLOAD_NO_LENGTH_BUDGET_MS);
		expect(DOWNLOAD_NO_LENGTH_BUDGET_MS).toBeLessThan(60 * 60_000);
	});

	test("a known zero-byte artifact is a known size, not an unknown one", () => {
		expect(transferBudgetMs(0)).toBe(DOWNLOAD_BUDGET_BASE_MS);
	});
});

describe("downloadToFile — a moving transfer is never aborted for being slow", () => {
	test("a slow-but-moving transfer completes", async () => {
		// 40 writes with a 25 ms gap: ~1 s total, with every gap well inside the
		// 300 ms stall deadline. A total-duration deadline of 300 ms would have
		// killed this; resetting on each chunk does not.
		const { url } = startStub({ size: 40_000, chunk: 1_000, gapMs: 25 });
		const dest = join(tempDir(), "artifact.zip");

		const outcome = await downloadToFile(url, dest, { logger: silentLogger, stallMs: 300 });

		expect(readFileSync(dest).byteLength).toBe(40_000);
		expect(outcome.bytes).toBe(40_000);
		expect(outcome.expected).toBe(40_000);
		expect(outcome.elapsedMs).toBeGreaterThan(300);
	}, 30_000);

	test("uses the size-derived budget when no override is given", async () => {
		const { url } = startStub({ size: 4_096, chunk: 1_024 });
		const dest = join(tempDir(), "artifact.zip");

		const outcome = await downloadToFile(url, dest, { logger: silentLogger });

		// Pins that the production path really does consult transferBudgetMs — the
		// tests below use a budget override to stay fast, and this is what stops
		// that lever from hiding a wrong default.
		expect(outcome.budgetMs).toBe(transferBudgetMs(4_096));
	});

	test("no .part file survives a successful download", async () => {
		const { url } = startStub({ size: 2_048, chunk: 512 });
		const dest = join(tempDir(), "artifact.zip");

		await downloadToFile(url, dest, { logger: silentLogger });

		expect(existsSync(dest)).toBe(true);
		expect(existsSync(`${dest}.part`)).toBe(false);
	});
});

describe("downloadToFile — a wedged transfer fails fast and says so", () => {
	test("silence past the stall deadline is classified DOWNLOAD_STALLED", async () => {
		const { url, attempts } = startStub({ size: 100_000, chunk: 1_000, silentAfter: 3_000 });
		const dest = join(tempDir(), "artifact.zip");

		const started = Bun.nanoseconds();
		const err = await expectQuickCHRError(
			downloadToFile(url, dest, { logger: silentLogger, stallMs: 300, maxAttempts: 2 }),
		);
		const elapsedMs = (Bun.nanoseconds() - started) / 1e6;

		expect(err.code).toBe("DOWNLOAD_STALLED");
		// Fails in seconds, not in the minutes a total-duration deadline took.
		expect(elapsedMs).toBeLessThan(transferBudgetMs(100_000));
		// A stall IS retriable — a wedged socket usually moves on the next attempt.
		expect(attempts()).toBe(2);
	}, 30_000);

	test("the failure carries bytes, expected, elapsed and throughput", async () => {
		const { url } = startStub({ size: 100_000, chunk: 1_000, silentAfter: 4_000 });
		const dest = join(tempDir(), "artifact.zip");

		const err = await expectQuickCHRError(
			downloadToFile(url, dest, { logger: silentLogger, stallMs: 300, maxAttempts: 1 }),
		);

		// The whole point of the bite: a CI log must answer "was this slow,
		// stalled, or refused?" without re-running it.
		expect(err.message).toContain("stalled");
		expect(err.message).toMatch(/0\.0 MB of 0\.1 MB/);
		expect(err.message).toMatch(/MB\/s/);
		expect(err.message).toMatch(/budget \d+s/);
		expect(err.message).toContain(url);
	}, 30_000);

	test("a partial transfer never leaves a file a later run would treat as cached", async () => {
		const { url } = startStub({ size: 100_000, chunk: 1_000, silentAfter: 5_000 });
		const dir = tempDir();
		const dest = join(dir, "artifact.zip");

		await expectQuickCHRError(
			downloadToFile(url, dest, { logger: silentLogger, stallMs: 300, maxAttempts: 1 }),
		);

		// Both callers gate on existsSync(zipPath). A truncated file here would be
		// served as a complete cached artifact forever.
		expect(existsSync(dest)).toBe(false);
		expect(existsSync(`${dest}.part`)).toBe(false);
	}, 30_000);
});

describe("downloadToFile — a trickle terminates against the transfer budget", () => {
	// The hole in a stall-only design: these transfers never go silent for as long
	// as the stall deadline, so stall detection alone would wait forever. The
	// budget is overridden to keep the suite fast — see DownloadOptions.budgetMs;
	// the derived value is pinned above as a pure function.
	const trickle = { size: 10_000_000, chunk: 10, gapMs: 20 };

	test("a moving transfer that cannot finish in its budget is DOWNLOAD_TOO_SLOW", async () => {
		const { url } = startStub(trickle);
		const dest = join(tempDir(), "artifact.zip");

		const err = await expectQuickCHRError(
			downloadToFile(url, dest, {
				logger: silentLogger,
				stallMs: 5_000,
				budgetMs: 1_000,
				maxAttempts: 3,
			}),
		);

		expect(err.code).toBe("DOWNLOAD_TOO_SLOW");
		expect(err.message).toContain("transfer budget");
		// Still reports what it achieved, not just that it gave up.
		expect(err.message).toMatch(/MB\/s/);
	}, 30_000);

	test("DOWNLOAD_TOO_SLOW is terminal — it does not re-download from zero", async () => {
		const { url, attempts } = startStub(trickle);
		const dest = join(tempDir(), "artifact.zip");

		await expectQuickCHRError(
			downloadToFile(url, dest, {
				logger: silentLogger,
				stallMs: 5_000,
				budgetMs: 1_000,
				maxAttempts: 3,
			}),
		);

		// "One slow transfer becomes three" is the behavior this bite removes: the
		// real budget is already ~3x the slowest throughput ever measured, so
		// another attempt just spends it again on a link known to be slower than
		// the floor.
		expect(attempts()).toBe(1);
	}, 30_000);

	test("a stall inside a trickling transfer still classifies as a stall", async () => {
		// Both deadlines are live at once; the one that fires first names the
		// failure. Here the socket goes quiet before the budget expires.
		const { url } = startStub({ size: 10_000_000, chunk: 10, gapMs: 20, silentAfter: 200 });
		const dest = join(tempDir(), "artifact.zip");

		const err = await expectQuickCHRError(
			downloadToFile(url, dest, {
				logger: silentLogger,
				stallMs: 300,
				budgetMs: 20_000,
				maxAttempts: 1,
			}),
		);

		expect(err.code).toBe("DOWNLOAD_STALLED");
	}, 30_000);
});

describe("downloadToFile — HTTP outcomes", () => {
	test("a 404 fails immediately, without burning retries", async () => {
		const { url, attempts } = startStub({ size: 0, status: 404 });
		const dest = join(tempDir(), "artifact.zip");

		const err = await expectQuickCHRError(
			downloadToFile(url, dest, { logger: silentLogger, maxAttempts: 3 }),
		);

		expect(err.code).toBe("DOWNLOAD_FAILED");
		expect(err.message).toContain("404");
		expect(attempts()).toBe(1);
	});

	test("a 503 is retried and can succeed", async () => {
		const { url, attempts } = startStub({ size: 4_096, chunk: 1_024, failFirst: 2 });
		const dest = join(tempDir(), "artifact.zip");

		const outcome = await downloadToFile(url, dest, { logger: silentLogger, maxAttempts: 3 });

		expect(outcome.bytes).toBe(4_096);
		expect(attempts()).toBe(3);
		expect(existsSync(dest)).toBe(true);
	}, 30_000);

	test("a body shorter than its declared length never becomes a cached artifact", async () => {
		// Measured: Bun's fetch raises ECONNRESET on the early close before the
		// explicit length check is reached, so this surfaces as a retriable
		// transport failure rather than "truncated". Either way the invariant that
		// matters holds — nothing is written, and it is not silently accepted.
		const { url } = startStub({ size: 1_000, chunk: 500, declareLength: 5_000 });
		const dest = join(tempDir(), "artifact.zip");

		const err = await expectQuickCHRError(
			downloadToFile(url, dest, { logger: silentLogger, maxAttempts: 1 }),
		);

		expect(err.code).toBe("DOWNLOAD_FAILED");
		expect(existsSync(dest)).toBe(false);
		expect(existsSync(`${dest}.part`)).toBe(false);
	}, 30_000);

	test("a body with no content-length still downloads, under the stated fallback", async () => {
		const { url } = startStub({ size: 8_192, chunk: 2_048, declareLength: null });
		const dest = join(tempDir(), "artifact.zip");

		const outcome = await downloadToFile(url, dest, { logger: silentLogger });

		expect(outcome.bytes).toBe(8_192);
		expect(outcome.expected).toBeUndefined();
		expect(outcome.budgetMs).toBe(DOWNLOAD_NO_LENGTH_BUDGET_MS);
		expect(readFileSync(dest).byteLength).toBe(8_192);
	}, 30_000);
});

describe("describeTransfer", () => {
	const base: TransferOutcome = {
		bytes: 12_582_912,
		expected: 52_216_933,
		elapsedMs: 149_000,
		throughputBytesPerS: 84_449,
		deadline: "stall",
		budgetMs: 465_000,
	};

	test("renders bytes, expected, elapsed, throughput and the budget", () => {
		expect(describeTransfer(base)).toBe("12.0 MB of 49.8 MB in 149.0s (0.081 MB/s, budget 465s)");
	});

	test("says so when the server gave no size", () => {
		const s = describeTransfer({
			...base,
			expected: undefined,
			budgetMs: DOWNLOAD_NO_LENGTH_BUDGET_MS,
		});
		expect(s).toContain("of unknown size");
		expect(s).toContain("no content-length");
	});
});

describe("the two deadlines are usefully different", () => {
	test("silence is caught far sooner than any real artifact's budget", () => {
		// A stall deadline as long as the transfer budget would tell us nothing the
		// old flat deadline did not. (It equals DOWNLOAD_BUDGET_BASE_MS by
		// coincidence, not by design — they bound different things.)
		expect(DOWNLOAD_STALL_MS).toBeLessThan(transferBudgetMs(9_821_339));
		expect(DOWNLOAD_STALL_MS).toBeLessThan(transferBudgetMs(52_216_933));
		expect(DOWNLOAD_STALL_MS).toBeLessThanOrEqual(60_000);
	});
});
