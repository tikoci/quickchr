import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server, type Socket as NetSocket } from "node:net";
import { stripAnsi, consoleExec, isConsoleReady } from "../../src/lib/console.ts";

// Use tmpdir() because Unix domain sockets don't work on FUSE/sshfs mounts (e.g. Multipass)
const TMP = join(tmpdir(), "quickchr-tmp-console-test");

beforeEach(() => {
	mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
	rmSync(TMP, { recursive: true, force: true });
});

// --- Pure function tests ---

describe("stripAnsi", () => {
	test("strips CSI color sequences", () => {
		expect(stripAnsi("\x1b[32mhello\x1b[0m")).toBe("hello");
	});

	test("strips multiple escape sequences", () => {
		expect(stripAnsi("\x1b[1m\x1b[4mBold Underline\x1b[0m")).toBe("Bold Underline");
	});

	test("strips cursor movement codes", () => {
		expect(stripAnsi("\x1b[2J\x1b[Htest")).toBe("test");
	});

	test("passes plain text through unchanged", () => {
		expect(stripAnsi("hello world")).toBe("hello world");
	});

	test("handles empty string", () => {
		expect(stripAnsi("")).toBe("");
	});

	test("strips OSC sequences", () => {
		expect(stripAnsi("\x1b]0;title\x07 content")).toBe(" content");
	});
});

// --- Socket-based tests with mock serial console ---

/**
 * Create a mock serial console server.
 * The handler receives client connections and can simulate RouterOS console behavior.
 */
function createMockSerial(
	machineDir: string,
	handler: (client: NetSocket) => void,
): Promise<Server> {
	return new Promise((resolve) => {
		const sockPath = join(machineDir, "serial.sock");
		const server = createServer(handler);
		server.listen(sockPath, () => resolve(server));
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

describe("consoleExec", () => {
	test("executes command on already-logged-in console", async () => {
		if (process.platform === "win32") return;
		const server = await createMockSerial(TMP, (client) => {
			let buffer = "";
			client.on("data", (data) => {
				buffer += data.toString();
				// First \r solicits the prompt
				if (buffer === "\r") {
					client.write("[admin@MikroTik] > ");
				}
				// Command received: `:put "hello"\r`
				if (buffer.includes(":put")) {
					client.write(`:put "hello"\r\n`);
					client.write("hello\r\n");
					client.write("[admin@MikroTik] > ");
				}
			});
		});

		try {
			const result = await consoleExec(TMP, ':put "hello"', "admin", "", 10_000);
			expect(result.output).toBe("hello");
		} finally {
			await closeServer(server);
		}
	});

	test("handles login sequence then executes command", async () => {
		if (process.platform === "win32") return;
		const server = await createMockSerial(TMP, (client) => {
			let state = "init";
			client.on("data", (data) => {
				const text = data.toString();

				if (state === "init" && text === "\r") {
					state = "login-sent";
					client.write("\r\nMikroTik Login: ");
				} else if (state === "login-sent" && text.includes("admin")) {
					state = "password";
					client.write("admin\r\nPassword: ");
				} else if (state === "password") {
					state = "logged-in";
					client.write("\r\n\r\n[admin@MikroTik] > ");
				} else if (state === "logged-in" && text.includes(":put")) {
					client.write(`:put "test"\r\nhello-from-login\r\n[admin@MikroTik] > `);
				}
			});
		});

		try {
			const result = await consoleExec(TMP, ':put "test"', "admin", "", 15_000);
			expect(result.output).toBe("hello-from-login");
		} finally {
			await closeServer(server);
		}
	});

	test("handles CHR identity prompt (7.23+ format)", async () => {
		if (process.platform === "win32") return;
		const server = await createMockSerial(TMP, (client) => {
			let gotPrompt = false;
			client.on("data", (data) => {
				const text = data.toString();
				if (!gotPrompt && text === "\r") {
					gotPrompt = true;
					client.write("[admin@CHR] > ");
				} else if (text.includes(":put")) {
					client.write(`:put "version"\r\n7.23rc1\r\n[admin@CHR] > `);
				}
			});
		});

		try {
			const result = await consoleExec(TMP, ':put "version"', "admin", "", 10_000);
			expect(result.output).toBe("7.23rc1");
		} finally {
			await closeServer(server);
		}
	});

	test("throws MACHINE_STOPPED when serial socket is missing", async () => {
		await expect(
			consoleExec("/nonexistent/path", ":put test"),
		).rejects.toMatchObject({ code: "MACHINE_STOPPED" });
	});

	test("handles multi-line output", async () => {
		if (process.platform === "win32") return;
		const server = await createMockSerial(TMP, (client) => {
			let gotPrompt = false;
			client.on("data", (data) => {
				const text = data.toString();
				if (!gotPrompt && text === "\r") {
					gotPrompt = true;
					client.write("[admin@MikroTik] > ");
				} else if (text.includes("/interface")) {
					client.write(`/interface/print\r\n`);
					client.write("Flags: R - RUNNING\r\n");
					client.write("Columns: NAME, TYPE\r\n");
					client.write("#  NAME    TYPE\r\n");
					client.write("0  ether1  ether\r\n");
					client.write("[admin@MikroTik] > ");
				}
			});
		});

		try {
			const result = await consoleExec(TMP, "/interface/print", "admin", "", 10_000);
			expect(result.output).toContain("ether1");
			expect(result.output).toContain("ether");
			// Multiple lines present
			expect(result.output.split("\n").length).toBeGreaterThanOrEqual(3);
		} finally {
			await closeServer(server);
		}
	});

	test("uses \\r not \\r\\n for writes", async () => {
		if (process.platform === "win32") return;
		const writes: string[] = [];
		const server = await createMockSerial(TMP, (client) => {
			let gotPrompt = false;
			client.on("data", (data) => {
				writes.push(data.toString());
				const text = data.toString();
				if (!gotPrompt && text === "\r") {
					gotPrompt = true;
					client.write("[admin@MikroTik] > ");
				} else if (text.includes(":put")) {
					client.write(`:put "x"\r\nresult\r\n[admin@MikroTik] > `);
				}
			});
		});

		try {
			await consoleExec(TMP, ':put "x"', "admin", "", 10_000);
			// Check that no write contains \r\n — all should be \r only
			for (const w of writes) {
				expect(w).not.toContain("\r\n");
			}
			// The command write should end with \r
			const cmdWrite = writes.find((w) => w.includes(":put"));
			expect(cmdWrite).toBeDefined();
			expect(cmdWrite?.endsWith("\r")).toBe(true);
		} finally {
			await closeServer(server);
		}
	});
});

describe("isConsoleReady", () => {
	test("returns 'ready' when prompt is shown", async () => {
		if (process.platform === "win32") return;
		const server = await createMockSerial(TMP, (client) => {
			client.on("data", () => {
				client.write("[admin@MikroTik] > ");
			});
		});

		try {
			const result = await isConsoleReady(TMP, 5000);
			expect(result).toBe("ready");
		} finally {
			await closeServer(server);
		}
	});

	test("returns 'login' when Login: prompt is shown", async () => {
		if (process.platform === "win32") return;
		const server = await createMockSerial(TMP, (client) => {
			client.on("data", () => {
				client.write("\r\nMikroTik Login: ");
			});
		});

		try {
			const result = await isConsoleReady(TMP, 5000);
			expect(result).toBe("login");
		} finally {
			await closeServer(server);
		}
	});

	test("returns false when serial socket is missing", async () => {
		const result = await isConsoleReady("/nonexistent/path", 1000);
		expect(result).toBe(false);
	});
});
