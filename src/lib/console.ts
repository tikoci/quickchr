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

import { connect, type Socket } from "node:net";
import { QuickCHRError } from "./types.ts";
import { channelEndpoint, channelFileExists, channelPath } from "./channels.ts";

/** Default timeout for console operations. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Interval for polling the buffer in waitFor(). */
const POLL_INTERVAL_MS = 250;

/**
 * What one *fresh* serial login costs, for callers that must budget for it.
 *
 * A login is not a round-trip — it is dominated by RouterOS, not by us.
 * Measured 2026-07-31 on 7.23.2 / x86 / HVF with a raw socket and timestamped
 * receives (tikoci/quickchr#69, bite B10 of #110):
 *
 *   banner → `Login:`              10–25 ms
 *   username → `Password:`         54–56 ms
 *   password → license `[Y/n]:`    **10,184 ms**   ← the whole cost
 *   full fresh `consoleExec()`     11,364 / 11,360 ms
 *   `consoleExec()` on an already-open session   306 ms
 *
 * So a budget sized on the ~0.3 s round-trip figure is ~40× short of what the
 * first call needs, and a caller that divides such a budget across credential
 * candidates can never complete even one. That is exactly what made
 * `captureGuestSnapshot()` report `consoleReachable: false` against provably
 * healthy guests. Anything that logs in must budget from this constant, not
 * from the round-trip cost.
 *
 * 15 s is the measured 11.4 s plus ~30% margin; TCG and cross-arch guests are
 * slower still, which is why callers stack it rather than treat it as a cap.
 */
