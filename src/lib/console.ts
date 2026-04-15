/**
 * Serial console command execution for RouterOS CHR.
 *
 * Provides a higher-level interface over the raw serial socket stream
 * from channels.ts. Handles the RouterOS console protocol:
 * - Login sequence (username, password, license prompt, password change)
 * - Prompt detection with offset tracking (prevents re-matching)
 * - Command execution with output capture
 * - ANSI escape sequence stripping
 *
 * Key lessons from chr-armed (tikoci/chr-armed):
 * - Always use \r (not \r\n) — serial PTY treats \r\n as two inputs
 * - matchOffset prevents waitFor("repeat new password>") from matching
 *   the earlier "new password>" occurrence
 * - RouterOS prompt format: [admin@<identity>] > where identity varies
 *   by version (7.23+ defaults to "CHR" for CHR instances, older = "MikroTik")
 * - On first boot: license [Y/n] prompt, then forced password change
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { connect, type Socket } from "node:net";
import { QuickCHRError } from "./types.ts";

/** Default timeout for console operations. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Interval for polling the buffer in waitFor(). */
const POLL_INTERVAL_MS = 250;

/** Pre-prompt pattern: the "] > " suffix is version-proof since it
 *  covers [admin@MikroTik] > , [admin@CHR] > , and any custom identity. */
const PROMPT_PATTERN = "] > ";

/**
 * Regex to strip ANSI escape sequences from console output.
 * Covers CSI sequences, OSC sequences, and other common escapes.
 * Uses RegExp constructor to avoid Biome noControlCharactersInRegex.
 */
const ANSI_RE = new RegExp(
	"\x1b\\[[0-9;]*[a-zA-Z]" +
	"|\x1b\\][^\x07]*\x07" +
	"|\x1b[()][0-9A-B]" +
	"|\x1b[>=<]" +
	"|\x1b\\[[?]?[0-9;]*[hlm]",
	"g",
);

/** Strip ANSI escape sequences from text. */
export function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

interface ConsoleSessionState {
	socket: Socket;
	buffer: string;
	matchOffset: number;
	streamDone: boolean;
}

/**
 * Connect to the serial console socket and start buffer accumulation.
 */
function openSession(machineDir: string): ConsoleSessionState {
	const socketPath = join(machineDir, "serial.sock");
	if (!existsSync(socketPath)) {
		throw new QuickCHRError(
			"MACHINE_STOPPED",
			"Serial socket not found — is the machine running in background mode?",
		);
	}

	const socket = connect({ path: socketPath });
	const state: ConsoleSessionState = {
		socket,
		buffer: "",
		matchOffset: 0,
		streamDone: false,
	};

	socket.on("data", (data: Buffer) => {
		state.buffer += data.toString();
	});

	socket.on("end", () => {
		state.streamDone = true;
	});

	socket.on("error", () => {
		state.streamDone = true;
	});

	return state;
}

/**
 * Wait for a pattern to appear in the buffer, searching only from
 * matchOffset forward to avoid re-matching earlier occurrences.
 *
 * Returns index of match (relative to full buffer) or -1 on timeout.
 */
async function waitFor(
	session: ConsoleSessionState,
	pattern: string,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<number> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const idx = session.buffer.indexOf(pattern, session.matchOffset);
		if (idx >= 0) {
			session.matchOffset = idx + pattern.length;
			return idx;
		}
		if (session.streamDone) return -1;
		await Bun.sleep(POLL_INTERVAL_MS);
	}
	return -1;
}

/**
 * Wait for the LAST occurrence of `pattern` at or after `searchFrom` in the
 * buffer, determined by buffer stability.
 *
 * RouterOS's VT100 terminal redraws the prompt+command line during execution,
 * so the first "] > " after the command is just the redraw, not the output prompt.
 * We wait until no new data arrives for `stableMs` milliseconds, then return
 * the position of the LAST occurrence of `pattern`.
 */
async function waitForFinalPrompt(
	session: ConsoleSessionState,
	pattern: string,
	searchFrom: number,
	timeoutMs: number,
	stableMs = 150,
): Promise<number> {
	const FAST_POLL = 50;
	const deadline = Date.now() + timeoutMs;
	let lastGrowthAt = Date.now();
	let lastLen = session.buffer.length;
	let lastPromptAt = -1;

	while (Date.now() < deadline) {
		const currentLen = session.buffer.length;
		if (currentLen > lastLen) {
			lastLen = currentLen;
			lastGrowthAt = Date.now();
			const candidate = session.buffer.lastIndexOf(pattern);
			if (candidate >= searchFrom) lastPromptAt = candidate;
		}

		if (lastPromptAt >= 0 && Date.now() - lastGrowthAt >= stableMs) {
			session.matchOffset = lastPromptAt + pattern.length;
			return lastPromptAt;
		}

		if (session.streamDone) {
			if (lastPromptAt >= 0)
				session.matchOffset = lastPromptAt + pattern.length;
			return lastPromptAt;
		}

		await Bun.sleep(FAST_POLL);
	}
	return -1;
}

