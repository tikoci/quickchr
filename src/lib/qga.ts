/**
 * QEMU Guest Agent (QGA) protocol implementation.
 *
 * QGA communicates over a virtio-serial channel using newline-delimited
 * JSON messages. RouterOS ships a custom QGA implementation (not stock
 * qemu-ga) that supports guest-exec with `input-data` (base64-encoded
 * RouterOS script), file operations, and system queries.
 *
 * x86 only — ARM64 CHR does not start the QGA userspace daemon.
 *
 * Protocol notes (from mikropkl Lab testing):
 * - First message must be `guest-sync-delimited` to flush stale data
 * - 0xFF bytes may appear as sync markers — strip before JSON parsing
 * - `guest-exec` is async: returns PID, poll `guest-exec-status` for output
 * - All data fields (input-data, out-data, err-data) are base64-encoded
 * - `guest-file-close` may return empty response (quirk) — handle gracefully
 */

import { connect, type Socket } from "node:net";
import { QuickCHRError } from "./types.ts";

/** Result of a QGA guest-exec command. */
export interface QgaExecResult {
	exitcode: number;
	stdout: string;
	stderr: string;
}

/** Info about a single QGA-supported command. */
export interface QgaCommandInfo {
	name: string;
	enabled: boolean;
}

/** Default timeout for QGA operations. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Polling interval for guest-exec-status checks. */
const EXEC_POLL_INTERVAL_MS = 500;

/** Maximum number of guest-exec-status polls before giving up. */
const EXEC_MAX_POLLS = 40; // 20s at 500ms intervals

/**
 * Strip 0xFF sync marker bytes from a buffer.
 * RouterOS QGA may emit these as delimiters between messages.
 */
export function stripSyncMarkers(data: string): string {
	return data.replace(/\xff/g, "");
}

/**
 * Parse newline-delimited JSON messages from a raw buffer.
 * Returns parsed messages and any remaining incomplete data.
 */
export function parseQgaMessages(buffer: string): { messages: unknown[]; remainder: string } {
	const cleaned = stripSyncMarkers(buffer);
	const lines = cleaned.split("\n");
	const remainder = lines.pop() || "";
	const messages: unknown[] = [];

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			messages.push(JSON.parse(trimmed));
		} catch {
			// Incomplete or malformed JSON — skip
		}
	}

	return { messages, remainder };
}

/**
 * Connect to a QGA Unix socket with timeout.
 * Returns the connected socket or throws.
 */
