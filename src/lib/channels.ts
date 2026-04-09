/**
 * Communication channels — QEMU monitor, serial console, QGA (QEMU Guest Agent).
 *
 * Uses Unix domain sockets stored in the machine directory.
 * QGA protocol implementation lives in qga.ts — this module provides
 * the high-level qgaCommand() wrapper with arch guards and path resolution.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { connect } from "node:net";
import type { Arch } from "./types.ts";
import { QuickCHRError } from "./types.ts";
import { qgaSync, qgaProbe } from "./qga.ts";

/** Send a command to the QEMU monitor via Unix socket and return the response. */
export async function monitorCommand(
	machineDir: string,
	command: string,
	timeoutMs: number = 5000,
): Promise<string> {
	const socketPath = join(machineDir, "monitor.sock");
	if (!existsSync(socketPath)) {
		throw new QuickCHRError(
			"MACHINE_STOPPED",
			"Monitor socket not found — is the machine running in background mode?",
		);
	}

	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			socket.destroy();
			reject(new QuickCHRError("BOOT_TIMEOUT", "Monitor command timed out"));
		}, timeoutMs);

		let buffer = "";
		let sentCommand = false;

		const socket = connect({ path: socketPath });

		socket.on("data", (data) => {
			buffer += data.toString();
			// Wait for the (qemu) prompt before sending command
			if (!sentCommand && buffer.includes("(qemu)")) {
				sentCommand = true;
				buffer = "";
				socket.write(command + "\n");
			} else if (sentCommand && buffer.includes("(qemu)")) {
				// Got response — strip the prompt
				clearTimeout(timeout);
				const response = buffer.replace(/\(qemu\)\s*/g, "").trim();
				socket.destroy();
				resolve(response);
			}
		});

		// When the socket closes after we've already sent the command, QEMU exited.
		// This is the normal outcome for `quit` — no further (qemu) prompt is sent.
		socket.on("close", () => {
			clearTimeout(timeout);
			if (sentCommand) {
				resolve(buffer.replace(/\(qemu\)\s*/g, "").trim());
			} else {
				reject(new QuickCHRError("MACHINE_STOPPED", "Monitor socket closed before command could be sent"));
			}
		});

		socket.on("error", (err) => {
			clearTimeout(timeout);
			reject(new QuickCHRError("PROCESS_FAILED", `Monitor connection failed: ${err.message}`));
		});
	});
}

/** Get a readable/writable stream pair for the serial console. */
export function serialStreams(machineDir: string): {
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<Uint8Array>;
} {
	const socketPath = join(machineDir, "serial.sock");
	if (!existsSync(socketPath)) {
		throw new QuickCHRError(
			"MACHINE_STOPPED",
			"Serial socket not found — is the machine running in background mode?",
		);
	}

	const socket = connect({ path: socketPath });

	const readable = new ReadableStream<Uint8Array>({
		start(controller) {
			socket.on("data", (chunk: Buffer) => {
				controller.enqueue(new Uint8Array(chunk));
			});
			socket.on("end", () => controller.close());
			socket.on("error", (err) => controller.error(err));
		},
		cancel() {
			socket.destroy();
		},
	});

	const writable = new WritableStream<Uint8Array>({
		write(chunk) {
			return new Promise((resolve, reject) => {
				socket.write(chunk, (err) => {
					if (err) reject(err);
					else resolve();
				});
			});
		},
		close() {
			socket.destroy();
		},
	});

	return { readable, writable };
}

/** Send a QGA (QEMU Guest Agent) command via Unix socket. x86 only.
 *  Delegates to qga.ts for protocol handling — this wrapper adds the
 *  arch guard and socket path resolution. */
export async function qgaCommand(
	machineDir: string,
	arch: Arch,
	command: string,
	args?: object,
	timeoutMs: number = 10000,
): Promise<unknown> {
	if (arch === "arm64") {
		throw new QuickCHRError(
			"QGA_UNSUPPORTED",
			"QEMU Guest Agent is not functional on ARM64 CHR (userspace daemon doesn't start)",
		);
	}

	const socketPath = join(machineDir, "qga.sock");
	if (!existsSync(socketPath)) {
		throw new QuickCHRError(
			"MACHINE_STOPPED",
			"QGA socket not found — is the machine running in background mode?",
		);
	}

	const { socket } = await qgaSync(socketPath, Math.min(timeoutMs, 5000));

	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			socket.destroy();
			reject(new QuickCHRError("BOOT_TIMEOUT", "QGA command timed out"));
		}, timeoutMs);

		let buffer = "";

		socket.on("data", (data) => {
			buffer += data.toString().replace(/\xff/g, "");
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";

			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const msg = JSON.parse(line.trim());
					clearTimeout(timeout);
					socket.destroy();
					if (msg.error) {
						reject(new QuickCHRError("PROCESS_FAILED", `QGA error: ${msg.error.desc || JSON.stringify(msg.error)}`));
					} else {
						resolve(msg.return);
					}
					return;
				} catch { /* partial JSON, wait for more */ }
			}
		});

		socket.on("error", (err) => {
			clearTimeout(timeout);
			reject(new QuickCHRError("PROCESS_FAILED", `QGA connection failed: ${err.message}`));
		});

		// Send the actual command now that sync completed
		const payload: Record<string, unknown> = { execute: command };
		if (args) payload.arguments = args;
		socket.write(JSON.stringify(payload) + "\n");
	});
}

/** Check whether QGA is available and responding for a machine. */
export function isQgaReady(
	machineDir: string,
	arch: Arch,
): Promise<boolean> {
	if (arch === "arm64") return Promise.resolve(false);

	const socketPath = join(machineDir, "qga.sock");
	if (!existsSync(socketPath)) return Promise.resolve(false);

	return qgaProbe(socketPath, 5000);
}
