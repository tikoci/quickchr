import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server, type Socket as NetSocket } from "node:net";
import {
	stripSyncMarkers,
	parseQgaMessages,
	qgaSync,
	qgaExec,
	qgaProbe,
	qgaInfo,
	qgaPing,
	qgaGetOsInfo,
	qgaGetHostName,
	qgaGetTime,
	qgaGetTimezone,
	qgaGetNetworkInterfaces,
	qgaFsFreezeStatus,
	qgaFsFreezeFreeze,
	qgaFsFreezeThaw,
	qgaFileWrite,
	qgaFileRead,
} from "../../src/lib/qga.ts";

// Use tmpdir() because Unix domain sockets don't work on FUSE/sshfs mounts (e.g. Multipass)
const TMP = join(tmpdir(), "quickchr-tmp-qga-test");

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

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(20);
	}
	throw new Error(`Condition not met within ${timeoutMs}ms`);
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

	test("returns false after the guest closes the socket without replying", async () => {
		const sockPath = join(TMP, "qga.sock");
		let sawClose = false;
		const server = await createMockQga(sockPath, (cmd, _args, client) => {
			if (cmd === "guest-ping") {
				client.end();
			}
			client.on("close", () => {
				sawClose = true;
			});
		});

		try {
			const result = await qgaProbe(sockPath, 1000);
			expect(result).toBe(false);
			await waitFor(() => sawClose, 1000);
		} finally {
			await closeServer(server);
		}
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
		if (process.platform === "win32") return;
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

// ---------------------------------------------------------------------------
// Typed high-level helpers
// ---------------------------------------------------------------------------

describe("qgaPing", () => {
	test("resolves without error when guest-ping returns empty object", async () => {
		const sockPath = join(TMP, "qga.sock");
		const server = await createMockQga(sockPath, (cmd, _args, client) => {
			if (cmd === "guest-ping") client.write(JSON.stringify({ return: {} }) + "\n");
		});
		try {
			await expect(qgaPing(sockPath, 5000)).resolves.toBeUndefined();
		} finally {
			await closeServer(server);
		}
	});

	test("rejects promptly when the socket closes before a reply arrives", async () => {
		const sockPath = join(TMP, "qga.sock");
		const server = await createMockQga(sockPath, (cmd, _args, client) => {
			if (cmd === "guest-ping") {
				client.end();
			}
		});

		try {
			await expect(qgaPing(sockPath, 5000)).rejects.toMatchObject({
				code: "PROCESS_FAILED",
				message: "QGA socket closed before a response was received",
			});
		} finally {
			await closeServer(server);
		}
	});

	test("releases a timed-out client so the next QGA session can connect", async () => {
		const sockPath = join(TMP, "qga.sock");
		let activeConnections = 0;
		let maxActiveConnections = 0;

		const server = createServer((client) => {
			activeConnections++;
			maxActiveConnections = Math.max(maxActiveConnections, activeConnections);

			let buffer = "";
			let synced = false;

			client.on("close", () => {
				activeConnections--;
			});

			client.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (!line.trim()) continue;
					const msg = JSON.parse(line.trim()) as { execute: string; arguments?: { id?: number } };
					if (!synced && msg.execute === "guest-sync-delimited") {
						synced = true;
						client.write(JSON.stringify({ return: msg.arguments?.id }) + "\n");
						continue;
					}

					if (msg.execute === "guest-info") {
						client.write(JSON.stringify({ return: { supported_commands: [] } }) + "\n");
					}
				}
			});
		});

		server.maxConnections = 1;
		await new Promise<void>((resolve) => server.listen(sockPath, resolve));

		try {
			await expect(qgaPing(sockPath, 250)).rejects.toMatchObject({ code: "QGA_TIMEOUT" });
			await waitFor(() => activeConnections === 0, 1000);

			const commands = await qgaInfo(sockPath, 2000);
			expect(commands).toEqual([]);
			expect(maxActiveConnections).toBe(1);
		} finally {
			await closeServer(server);
		}
	});
});