/**
 * Write data to the serial console.
 * Always uses \r (not \r\n) — critical for serial PTY correctness.
 */
function write(session: ConsoleSessionState, data: string): void {
	session.socket.write(data);
}

/**
 * Perform the login sequence if needed.
 *
 * Handles:
 * - Login: prompt → username + password
 * - [Y/n]: license prompt → decline with "n"
 * - new password> → skip with Ctrl-C
 *
 * Returns true if we reached a CLI prompt, false on timeout.
 */
async function ensureLoggedIn(
	session: ConsoleSessionState,
	user: string,
	password: string,
	timeoutMs: number,
): Promise<boolean> {
	// Send \r to solicit a response (prompt or login).
	// Re-poke every 2s — a fresh socket connection may not receive the login
	// prompt until the terminal is nudged (e.g. after a cold boot or reconnect).
	const POKE_INTERVAL_MS = 2_000;
	write(session, "\r");
	let lastPokeAt = Date.now();
	let hasQuit = false;

	const deadline = Date.now() + timeoutMs;

	// Wait for something recognizable
	while (Date.now() < deadline) {
		const remaining = deadline - Date.now();

		// If we see a CLI prompt, a previous session is still active on the serial console.
		// Log out once so we can log back in as the requested user. This handles the case
		// where consoleExec is called twice with different users — the terminal retains the
		// previous session after the socket closes (serial has no HUP concept).
		const promptIdx = session.buffer.indexOf(PROMPT_PATTERN, session.matchOffset);
		if (promptIdx >= 0) {
			session.matchOffset = promptIdx + PROMPT_PATTERN.length;
			if (!hasQuit) {
				hasQuit = true;
				write(session, "/quit\r");
				await Bun.sleep(500);
			}
			continue;
		}

		// Check for Login: prompt
		const loginIdx = session.buffer.indexOf("Login:", session.matchOffset);
		if (loginIdx >= 0) {
			session.matchOffset = loginIdx + "Login:".length;

			// Send username
			write(session, `${user}\r`);

			// Wait for Password:
			if (await waitFor(session, "Password:", Math.min(remaining, 10_000)) < 0) {
				return false;
			}

			// Send password
			write(session, `${password}\r`);

			// Now handle possible post-login prompts:
			// - License [Y/n] → "n\r"
			// - "new password>" → Ctrl-C to skip
			// - CLI prompt → done
			return await handlePostLogin(session, deadline - Date.now());
		}

		// Re-poke the terminal periodically — no response yet
		if (Date.now() - lastPokeAt >= POKE_INTERVAL_MS) {
			write(session, "\r");
			lastPokeAt = Date.now();
		}

		await Bun.sleep(POLL_INTERVAL_MS);
	}

	return false;
}

/**
 * Handle post-login prompts (license, password change) until CLI prompt.
 */
async function handlePostLogin(
	session: ConsoleSessionState,
	timeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		const remaining = deadline - Date.now();
		const buf = session.buffer;
		const offset = session.matchOffset;

		// Check for CLI prompt
		const promptIdx = buf.indexOf(PROMPT_PATTERN, offset);
		if (promptIdx >= 0) {
			session.matchOffset = promptIdx + PROMPT_PATTERN.length;
			return true;
		}

		// License prompt: [Y/n]:
		const licenseIdx = buf.indexOf("[Y/n]:", offset);
		if (licenseIdx >= 0) {
			session.matchOffset = licenseIdx + "[Y/n]:".length;
			write(session, "n\r");
			await Bun.sleep(POLL_INTERVAL_MS);
			continue;
		}

		// Password change prompt
		const pwIdx = buf.indexOf("new password>", offset);
		if (pwIdx >= 0) {
			session.matchOffset = pwIdx + "new password>".length;
			// Send Ctrl-C to skip password change
			write(session, "\x03");
			await Bun.sleep(POLL_INTERVAL_MS);
			continue;
		}

		if (session.streamDone) return false;
		await Bun.sleep(Math.min(POLL_INTERVAL_MS, remaining));
	}

	return false;
}

