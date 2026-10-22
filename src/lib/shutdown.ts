/** Bounded guest shutdown, independently observing process exit (#143). */
import { QuickCHRError } from "./types.ts";
import type { ShutdownResult } from "./types.ts";

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

export function validateShutdownTimeout(timeoutMs: number): number {
	// node:http timers cannot represent a larger delay; overflow becomes a 1 ms timer.
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
		throw new QuickCHRError("INVALID_ARGUMENT", "shutdown timeoutMs must be a positive integer no greater than 2147483647 milliseconds");
	}
	return timeoutMs;
}

/** The process observer is separate from the request: RouterOS can return HTTP 400
 * `interrupted` while successfully halting. Request must enforce its timeout (exec does). */
export async function shutdownGuest(
	timeoutMs: number,
	request: (timeoutMs: number) => Promise<unknown>,
	isRunning: () => boolean,
	forceStop: () => Promise<unknown>,
): Promise<ShutdownResult> {
	const deadline = performance.now() + timeoutMs;
	let requestError: string | undefined;
	const pending = Promise.resolve().then(() => request(Math.max(1, Math.ceil(deadline - performance.now())))).catch((error: unknown) => {
		requestError = error instanceof Error ? error.message : String(error);
	});
	while (isRunning() && performance.now() < deadline) {
		await Bun.sleep(Math.min(100, Math.max(1, deadline - performance.now())));
	}
	const guestExited = !isRunning();
	// exec's HTTP timer settles this within the same grace budget, including when
	// QEMU exits while its HTTP response is still pending. Never replay the request.
	await pending;
	if (guestExited || !isRunning()) {
		return { outcome: "guest-exited", ...(requestError === undefined ? {} : { requestError }) };
	}

	try {
		await forceStop();
	} catch {
		if (isRunning()) throw new QuickCHRError("STATE_ERROR", "shutdown could not terminate QEMU; machine remains running");
	}
	// stopQemu sends SIGKILL after its SIGTERM wait but does not await that exit.
	const killDeadline = performance.now() + 1000;
	while (isRunning() && performance.now() < killDeadline) await Bun.sleep(50);
	if (isRunning()) throw new QuickCHRError("STATE_ERROR", "shutdown could not confirm QEMU exit; machine remains running");
	return { outcome: "forced", ...(requestError === undefined ? {} : { requestError }) };
}
