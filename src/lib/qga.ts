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
import type {
	QgaCommand,
	QgaFsFreezeStatus,
	QgaNetworkInterface,
	QgaOsInfo,
	QgaTimezone,
} from "./types.ts";
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

// ---------------------------------------------------------------------------
// Typed high-level helpers
// ---------------------------------------------------------------------------

/**
 * Internal helper — sync the QGA socket, send one command, return the
 * raw `return` value, then destroy the socket.
 */
async function qgaRun<T>(
	socketPath: string,
	command: QgaCommand,
	args?: Record<string, unknown>,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
	const { socket } = await qgaSync(socketPath, Math.min(timeoutMs, 5000));
	try {
		const payload: Record<string, unknown> = { execute: command };
		if (args) payload.arguments = args;
		return await sendAndReceive(socket, payload, timeoutMs) as T;
	} finally {
		socket.destroy();
	}
}

/**
 * Liveness probe — succeeds if QGA responds to guest-ping.
 * Throws on failure (use {@link qgaProbe} for a boolean version).
 */
export async function qgaPing(
	socketPath: string,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<void> {
	await qgaRun<unknown>(socketPath, "guest-ping", undefined, timeoutMs);
}

/**
 * OS information including RouterOS version and kernel build.
 *
 * Typical response:
 * ```json
 * { "id": "routeros", "name": "RouterOS", "pretty-name": "RouterOS 7.22",
 *   "kernel-release": "5.6.3-64", "machine": "x86_64" }
 * ```
 */
export async function qgaGetOsInfo(
	socketPath: string,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<QgaOsInfo> {
	const raw = await qgaRun<Record<string, unknown>>(socketPath, "guest-get-osinfo", undefined, timeoutMs);
	return {
		id: String(raw.id),
		name: String(raw.name),
		prettyName: String(raw["pretty-name"]),
		kernelRelease: String(raw["kernel-release"]),
		machine: String(raw.machine),
	};
}

/**
 * RouterOS identity name (equivalent to `/system identity get name`).
 */
export async function qgaGetHostName(
	socketPath: string,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string> {
	const raw = await qgaRun<Record<string, unknown>>(socketPath, "guest-get-host-name", undefined, timeoutMs);
	return String(raw["host-name"]);
}

/**
 * System time as nanoseconds since the Unix epoch.
 */
export async function qgaGetTime(
	socketPath: string,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<number> {
	return qgaRun<number>(socketPath, "guest-get-time", undefined, timeoutMs);
}

/**
 * Timezone configuration.  RouterOS CHR defaults to UTC (offset = 0).
 */
export async function qgaGetTimezone(
	socketPath: string,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<QgaTimezone> {
	const raw = await qgaRun<Record<string, unknown>>(socketPath, "guest-get-timezone", undefined, timeoutMs);
	return {
		offset: Number(raw.offset),
		zone: raw.zone ? String(raw.zone) : undefined,
	};
}

/**
 * Network interfaces as seen by RouterOS, including MAC addresses and IP
 * assignments.  Equivalent to `/ip address print` combined with
 * `/interface print`.
 */
export async function qgaGetNetworkInterfaces(
	socketPath: string,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<QgaNetworkInterface[]> {
	const raw = await qgaRun<Array<Record<string, unknown>>>(
		socketPath,
		"guest-network-get-interfaces",
		undefined,
		timeoutMs,
	);
	return raw.map((iface) => ({
		name: String(iface.name),
		mac: iface["hardware-address"] ? String(iface["hardware-address"]) : undefined,
		ipAddresses: (iface["ip-addresses"] as Array<Record<string, unknown>> ?? []).map((ip) => ({
			type: String(ip["ip-address-type"]) as "ipv4" | "ipv6",
			address: String(ip["ip-address"]),
			prefix: Number(ip.prefix),
		})),
	}));
}

/**
 * Filesystem freeze state.  Returns "thawed" (normal) or "frozen"
 * (held for snapshot consistency).
 */
export async function qgaFsFreezeStatus(
	socketPath: string,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<QgaFsFreezeStatus> {
	const status = await qgaRun<string>(socketPath, "guest-fsfreeze-status", undefined, timeoutMs);
	return status as QgaFsFreezeStatus;
}

/**
 * Freeze the RouterOS filesystem for consistent snapshot capture.
 * Returns the number of frozen filesystems.
 * Call {@link qgaFsFreezeThaw} immediately after capturing the snapshot.
 */
export async function qgaFsFreezeFreeze(
	socketPath: string,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<number> {
	return qgaRun<number>(socketPath, "guest-fsfreeze-freeze", undefined, timeoutMs);
}

/**
 * Thaw a previously frozen filesystem.
 * Returns the number of thawed filesystems.
 */
export async function qgaFsFreezeThaw(
	socketPath: string,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<number> {
	return qgaRun<number>(socketPath, "guest-fsfreeze-thaw", undefined, timeoutMs);
}

/**
 * Initiate a graceful shutdown of the RouterOS VM.
 *
 * The QEMU process will terminate within a few seconds. The QGA socket
 * may close before a response is received — this is expected and handled
 * gracefully.
 */
export async function qgaShutdown(
	socketPath: string,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<void> {
	const { socket } = await qgaSync(socketPath, Math.min(timeoutMs, 5000));
	try {
		// guest-shutdown may close the socket before sending a response. Ignore errors.
		await sendAndReceive(socket, { execute: "guest-shutdown" }, timeoutMs).catch(() => {});
	} finally {
		socket.destroy();
	}
}

/**
 * Write text content to a flat RouterOS file via the guest agent.
 *
 * **Path constraints (RouterOS QGA quirk):** Only flat filenames are accepted —
 * no directory separators, no disk prefixes (`flash/`, `disk1/`), no Unix
 * absolute paths.  Example valid names: `"backup.rsc"`, `"config.txt"`.
 *
 * Files written here are visible in RouterOS `/file print` and can be
 * executed with `/import`.
 *
 * `guest-file-close` may return an empty response (protocol quirk) —
 * this is handled gracefully; the write still succeeds.
 */
export async function qgaFileWrite(
	socketPath: string,
	filename: string,
	content: string,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<void> {
	const { socket } = await qgaSync(socketPath, Math.min(timeoutMs, 5000));
	try {
		const handle = await sendAndReceive(
			socket,
			{ execute: "guest-file-open", arguments: { path: filename, mode: "w" } },
			timeoutMs,
		) as number;

		await sendAndReceive(
			socket,
			{ execute: "guest-file-write", arguments: { handle, "buf-b64": btoa(content) } },
			timeoutMs,
		);

		// guest-file-close often returns empty response — ignore timeout
		await sendAndReceive(
			socket,
			{ execute: "guest-file-close", arguments: { handle } },
			2000,
		).catch(() => {});
	} finally {
		socket.destroy();
	}
}

/**
 * Read text content from a flat RouterOS file via the guest agent.
 *
 * See {@link qgaFileWrite} for path format constraints.
 * Maximum file size: 1 MiB.
 */
export async function qgaFileRead(
	socketPath: string,
	filename: string,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string> {
	const { socket } = await qgaSync(socketPath, Math.min(timeoutMs, 5000));
	try {
		const handle = await sendAndReceive(
			socket,
			{ execute: "guest-file-open", arguments: { path: filename, mode: "r" } },
			timeoutMs,
		) as number;

		const readResult = await sendAndReceive(
			socket,
			{ execute: "guest-file-read", arguments: { handle, count: 1_048_576 } },
			timeoutMs,
		) as Record<string, unknown>;

		const content = readResult["buf-b64"] ? atob(readResult["buf-b64"] as string) : "";

		// guest-file-close often returns empty response — ignore timeout
		await sendAndReceive(
			socket,
			{ execute: "guest-file-close", arguments: { handle } },
			2000,
		).catch(() => {});

		return content;
	} finally {
		socket.destroy();
	}
}