/**
 * Execute a RouterOS CLI command over the serial console.
 *
 * Connects to serial socket, ensures the session is logged in,
 * sends the command, and captures output between the command echo
 * and the next prompt.
 *
 * @param machineDir  Machine directory containing serial.sock
 * @param command     RouterOS CLI command to execute
 * @param user        Username for login (default: "admin")
 * @param password    Password for login (default: "")
 * @param timeoutMs   Overall timeout
 */
export async function consoleExec(
	machineDir: string,
	command: string,
	user: string = "admin",
	password: string = "",
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<{ output: string }> {
	const session = openSession(machineDir);

	try {
		// Wait for socket to connect
		await new Promise<void>((resolve, reject) => {
			session.socket.once("connect", resolve);
			session.socket.once("error", reject);
		});

		// Ensure logged in and at CLI prompt
		const loggedIn = await ensureLoggedIn(session, user, password, Math.min(timeoutMs, 15_000));
		if (!loggedIn) {
			throw new QuickCHRError(
				"BOOT_TIMEOUT",
				"Console exec: could not reach CLI prompt (login timed out)",
			);
		}

		// Record buffer position before sending command
		const preCommandOffset = session.buffer.length;
		// Advance matchOffset past any data already buffered after the login prompt.
		// waitFor must only match the prompt that appears AFTER our command — not a
		// pre-buffered "] > " from ANSI codes or OSC title sequences RouterOS emits.
		session.matchOffset = Math.max(session.matchOffset, preCommandOffset);

		// Send command
		write(session, `${command}\r`);

		// Wait for the FINAL prompt after the command completes.
		// RouterOS VT100 redraws the prompt+command line during execution, so the
		// first "] > " is a redraw, not the output prompt. waitForFinalPrompt uses
		// buffer stability (no new data for 150ms) to identify the last prompt.
		const promptFound = await waitForFinalPrompt(session, PROMPT_PATTERN, preCommandOffset, timeoutMs);
		if (promptFound < 0) {
			throw new QuickCHRError(
				"BOOT_TIMEOUT",
				`Console exec: no prompt after command (timed out after ${timeoutMs}ms)`,
			);
		}

		// Extract output: everything between our command and the next prompt.
		// promptFound points at "] > " — back up to the newline before the prompt
		// line so we don't include the "[admin@...] > " prefix in output.
		const lastNewline = session.buffer.lastIndexOf("\n", promptFound);
		const sliceEnd = lastNewline >= preCommandOffset ? lastNewline : promptFound;
		const rawOutput = session.buffer.slice(preCommandOffset, sliceEnd);

		// Clean up: strip ANSI, strip the command echo line, trim
		const cleaned = stripAnsi(rawOutput);
		const lines = cleaned.split(/\r?\n/);

		// First non-empty line(s) are the command echo — skip them.
		// The echo repeats back what we typed.
		let startIdx = 0;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!line) continue;
			const trimmed = line.trim();
			// Skip echo lines that contain our command text
			if (trimmed.includes(command.trim()) || trimmed === "") {
				startIdx = i + 1;
			} else {
				break;
			}
		}

		// Also strip trailing prompt fragments and empty lines
		let endIdx = lines.length;
		for (let i = lines.length - 1; i >= startIdx; i--) {
			const line = lines[i];
			if (!line) continue;
			const trimmed = line.trim();
			if (trimmed === "" || trimmed.endsWith(PROMPT_PATTERN.trim())) {
				endIdx = i;
			} else {
				break;
			}
		}

		const output = lines.slice(startIdx, endIdx).join("\n").trim();
		return { output };
	} finally {
		session.socket.destroy();
	}
}

/**
 * Check whether the serial console is responsive.
 *
 * Connects, sends \r, and checks for a CLI prompt or Login: prompt.
 * Returns "ready" if at CLI prompt, "login" if at login prompt, or false.
 */
export async function isConsoleReady(
	machineDir: string,
	timeoutMs: number = 5000,
): Promise<"ready" | "login" | false> {
	let session: ConsoleSessionState | undefined;
	try {
		session = openSession(machineDir);

		await new Promise<void>((resolve, reject) => {
			session?.socket.once("connect", resolve);
			session?.socket.once("error", reject);
		});

		// Send \r to solicit response
		write(session, "\r");

		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const buf = session.buffer;
			if (buf.indexOf(PROMPT_PATTERN, session.matchOffset) >= 0) {
				return "ready";
			}
			if (buf.indexOf("Login:", session.matchOffset) >= 0) {
				return "login";
			}
			if (session.streamDone) return false;
			await Bun.sleep(POLL_INTERVAL_MS);
		}

		return false;
	} catch {
		return false;
	} finally {
		session?.socket.destroy();
	}
}
