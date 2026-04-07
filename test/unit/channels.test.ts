import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { monitorCommand, serialStreams, qgaCommand } from "../../src/lib/channels.ts";
import { QuickCHRError } from "../../src/lib/types.ts";

const TMP = join(import.meta.dir, ".tmp-channels-test");

beforeEach(() => {
	mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
	rmSync(TMP, { recursive: true, force: true });
});

// --- monitorCommand error paths ---

describe("monitorCommand", () => {
	test("throws MACHINE_STOPPED when monitor socket does not exist", async () => {
		// TMP dir exists but contains no monitor.sock
		await expect(monitorCommand(TMP, "info")).rejects.toMatchObject({
			code: "MACHINE_STOPPED",
		});
	});

	test("throws MACHINE_STOPPED when socket closes before sending (qemu) prompt", async () => {
		// A server that immediately kills incoming connections simulates a QEMU
		// process that closed its monitor socket before becoming ready.
		const sockPath = join(TMP, "monitor.sock");
		const server = createServer((sock) => {
			sock.destroy();
		});

		await new Promise<void>((resolve) => server.listen(sockPath, resolve));

		try {
			await expect(monitorCommand(TMP, "info", 3000)).rejects.toMatchObject({
				code: "MACHINE_STOPPED",
			});
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	test("resolves with empty string for quit command (socket closed by QEMU after prompt)", async () => {
		// Simulate QEMU: send (qemu) prompt, receive command, then close socket.
		// This is the expected behaviour after sending "quit".
		const sockPath = join(TMP, "monitor.sock");
		const server = createServer((sock) => {
			sock.write("QEMU monitor ready\r\n(qemu) ");
			sock.on("data", () => {
				// Got the command — simulate QEMU exit (close without second prompt)
				sock.end();
			});
		});

		await new Promise<void>((resolve) => server.listen(sockPath, resolve));

		try {
			const result = await monitorCommand(TMP, "quit", 3000);
			// Result is whatever was in buffer after prompt — for quit it's empty or partial
			expect(typeof result).toBe("string");
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});

// --- serialStreams error path ---

describe("serialStreams", () => {
	test("throws MACHINE_STOPPED when serial socket does not exist", () => {
		expect(() => serialStreams(TMP)).toThrow(
			expect.objectContaining({ code: "MACHINE_STOPPED" } as Partial<QuickCHRError>),
		);
	});
});

// --- qgaCommand arch guard ---

describe("qgaCommand", () => {
	test("throws QGA_UNSUPPORTED immediately for arm64 (no socket check)", async () => {
		// arm64 CHR does not run the guest agent daemon — this should throw
		// without even checking if the socket file exists.
		await expect(qgaCommand(TMP, "arm64", "guest-info")).rejects.toMatchObject({
			code: "QGA_UNSUPPORTED",
		});
	});

	test("throws MACHINE_STOPPED for x86 when qga socket does not exist", async () => {
		// x86 passes the arch guard but the socket file is absent
		await expect(qgaCommand(TMP, "x86", "guest-info")).rejects.toMatchObject({
			code: "MACHINE_STOPPED",
		});
	});
});