export const CONSOLE_LOGIN_COST_MS = 15_000;

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
function openSession(machineDir: string, portBase?: number): ConsoleSessionState {
	const socketPath = channelPath(machineDir, "serial");
	if (!channelFileExists(socketPath)) {
		throw new QuickCHRError(
			"MACHINE_STOPPED",
			"Serial socket not found — is the machine running in background mode?",
		);
	}

	const endpoint = channelEndpoint(machineDir, "serial", portBase);
	const socket = typeof endpoint === "string"
		? connect({ path: endpoint })
		: connect(endpoint.port, endpoint.host);
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
 * Ceiling on the quiet period the fallback prompt terminator waits for.
 *
 * This is no longer the normal way a command reply ends — {@link makeSentinel}
 * is — so it is sized for safety rather than speed, and does not need to scale
 * with the accelerator. The old flat 150 ms *was* the normal path, and that is
 * exactly what let a prompt **redraw** terminate a slow large reply (#109): the
 * two biggest guest-snapshot queries came back empty on a loaded TCG guest while
 * every small one succeeded.
 */
const FALLBACK_PROMPT_STABLE_MS = 2_000;

/** Floor, so a very small `timeoutMs` cannot reduce the window to nothing. */
const MIN_PROMPT_STABLE_MS = 250;

/**
 * The quiet period to require before the fallback prompt may terminate a reply.
 *
 * Derived from the caller's budget rather than fixed: a caller passing less than
 * ~2 s would otherwise never reach the fallback at all, and an unframed but
 * *complete* reply would surface as a `BOOT_TIMEOUT` instead of `framed: false`.
 * A small fraction leaves the rest of the budget for the reply itself. The
 * window is only a secondary guard now — {@link isTrailingPrompt} already
 * rejects a redraw structurally, whatever the timing.
 */
function promptStableWindow(timeoutMs: number): number {
	return Math.min(FALLBACK_PROMPT_STABLE_MS, Math.max(MIN_PROMPT_STABLE_MS, Math.floor(timeoutMs / 8)));
}

/** True when `pattern` at `idx` is the last meaningful thing in the buffer.
 *
 * The redraw that broke #109 is "prompt + repainted command", so the redraw
 * prompt always has the command text after it. Requiring the prompt to sit at
 * the end of the buffer therefore rejects a redraw outright, independently of
 * any timing window. Trailing ANSI and whitespace are ignored — RouterOS paints
 * the prompt with color codes and terminal queries around it. */
function isTrailingPrompt(buffer: string, idx: number, pattern: string): boolean {
	return stripAnsi(buffer.slice(idx + pattern.length)).trim() === "";
}

/** How a command's reply ended. */
type ReplyEnd =
	/** The sentinel arrived — the reply is complete by construction. */
	| { kind: "sentinel"; index: number }
	/** No sentinel; a trailing, stable prompt terminated it instead. */
	| { kind: "prompt"; index: number };

/**
 * Build the end-of-reply sentinel.
 *
 * The marker is assembled **in the guest** from three string literals, so the
 * echoed command line contains the expression but never the contiguous marker
 * text. That is what makes "the marker appeared" mean "the payload is complete"
 * rather than "the command was echoed".
 *
 * It is sent as a **separate console line**, not chained with `;`. Measured on
 * 7.21.5: `/bogus print; :put ("QC" . "END" . "e1")` prints the syntax error and
 * **never runs the second statement**, and the same holds for a runtime error
 * (`/ip/address add address=nonsense; …`). A `;` chain would therefore lose the
 * terminator on exactly the replies that carry an error message. Two `\r`-
 * terminated lines are two separate console inputs, so the second one still runs.
 */
function makeSentinel(): { command: string; marker: string; nonce: string } {
	const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
	return {
		command: `:put ("QCHR" . "${nonce}" . "END")`,
		marker: `QCHR${nonce}END`,
		nonce,
	};
}

/**
 * Wait for a command's reply to end — by sentinel, or failing that by a prompt
 * that is both trailing and stable.
 *
 * Both terminators are watched in **one** loop on purpose. Waiting out the
 * sentinel first and only then starting a prompt wait would spend the entire
 * budget before the fallback got a chance, turning every unframed reply into a
 * timeout instead of a slower success.
 *
 * Returns null if neither terminator arrives in time.
 */
async function waitForReplyEnd(
	session: ConsoleSessionState,
	marker: string,
	pattern: string,
	searchFrom: number,
	timeoutMs: number,
	stableMs = promptStableWindow(timeoutMs),
): Promise<ReplyEnd | null> {
	const FAST_POLL = 50;
	const deadline = Date.now() + timeoutMs;
	let lastGrowthAt = Date.now();
	let lastLen = session.buffer.length;

	const trailingPrompt = (): number => {
		const candidate = session.buffer.lastIndexOf(pattern);
		if (candidate < searchFrom) return -1;
		return isTrailingPrompt(session.buffer, candidate, pattern) ? candidate : -1;
	};

	for (;;) {
		const sentinelAt = session.buffer.indexOf(marker, searchFrom);
		if (sentinelAt >= 0) {
			session.matchOffset = sentinelAt + marker.length;
			return { kind: "sentinel", index: sentinelAt };
		}

		const currentLen = session.buffer.length;
		if (currentLen > lastLen) {
			lastLen = currentLen;
			lastGrowthAt = Date.now();
		}

		const promptAt = trailingPrompt();
		const quiet = Date.now() - lastGrowthAt >= stableMs;
		if (promptAt >= 0 && (quiet || session.streamDone)) {
			session.matchOffset = promptAt + pattern.length;
			return { kind: "prompt", index: promptAt };
		}
		if (session.streamDone) return null;
		if (Date.now() >= deadline) return null;

		await Bun.sleep(FAST_POLL);
	}
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

		// If we see a CLI prompt, check whether we're already logged in as the right user.
		// The prompt format is "[username@identity] > " — extract the username portion.
		// If it matches the requested user, proceed directly without re-logging in.
		// If it differs (previous session left open from a prior consoleExec call), log out
		// once and re-authenticate as the correct user.  Serial has no HUP concept, so the
		// previous session persists across socket reconnects.
		const promptIdx = session.buffer.indexOf(PROMPT_PATTERN, session.matchOffset);
		if (promptIdx >= 0) {
			const beforePrompt = session.buffer.slice(0, promptIdx);
			const bracketIdx = beforePrompt.lastIndexOf("[");
			const atIdx = bracketIdx >= 0 ? beforePrompt.indexOf("@", bracketIdx) : -1;
			const currentUser =
				bracketIdx >= 0 && atIdx > bracketIdx ? beforePrompt.slice(bracketIdx + 1, atIdx) : null;

			session.matchOffset = promptIdx + PROMPT_PATTERN.length;

			if (currentUser === user) {
				// Already logged in as the correct user — proceed directly to command execution.
				return true;
			}

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
 * Reduce the raw post-command console text to just the command's output.
 *
 * Measured shape of a RouterOS 7.21.5 serial reply (x86/HVF, QEMU 11.0.3):
 *
 * ```text
 * <cmd>\r[admin@MikroTik] > <cmd>\r\n   echo — ONE physical line, bare-\r redraws
 * \r<output>\r\n                        output, wrapped at the terminal width
 * \r\r\r\r[admin@MikroTik] >     \r[admin@MikroTik] > <sentinel echo>\r\n
 * \rQCHR…END\r\n                        the sentinel; the caller cuts before it
 * ```
 *
 * Two structural rules do the work, and neither relies on matching the command
 * text throughout — a long command is **horizontally scrolled** in the redraw
 * (`<ss=nonsense; :put (…)`), so its opening characters are not present there:
 *
 *  - the sentinel echo carries this call's `nonce`, and shares a physical line
 *    with the prompt redraw ahead of it, so dropping nonce-bearing lines removes
 *    both at once;
 *  - the command echo is the first physical line, and is dropped only when it
 *    actually looks like one (it carries a prompt redraw, or starts with the
 *    command) — so a reply with no echo cannot lose its first output line.
 */
export function extractOutput(raw: string, command: string, nonce?: string): string {
	const lines = stripAnsi(raw)
		.split(/\r?\n/)
		.filter((l) => nonce === undefined || !l.includes(nonce));

	const cmdPrefix = command.trim().slice(0, 24);
	const first = lines[0];
	let startIdx =
		first !== undefined &&
		(first.includes(PROMPT_PATTERN) || (cmdPrefix !== "" && first.trimStart().startsWith(cmdPrefix)))
			? 1
			: 0;
	while (startIdx < lines.length && (lines[startIdx] ?? "").trim() === "") startIdx++;

	// Trailing prompt fragments and blank lines are the redraw after the reply.
	let endIdx = lines.length;
	for (let i = lines.length - 1; i >= startIdx; i--) {
		const trimmed = (lines[i] ?? "").trim();
		if (trimmed === "" || trimmed.endsWith(PROMPT_PATTERN.trim())) endIdx = i;
		else break;
	}

	return lines.slice(startIdx, endIdx).join("\n").trim();
}

/** Result of one console command.
 *
 * `framed` says the reply was delimited by the end-of-reply sentinel — i.e. the
 * reader saw the whole reply. When it is false the reply was terminated by the
 * fallback prompt heuristic instead, so an empty `output` means "could not frame
 * the reply", not "the guest printed nothing" (#109). */
export interface ConsoleExecResult {
	output: string;
	framed: boolean;
}

/**
 * Execute a RouterOS CLI command over the serial console.
 *
 * Connects to serial socket, ensures the session is logged in, sends the command
 * followed by an end-of-reply sentinel, and captures the output between them.
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
	portBase?: number,
): Promise<ConsoleExecResult> {
	const session = openSession(machineDir, portBase);

	try {
		// Wait for socket to connect
		await new Promise<void>((resolve, reject) => {
			session.socket.once("connect", resolve);
			session.socket.once("error", (err: NodeJS.ErrnoException) => {
				if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
					reject(new QuickCHRError("MACHINE_STOPPED", "Serial channel not found — is the machine running in background mode?"));
				} else {
					reject(err);
				}
			});
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

		// Send the command and the end-of-reply sentinel as two console lines in one
		// write. The sentinel is what terminates the reply; the prompt is only a
		// fallback (see makeSentinel / waitForReplyEnd).
		const sentinel = makeSentinel();
		write(session, `${command}\r${sentinel.command}\r`);

		const end = await waitForReplyEnd(session, sentinel.marker, PROMPT_PATTERN, preCommandOffset, timeoutMs);
		if (end === null) {
			throw new QuickCHRError(
				"BOOT_TIMEOUT",
				`Console exec: no end-of-reply sentinel and no prompt after command (timed out after ${timeoutMs}ms)`,
			);
		}
		const framed = end.kind === "sentinel";

		// Cut back to the newline that starts the terminator's own line, so neither
		// the marker nor the "[admin@…] > " prefix lands in the output.
		const lineStart = session.buffer.lastIndexOf("\n", end.index);
		const sliceEnd = lineStart >= preCommandOffset ? lineStart : end.index;

		const rawOutput = session.buffer.slice(preCommandOffset, sliceEnd);

		const output = extractOutput(rawOutput, command, sentinel.nonce);
		return { output, framed };
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
	portBase?: number,
): Promise<"ready" | "login" | false> {
	let session: ConsoleSessionState | undefined;
	try {
		session = openSession(machineDir, portBase);

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