function connectSocket(socketPath: string, timeoutMs: number): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			socket.destroy();
			reject(new QuickCHRError("BOOT_TIMEOUT", `QGA socket connect timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		const socket = connect({ path: socketPath });

		socket.on("connect", () => {
			clearTimeout(timeout);
			resolve(socket);
		});

		socket.on("error", (err) => {
			clearTimeout(timeout);
			reject(new QuickCHRError("PROCESS_FAILED", `QGA connection failed: ${err.message}`));
		});
	});
}

/**
 * Send a JSON-RPC command and wait for a single response.
 * Handles 0xFF marker stripping and newline-delimited parsing.
 */
function sendAndReceive(
	socket: Socket,
	payload: Record<string, unknown>,
	timeoutMs: number,
): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			reject(new QuickCHRError("BOOT_TIMEOUT", "QGA command timed out"));
		}, timeoutMs);

		let buffer = "";

		const onData = (data: Buffer) => {
			buffer += data.toString();
			const { messages, remainder } = parseQgaMessages(buffer);
			buffer = remainder;

			for (const msg of messages) {
				clearTimeout(timeout);
				socket.removeListener("data", onData);
				const response = msg as Record<string, unknown>;
				if (response.error) {
					const err = response.error as Record<string, unknown>;
					reject(new QuickCHRError(
						"PROCESS_FAILED",
						`QGA error: ${err.desc || JSON.stringify(err)}`,
					));
				} else {
					resolve(response.return);
				}
				return;
			}
		};

		socket.on("data", onData);
		socket.write(JSON.stringify(payload) + "\n");
	});
}

/**
 * Perform guest-sync-delimited handshake.
 *
 * This must be the first operation on each QGA connection to flush any
 * stale data in the virtio-serial buffer. Retries once on failure
 * (stale data from a previous session may cause the first sync to fail).
 */
export async function qgaSync(
	socketPath: string,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<{ socket: Socket; syncId: number }> {
	const socket = await connectSocket(socketPath, timeoutMs);
	const syncId = Date.now() % 1_000_000_000; // Keep it within safe integer range

	try {
		const result = await sendAndReceive(
			socket,
			{ execute: "guest-sync-delimited", arguments: { id: syncId } },
			timeoutMs,
		);

		if (result !== syncId) {
			// Stale data — retry once
			const retrySyncId = (syncId + 1) % 1_000_000_000;
			const retryResult = await sendAndReceive(
				socket,
				{ execute: "guest-sync-delimited", arguments: { id: retrySyncId } },
				timeoutMs,
			);
			if (retryResult !== retrySyncId) {
				socket.destroy();
				throw new QuickCHRError("PROCESS_FAILED", "QGA sync failed after retry — unexpected sync ID");
			}
			return { socket, syncId: retrySyncId };
		}

		return { socket, syncId };
	} catch (err) {
		socket.destroy();
		throw err;
	}
}

/**
 * Execute a RouterOS script via QGA guest-exec.
 *
 * The script is base64-encoded and sent as `input-data` (RouterOS QGA
 * does not support the `path` field — it only accepts scripts via input-data).
 * Execution is async: guest-exec returns a PID, then we poll
 * guest-exec-status until the process exits.
 *
 * @param socketPath  Path to the QGA Unix socket
 * @param script      RouterOS CLI script to execute
 * @param timeoutMs   Overall timeout for the operation
 */
export async function qgaExec(
	socketPath: string,
	script: string,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<QgaExecResult> {
	const { socket } = await qgaSync(socketPath, Math.min(timeoutMs, 5000));

	try {
		// Send guest-exec with base64-encoded script
		const inputData = btoa(script);
		const execResult = await sendAndReceive(
			socket,
			{
				execute: "guest-exec",
				arguments: {
					"input-data": inputData,
					"capture-output": true,
				},
			},
			timeoutMs,
		) as Record<string, unknown>;

		const pid = execResult.pid as number;
		if (typeof pid !== "number") {
			throw new QuickCHRError("PROCESS_FAILED", `QGA guest-exec did not return a PID: ${JSON.stringify(execResult)}`);
		}

		// Poll guest-exec-status until exited
		const pollTimeout = timeoutMs;
		const deadline = Date.now() + pollTimeout;
		for (let i = 0; i < EXEC_MAX_POLLS && Date.now() < deadline; i++) {
			const status = await sendAndReceive(
				socket,
				{ execute: "guest-exec-status", arguments: { pid } },
				Math.min(5000, deadline - Date.now()),
			) as Record<string, unknown>;

			if (status.exited) {
				const exitcode = (status.exitcode as number) ?? 0;
				const stdout = status["out-data"]
					? atob(status["out-data"] as string)
					: "";
				const stderr = status["err-data"]
					? atob(status["err-data"] as string)
					: "";
				return { exitcode, stdout, stderr };
			}

			await Bun.sleep(EXEC_POLL_INTERVAL_MS);
		}

		throw new QuickCHRError("BOOT_TIMEOUT", `QGA guest-exec PID ${pid} did not exit within ${timeoutMs}ms`);
	} finally {
		socket.destroy();
	}
}

/**
 * Probe whether QGA is responding on the given socket.
 * Returns true if guest-ping succeeds after sync, false otherwise.
 */
export async function qgaProbe(
	socketPath: string,
	timeoutMs: number = 5000,
): Promise<boolean> {
	try {
		const { socket } = await qgaSync(socketPath, timeoutMs);
		try {
			await sendAndReceive(
				socket,
				{ execute: "guest-ping" },
				timeoutMs,
			);
			return true;
		} finally {
			socket.destroy();
		}
	} catch {
		return false;
	}
}

/**
 * Query QGA for supported commands via guest-info.
 * Returns the list of supported command names and their enabled status.
 */
export async function qgaInfo(
	socketPath: string,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<QgaCommandInfo[]> {
	const { socket } = await qgaSync(socketPath, timeoutMs);
	try {
		const result = await sendAndReceive(
			socket,
			{ execute: "guest-info" },
			timeoutMs,
		) as Record<string, unknown>;

		const commands = result.supported_commands as Array<Record<string, unknown>> | undefined;
		if (!Array.isArray(commands)) {
			return [];
		}

		return commands.map((cmd) => ({
			name: String(cmd.name),
			enabled: Boolean(cmd.enabled),
		}));
	} finally {
		socket.destroy();
	}
}
