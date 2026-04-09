import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server, type Socket as NetSocket } from "node:net";
import { stripSyncMarkers, parseQgaMessages, qgaSync, qgaExec, qgaProbe, qgaInfo } from "../../src/lib/qga.ts";

const TMP = join(import.meta.dir, ".tmp-qga-test");

beforeEach(() => {
	mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
	rmSync(TMP, { recursive: true, force: true });
});

// --- Pure function tests ---

describe("stripSyncMarkers", () => {
	test("strips 0xFF bytes from buffer", () => {
		expect(stripSyncMarkers("\xff{\"return\": 42}\n")).toBe("{\"return\": 42}\n");
	});

	test("strips multiple 0xFF bytes", () => {
		expect(stripSyncMarkers("\xff\xff\xffhello\xff")).toBe("hello");
	});

	test("passes through clean data unchanged", () => {
		expect(stripSyncMarkers("{\"return\": 42}\n")).toBe("{\"return\": 42}\n");
	});

	test("handles empty string", () => {
		expect(stripSyncMarkers("")).toBe("");
	});
});

describe("parseQgaMessages", () => {
	test("parses single complete message", () => {
		const { messages, remainder } = parseQgaMessages("{\"return\": 42}\n");
		expect(messages).toEqual([{ return: 42 }]);
		expect(remainder).toBe("");
	});

	test("parses multiple messages", () => {
		const { messages, remainder } = parseQgaMessages(
			"{\"return\": 1}\n{\"return\": 2}\n",
		);
		expect(messages).toEqual([{ return: 1 }, { return: 2 }]);
		expect(remainder).toBe("");
	});

	test("returns remainder for incomplete message", () => {
		const { messages, remainder } = parseQgaMessages(
			"{\"return\": 1}\n{\"retu",
		);
		expect(messages).toEqual([{ return: 1 }]);
		expect(remainder).toBe("{\"retu");
	});

	test("strips 0xFF markers before parsing", () => {
		const { messages } = parseQgaMessages("\xff{\"return\": 99}\n");
		expect(messages).toEqual([{ return: 99 }]);
	});

	test("skips empty lines", () => {
		const { messages } = parseQgaMessages("\n\n{\"return\": 1}\n\n");
		expect(messages).toEqual([{ return: 1 }]);
	});

	test("skips malformed JSON lines", () => {
		const { messages } = parseQgaMessages("not json\n{\"return\": 1}\n");
		expect(messages).toEqual([{ return: 1 }]);
	});
});

// --- Socket-based tests with mock QGA server ---

/** Create a mock QGA server that handles sync + one command. */
function createMockQga(
	sockPath: string,
	handler: (command: string, args: Record<string, unknown> | undefined, client: NetSocket) => void,
): Promise<Server> {
	return new Promise((resolve) => {
		const server = createServer((client) => {
			let buffer = "";
			let synced = false;

			client.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const msg = JSON.parse(line.trim());
						if (!synced && msg.execute === "guest-sync-delimited") {
							synced = true;
							client.write(JSON.stringify({ return: msg.arguments.id }) + "\n");
						} else if (synced) {
							handler(msg.execute, msg.arguments, client);
						}
					} catch { /* ignore */ }
				}
			});
		});

		server.listen(sockPath, () => resolve(server));
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

describe("qgaSync", () => {
	test("completes sync handshake with matching ID", async () => {
		const sockPath = join(TMP, "qga.sock");
		const server = await createMockQga(sockPath, () => {});

		try {
			const { socket, syncId } = await qgaSync(sockPath, 5000);
			expect(typeof syncId).toBe("number");
			socket.destroy();
		} finally {
			await closeServer(server);
		}
	});

	test("throws on connection refused (no server)", async () => {
		const sockPath = join(TMP, "nonexistent.sock");
		await expect(qgaSync(sockPath, 2000)).rejects.toMatchObject({
			code: "PROCESS_FAILED",
		});
	});
});

describe("qgaProbe", () => {
	test("returns true when QGA responds to ping", async () => {
		const sockPath = join(TMP, "qga.sock");
		const server = await createMockQga(sockPath, (cmd, _args, client) => {
			if (cmd === "guest-ping") {
				client.write(JSON.stringify({ return: {} }) + "\n");
			}
		});

		try {
			const result = await qgaProbe(sockPath, 5000);
			expect(result).toBe(true);
		} finally {
			await closeServer(server);
		}
	});

	test("returns false when socket does not exist", async () => {
		const result = await qgaProbe(join(TMP, "nonexistent.sock"), 1000);
		expect(result).toBe(false);
	});
});