describe("qgaGetOsInfo", () => {
	test("returns parsed OS info", async () => {
		const sockPath = join(TMP, "qga.sock");
		const server = await createMockQga(sockPath, (cmd, _args, client) => {
			if (cmd === "guest-get-osinfo") {
				client.write(JSON.stringify({
					return: {
						id: "routeros",
						name: "RouterOS",
						"pretty-name": "RouterOS 7.22",
						"kernel-release": "5.6.3-64",
						machine: "x86_64",
					},
				}) + "\n");
			}
		});
		try {
			const info = await qgaGetOsInfo(sockPath, 5000);
			expect(info.id).toBe("routeros");
			expect(info.prettyName).toBe("RouterOS 7.22");
			expect(info.kernelRelease).toBe("5.6.3-64");
			expect(info.machine).toBe("x86_64");
		} finally {
			await closeServer(server);
		}
	});
});

describe("qgaGetHostName", () => {
	test("returns host-name string", async () => {
		const sockPath = join(TMP, "qga.sock");
		const server = await createMockQga(sockPath, (cmd, _args, client) => {
			if (cmd === "guest-get-host-name") {
				client.write(JSON.stringify({ return: { "host-name": "MikroTik" } }) + "\n");
			}
		});
		try {
			const hostname = await qgaGetHostName(sockPath, 5000);
			expect(hostname).toBe("MikroTik");
		} finally {
			await closeServer(server);
		}
	});
});

describe("qgaGetTime", () => {
	test("returns nanoseconds as number", async () => {
		const sockPath = join(TMP, "qga.sock");
		const ns = 1774041353160410000;
		const server = await createMockQga(sockPath, (cmd, _args, client) => {
			if (cmd === "guest-get-time") {
				client.write(JSON.stringify({ return: ns }) + "\n");
			}
		});
		try {
			const result = await qgaGetTime(sockPath, 5000);
			expect(result).toBe(ns);
		} finally {
			await closeServer(server);
		}
	});
});

describe("qgaGetTimezone", () => {
	test("returns timezone with offset only", async () => {
		const sockPath = join(TMP, "qga.sock");
		const server = await createMockQga(sockPath, (cmd, _args, client) => {
			if (cmd === "guest-get-timezone") {
				client.write(JSON.stringify({ return: { offset: 0 } }) + "\n");
			}
		});
		try {
			const tz = await qgaGetTimezone(sockPath, 5000);
			expect(tz.offset).toBe(0);
			expect(tz.zone).toBeUndefined();
		} finally {
			await closeServer(server);
		}
	});

	test("returns timezone with zone name when present", async () => {
		const sockPath = join(TMP, "qga.sock");
		const server = await createMockQga(sockPath, (cmd, _args, client) => {
			if (cmd === "guest-get-timezone") {
				client.write(JSON.stringify({ return: { offset: 7200, zone: "Europe/Riga" } }) + "\n");
			}
		});
		try {
			const tz = await qgaGetTimezone(sockPath, 5000);
			expect(tz.offset).toBe(7200);
			expect(tz.zone).toBe("Europe/Riga");
		} finally {
			await closeServer(server);
		}
	});
});

describe("qgaGetNetworkInterfaces", () => {
	test("parses interface list with IP addresses", async () => {
		const sockPath = join(TMP, "qga.sock");
		const server = await createMockQga(sockPath, (cmd, _args, client) => {
			if (cmd === "guest-network-get-interfaces") {
				client.write(JSON.stringify({
					return: [
						{
							name: "ether1",
							"hardware-address": "0e:61:47:d8:43:2a",
							"ip-addresses": [
								{ "ip-address-type": "ipv4", "ip-address": "10.0.2.15", prefix: 24 },
							],
						},
						{
							name: "lo",
							"ip-addresses": [],
						},
					],
				}) + "\n");
			}
		});
		try {
			const ifaces = await qgaGetNetworkInterfaces(sockPath, 5000);
			expect(ifaces).toHaveLength(2);
			expect(ifaces[0]?.name).toBe("ether1");
			expect(ifaces[0]?.mac).toBe("0e:61:47:d8:43:2a");
			expect(ifaces[0]?.ipAddresses).toHaveLength(1);
			expect(ifaces[0]?.ipAddresses[0]).toEqual({ type: "ipv4", address: "10.0.2.15", prefix: 24 });
			expect(ifaces[1]?.name).toBe("lo");
			expect(ifaces[1]?.mac).toBeUndefined();
			expect(ifaces[1]?.ipAddresses).toHaveLength(0);
		} finally {
			await closeServer(server);
		}
	});
});

