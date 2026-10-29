import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import {
	monitorCommand,
	serialStreams,
	qgaCommand,
	MONITOR_FAST_QUERY_TIMEOUT_MS,
	MONITOR_SAVEVM_TIMEOUT_MS,
	MONITOR_LOADVM_TIMEOUT_MS,
	MONITOR_DELVM_TIMEOUT_MS,
} from "../../src/lib/channels.ts";
import type { QuickCHRError } from "../../src/lib/types.ts";

// Use tmpdir() because Unix domain sockets don't work on FUSE/sshfs mounts (e.g. Multipass)
const TMP = join(tmpdir(), "quickchr-tmp-channels-test");

beforeEach(() => {
	mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
	rmSync(TMP, { recursive: true, force: true });
});

// --- monitorCommand error paths ---

describe("monitorCommand", () => {
	test("throws MACHINE_STOPPED when monitor socket does not exist", async () => {
		// TMP dir exists but contains no monitor.sock (Unix) / named pipe (Windows).
		// On Unix: channelFileExists returns false → immediate throw.
		// On Windows: channelFileExists always returns true; net.connect() gets ENOENT
		// from the missing named pipe → error handler maps to MACHINE_STOPPED.
		await expect(monitorCommand(TMP, "info")).rejects.toMatchObject({
			code: "MACHINE_STOPPED",
		});
	});

	// Mock-server tests below bind a server to a Unix domain socket path.
	// On Windows, channelPath() resolves to a named pipe (\\.\pipe\...) — a completely
	// different address — so the client never reaches the mock server.
	// These subtests are skipped on Windows; see test/unit/windows-channels.test.ts
	// for Windows named-pipe equivalents.

	test("throws MACHINE_STOPPED when socket closes before sending (qemu) prompt", async () => {
		if (process.platform === "win32") return; // named-pipe mock not supported here
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

	test("timeout error carries phase timings and byte count (issue #80 evidence)", async () => {
		if (process.platform === "win32") return; // named-pipe mock not supported here
		// Simulate a long-running savevm: QEMU greets, accepts the command,
		// streams a partial echo, then goes quiet until the client budget fires.
		// This is the exact shape that separated #80's hypothesis 2 (channel
		// wedged) from hypothesis 3 (operation genuinely long).
		const sockPath = join(TMP, "monitor.sock");
		const server = createServer((sock) => {
			sock.write("QEMU 11.1.1 monitor\r\n(qemu) ");
			sock.on("data", () => {
				sock.write("savevm base"); // partial echo, no closing prompt — then silence
			});
		});

		await new Promise<void>((resolve) => server.listen(sockPath, resolve));

		try {
			const err = await monitorCommand(TMP, "savevm baseline", 300).then(
				() => null,
				(e: unknown) => e as QuickCHRError & Error,
			);
			expect(err).not.toBeNull();
			expect(err?.code).toBe("BOOT_TIMEOUT");
			const msg = String(err?.message);
			expect(msg).toContain('timed out after 300ms: "savevm baseline"');
			for (const phase of ["connect=", "first-byte=", "prompt=", "command-written=", "response-first-byte=", "bytes="]) {
				expect(msg).toContain(phase);
			}
			expect(msg).not.toContain("never"); // every phase was reached
			expect(Number(msg.match(/bytes=(\d+)/)?.[1])).toBeGreaterThan(0);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	test("resolves with empty string for quit command (socket closed by QEMU after prompt)", async () => {
		if (process.platform === "win32") return; // named-pipe mock not supported here
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

// --- monitor budget magnitudes (issue #80) ---
// The wiring half of this contract lives in snapshot-budgets.test.ts: it
// proves the snapshot ops pass these named constants rather than `undefined`
// or a hardcoded literal. This half pins the constants' real magnitudes.

describe("monitor budgets", () => {
	test("fast-query default stays at 5s; snapshot budgets sit well above it", () => {
		expect(MONITOR_FAST_QUERY_TIMEOUT_MS).toBe(5000);
		expect(MONITOR_SAVEVM_TIMEOUT_MS).toBe(120_000);
		expect(MONITOR_LOADVM_TIMEOUT_MS).toBe(120_000);
		expect(MONITOR_DELVM_TIMEOUT_MS).toBe(60_000);
	});
});

// --- serialStreams error path ---

describe("serialStreams", () => {
	test("throws MACHINE_STOPPED when serial socket does not exist", () => {
		// On Unix: existsSync check → synchronous throw.
		// On Windows: named pipes aren't filesystem entries, so channelFileExists()
		// returns true and streams are returned — the error is deferred to connect.
		// Skip the synchronous-throw assertion on Windows.
		if (process.platform === "win32") return;
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