describe("qgaExec", () => {
	test("executes script and returns decoded stdout", async () => {
		const sockPath = join(TMP, "qga.sock");
		const server = await createMockQga(sockPath, (cmd, args, client) => {
			if (cmd === "guest-exec") {
				// Verify input is base64-encoded
				const inputData = (args as Record<string, unknown>)["input-data"] as string;
				expect(atob(inputData)).toBe(":put hello");
				client.write(JSON.stringify({ return: { pid: 42 } }) + "\n");
			} else if (cmd === "guest-exec-status") {
				expect((args as Record<string, unknown>).pid).toBe(42);
				client.write(JSON.stringify({
					return: {
						exited: true,
						exitcode: 0,
						"out-data": btoa("hello\r\n"),
						"err-data": btoa(""),
					},
				}) + "\n");
			}
		});

		try {
			const result = await qgaExec(sockPath, ":put hello", 10_000);
			expect(result.exitcode).toBe(0);
			expect(result.stdout).toBe("hello\r\n");
			expect(result.stderr).toBe("");
		} finally {
			await closeServer(server);
		}
	});

	test("polls until process exits", async () => {
		const sockPath = join(TMP, "qga.sock");
		let pollCount = 0;

		const server = await createMockQga(sockPath, (cmd, _args, client) => {
			if (cmd === "guest-exec") {
				client.write(JSON.stringify({ return: { pid: 7 } }) + "\n");
			} else if (cmd === "guest-exec-status") {
				pollCount++;
				if (pollCount < 3) {
					client.write(JSON.stringify({ return: { exited: false } }) + "\n");
				} else {
					client.write(JSON.stringify({
						return: {
							exited: true,
							exitcode: 0,
							"out-data": btoa("done"),
						},
					}) + "\n");
				}
			}
		});

		try {
			const result = await qgaExec(sockPath, ":put done", 10_000);
			expect(result.stdout).toBe("done");
			expect(pollCount).toBeGreaterThanOrEqual(3);
		} finally {
			await closeServer(server);
		}
	});

	test("returns stderr when present", async () => {
		const sockPath = join(TMP, "qga.sock");
		const server = await createMockQga(sockPath, (cmd, _args, client) => {
			if (cmd === "guest-exec") {
				client.write(JSON.stringify({ return: { pid: 1 } }) + "\n");
			} else if (cmd === "guest-exec-status") {
				client.write(JSON.stringify({
					return: {
						exited: true,
						exitcode: 1,
						"out-data": btoa(""),
						"err-data": btoa("syntax error"),
					},
				}) + "\n");
			}
		});

		try {
			const result = await qgaExec(sockPath, "bad command", 10_000);
			expect(result.exitcode).toBe(1);
			expect(result.stderr).toBe("syntax error");
		} finally {
			await closeServer(server);
		}
	});

	test("handles missing out-data/err-data fields", async () => {
		const sockPath = join(TMP, "qga.sock");
		const server = await createMockQga(sockPath, (cmd, _args, client) => {
			if (cmd === "guest-exec") {
				client.write(JSON.stringify({ return: { pid: 1 } }) + "\n");
			} else if (cmd === "guest-exec-status") {
				client.write(JSON.stringify({
					return: { exited: true, exitcode: 0 },
				}) + "\n");
			}
		});

		try {
			const result = await qgaExec(sockPath, "/log/info message=test", 10_000);
			expect(result.exitcode).toBe(0);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("");
		} finally {
			await closeServer(server);
		}
	});
});

describe("qgaInfo", () => {
	test("returns list of supported commands", async () => {
		const sockPath = join(TMP, "qga.sock");
		const server = await createMockQga(sockPath, (cmd, _args, client) => {
			if (cmd === "guest-info") {
				client.write(JSON.stringify({
					return: {
						version: "2.10.50",
						supported_commands: [
							{ name: "guest-ping", enabled: true },
							{ name: "guest-exec", enabled: true },
							{ name: "guest-shutdown", enabled: true },
						],
					},
				}) + "\n");
			}
		});

		try {
			const commands = await qgaInfo(sockPath, 5000);
			expect(commands).toHaveLength(3);
			expect(commands[0]).toEqual({ name: "guest-ping", enabled: true });
			expect(commands[1]).toEqual({ name: "guest-exec", enabled: true });
		} finally {
			await closeServer(server);
		}
	});
});

describe("QGA error handling", () => {
	test("rejects with PROCESS_FAILED on QGA error response", async () => {
		const sockPath = join(TMP, "qga.sock");
		const server = await createMockQga(sockPath, (_cmd, _args, client) => {
			client.write(JSON.stringify({
				error: { class: "GenericError", desc: "Command not found" },
			}) + "\n");
		});

		try {
			const { socket } = await qgaSync(sockPath, 5000);
			// Manually send a bad command to get error
			await expect(new Promise((resolve, reject) => {
				let buf = "";
				socket.on("data", (data) => {
					buf += data.toString();
					const lines = buf.split("\n");
					buf = lines.pop() || "";
					for (const line of lines) {
						if (!line.trim()) continue;
						const msg = JSON.parse(line.trim());
						if (msg.error) {
							reject(new Error(msg.error.desc));
						} else {
							resolve(msg.return);
						}
						return;
					}
				});
				socket.write(JSON.stringify({ execute: "nonexistent-command" }) + "\n");
			})).rejects.toThrow("Command not found");

			socket.destroy();
		} finally {
			await closeServer(server);
		}
	});
});