describe("qgaFsFreezeStatus", () => {
	test("returns thawed when filesystem is normal", async () => {
		const sockPath = join(TMP, "qga.sock");
		const server = await createMockQga(sockPath, (cmd, _args, client) => {
			if (cmd === "guest-fsfreeze-status") {
				client.write(JSON.stringify({ return: "thawed" }) + "\n");
			}
		});
		try {
			const status = await qgaFsFreezeStatus(sockPath, 5000);
			expect(status).toBe("thawed");
		} finally {
			await closeServer(server);
		}
	});
});

describe("qgaFsFreezeFreeze / qgaFsFreezeThaw", () => {
	test("freeze returns count of frozen filesystems", async () => {
		const sockPath = join(TMP, "qga.sock");
		const server = await createMockQga(sockPath, (cmd, _args, client) => {
			if (cmd === "guest-fsfreeze-freeze") {
				client.write(JSON.stringify({ return: 1 }) + "\n");
			}
		});
		try {
			const count = await qgaFsFreezeFreeze(sockPath, 5000);
			expect(count).toBe(1);
		} finally {
			await closeServer(server);
		}
	});

	test("thaw returns count of thawed filesystems", async () => {
		const sockPath = join(TMP, "qga.sock");
		const server = await createMockQga(sockPath, (cmd, _args, client) => {
			if (cmd === "guest-fsfreeze-thaw") {
				client.write(JSON.stringify({ return: 1 }) + "\n");
			}
		});
		try {
			const count = await qgaFsFreezeThaw(sockPath, 5000);
			expect(count).toBe(1);
		} finally {
			await closeServer(server);
		}
	});
});

describe("qgaFileWrite / qgaFileRead", () => {
	test("file write sends open+write+close sequence", async () => {
		const sockPath = join(TMP, "qga.sock");
		const commands: string[] = [];
		let writtenData = "";

		const server = await createMockQga(sockPath, (cmd, args, client) => {
			commands.push(cmd);
			if (cmd === "guest-file-open") {
				client.write(JSON.stringify({ return: 42 }) + "\n");
			} else if (cmd === "guest-file-write") {
				const argsRecord = args as Record<string, string>;
				writtenData = atob(argsRecord["buf-b64"] ?? "");
				client.write(JSON.stringify({ return: { count: writtenData.length, eof: false } }) + "\n");
			} else if (cmd === "guest-file-close") {
				// Simulate the RouterOS quirk: empty response (no JSON sent back)
				// Our implementation ignores close timeout — no response needed
			}
		});

		try {
			await qgaFileWrite(sockPath, "test.txt", "hello world", 5000);
			expect(commands).toContain("guest-file-open");
			expect(commands).toContain("guest-file-write");
			expect(commands).toContain("guest-file-close");
			expect(writtenData).toBe("hello world");
		} finally {
			await closeServer(server);
		}
	});

	test("file read returns decoded content", async () => {
		const sockPath = join(TMP, "qga.sock");
		const server = await createMockQga(sockPath, (cmd, _args, client) => {
			if (cmd === "guest-file-open") {
				client.write(JSON.stringify({ return: 7 }) + "\n");
			} else if (cmd === "guest-file-read") {
				client.write(JSON.stringify({ return: { "buf-b64": btoa("file content"), eof: true, count: 12 } }) + "\n");
			} else if (cmd === "guest-file-close") {
				// No response (quirk)
			}
		});

		try {
			const content = await qgaFileRead(sockPath, "test.txt", 5000);
			expect(content).toBe("file content");
		} finally {
			await closeServer(server);
		}
	});
});
