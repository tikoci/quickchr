/**
 * Structured logging for quickchr library code.
 * Routes messages through onProgress callback when provided,
 * falls back to console.log/console.warn.
 * Debug messages ([quickchr] prefix) are suppressed unless QUICKCHR_DEBUG=1.
 */

const isDebug = () => process.env.QUICKCHR_DEBUG === "1";

export interface ProgressLogger {
	/** User-facing status message (e.g. "Uploading: foo.npk") */
	status(message: string): void;
	/** Debug message — only shown when QUICKCHR_DEBUG=1 */
	debug(message: string): void;
	/** Warning — always shown */
	warn(message: string): void;
}

/** Create a logger from an optional onProgress callback. */
export function createLogger(onProgress?: (message: string) => void): ProgressLogger {
	return {
		status(message: string) {
			if (onProgress) {
				onProgress(message);
			} else {
				console.log(message);
			}
		},
		debug(message: string) {
			if (!isDebug()) return;
			if (onProgress) {
				onProgress(`[debug] ${message}`);
			} else {
				console.log(`[quickchr] ${message}`);
			}
		},
		warn(message: string) {
			console.warn(message);
		},
	};
}
