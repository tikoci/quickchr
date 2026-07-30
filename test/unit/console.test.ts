import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server, type Socket as NetSocket } from "node:net";
// Nonces below are verbatim from live 7.21.5 captures — random strings, not vocabulary.
// cspell:ignore juey tljt gnr tupmemlevdf tzzzzzzzzzz
import { stripAnsi, consoleExec, extractOutput, isConsoleReady } from "../../src/lib/console.ts";

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

/**
 * These are verbatim `rawOutput` slices captured from a live CHR 7.21.5 (x86,
 * HVF, QEMU 11.0.3) while grounding #109 — not hand-written approximations. They
 * pin the two shapes the extractor has to survive: the ordinary echo-redraw, and
 * the **horizontally scrolled** redraw a long command produces, where the echo no
 * longer contains the start of the command (`<ss=nonsense; :put (…`).
 */
describe("extractOutput (captured RouterOS 7.21.5 wire shapes)", () => {
	const PAD = " ".repeat(60);

	test("ordinary reply: echo redraw, payload, sentinel echo", () => {
		const nonce = "ms7tl2juey6u0w";
		const raw =
			`:put "hello"\r[admin@MikroTik] > :put "hello"\r\n\rhello\r\n\r\r\r\r[admin@MikroTik] > ${PAD}` +
			`\r[admin@MikroTik] > :put ("QCHR" . "${nonce}" . "END")\r[admin@MikroTik] > :put ("QCHR" . "${nonce}" . "END")\r`;
		expect(extractOutput(raw, ':put "hello"', nonce)).toBe("hello");
	});

	test("error reply: the error text survives, the echo does not", () => {
		const nonce = "ms7tljt6yf2gnr";
		const raw =
			"/bogus/nope print\r[admin@MikroTik] > /bogus/nope print\r\n\rsyntax error (line 1 column 7)\r\n" +
			`\r\r\r\r[admin@MikroTik] > ${PAD}\r[admin@MikroTik] > :put ("QCHR" . "${nonce}" . "END")\r`;
		expect(extractOutput(raw, "/bogus/nope print", nonce)).toBe("syntax error (line 1 column 7)");
	});

	// A long command scrolls horizontally instead of wrapping, so the redraw drops
	// the command's opening characters. Matching the echo by command text leaked
	// three lines of it into the output; the structural rule does not.
	test("horizontally scrolled echo of a long command is not mistaken for output", () => {
		const nonce = "ms7tupmemlevdf";
		const cmd = '/ip/address add address=nonsense; :put ("CH" . "AIN" . "RAN")';
		const raw =
			'/ip/address add address=nonsense; :put ("CH" . "AIN" . "RAN"\r[admin@MikroTik] > ' +
			'/ip/address add address=nonsense; :put ("CH" . "AIN" . "RAN>\r<ss=nonsense; :put ("CH" . "AIN" . "RAN")' +
			`${PAD}\r<ss=nonsense; :put ("CH" . "AIN" . "RAN")\r<ss=nonsense; :put ("CH" . "AIN" . "RAN")\r\n` +
			`\rinvalid value for argument address\r\n\r\r\r\r[admin@MikroTik] > ${PAD}` +
			`\r[admin@MikroTik] > :put ("QCHR" . "${nonce}" . "END")\r`;
		expect(extractOutput(raw, cmd, nonce)).toBe("invalid value for argument address");
	});

	test("a command with no output yields an empty string, not prompt debris", () => {
		const nonce = "ms7tzzzzzzzzzz";
		const raw =
			`:put ""\r[admin@MikroTik] > :put ""\r\n\r\r\r\r[admin@MikroTik] > ${PAD}` +
			`\r[admin@MikroTik] > :put ("QCHR" . "${nonce}" . "END")\r`;
		expect(extractOutput(raw, ':put ""', nonce)).toBe("");
	});

	// A guest that does not echo must not lose its first output line.
	test("keeps the first line when there is no echo to strip", () => {
		expect(extractOutput("only-line\r\n", ":put x")).toBe("only-line");
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

/**
 * The sentinel `consoleExec` appends: `:put ("QCHR" . "<nonce>" . "END")`.
 * A mock guest has to evaluate it the way RouterOS does — concatenate the three
 * literals — because the whole point of building the marker in the guest is that
 * the echoed expression never contains the contiguous marker text.
 */
const SENTINEL_RE = /:put \("QCHR" \. "([a-z0-9]+)" \. "END"\)/;

function sentinelMarker(text: string): string | null {
	const m = text.match(SENTINEL_RE);
	return m?.[1] ? `QCHR${m[1]}END` : null;
}

const PROMPT = "[admin@MikroTik] > ";

/**
 * Emulate the measured RouterOS 7.21.5 reply shape (see extractOutput): the
 * command echo redrawn on one physical line, then the payload, then a prompt
 * redraw carrying the next line's echo.
 */
function routerOsReply(echo: string, payload: string, prompt = PROMPT): string {
	const body = payload === "" ? "" : `\r${payload}\r\n`;
	return `${echo}\r${prompt}${echo}\r\n${body}\r\r\r\r${prompt}${" ".repeat(40)}\r${prompt}`;
}

/**
 * A mock RouterOS console that answers each `\r`-terminated line the way the real
 * one does, including evaluating the sentinel expression.
 *
 * `payloadDelayMs` reproduces #109: the prompt redraw lands first, the guest then
 * goes quiet for longer than the old flat 150 ms stability window, and only then
 * does the payload arrive.
 */
function createRouterOsMock(
	machineDir: string,
	respond: (cmd: string) => string,
	opts: {
		payloadDelayMs?: number;
		dropSentinel?: boolean;
		identity?: string;
		requireLogin?: boolean;
		onWrite?: (chunk: string) => void;
	} = {},
): Promise<Server> {
	const prompt = `[admin@${opts.identity ?? "MikroTik"}] > `;
	return createMockSerial(machineDir, (client) => {
		// consoleExec destroys its socket the moment the reply is framed, which can
		// land mid-`drain()`. Without this, the resulting EPIPE surfaces as an
		// unhandled 'error' event and takes down the whole test process.
		client.on("error", () => { /* peer went away — expected */ });
		let pending = "";
		let greeted = false;
		let stage: "login" | "password" | "shell" = opts.requireLogin ? "login" : "shell";
		const queue: string[] = [];
		let draining = false;

		const drain = async () => {
			if (draining) return;
			draining = true;
			while (queue.length > 0) {
				const line = queue.shift() as string;
				const marker = sentinelMarker(line);
				if (marker !== null) {
					client.write(routerOsReply(line, opts.dropSentinel ? "" : marker, prompt));
					continue;
				}
				const payload = respond(line);
				if (opts.payloadDelayMs) {
					client.write(`${line}\r${prompt}${line}\r\n`);
					await Bun.sleep(opts.payloadDelayMs);
					if (client.destroyed) continue;
					client.write(`\r${payload}\r\n\r\r\r\r${prompt}${" ".repeat(40)}\r${prompt}`);
				} else {
					client.write(routerOsReply(line, payload, prompt));
				}
			}
			draining = false;
		};

		client.on("data", (data) => {
			opts.onWrite?.(data.toString());
			pending += data.toString();
			const parts = pending.split("\r");
			pending = parts.pop() ?? "";
			for (const line of parts) {
				if (stage === "login") {
					if (line === "") {
						client.write("\r\nMikroTik Login: ");
					} else {
						stage = "password";
						client.write(`${line}\r\nPassword: `);
					}
					continue;
				}
				if (stage === "password") {
					stage = "shell";
					greeted = true;
					client.write(`\r\n\r\n${prompt}`);
					continue;
				}
				if (line === "") {
					if (!greeted) {
						greeted = true;
						client.write(prompt);
					}
					continue;
				}
				queue.push(line);
			}
			void drain();
		});
	});
}

describe("consoleExec", () => {
	test("executes command on already-logged-in console", async () => {
		if (process.platform === "win32") return;
		const server = await createRouterOsMock(TMP, () => "hello");

		try {
			const result = await consoleExec(TMP, ':put "hello"', "admin", "", 10_000);
			expect(result.output).toBe("hello");
			expect(result.framed).toBe(true);
		} finally {
			await closeServer(server);
		}
	});

	/**
	 * #109 anchor. The guest pauses 400 ms between the prompt redraw and the
	 * payload — longer than the 150 ms stability window the reader used to
	 * terminate on, which made the two largest guest-snapshot queries return
	 * `"empty console reply"` while every small one succeeded. The reply here is
	 * ~1.4 KB, the measured size of the `/ip/service` payload that failed.
	 */
	test("a large reply that arrives after the prompt redraw is not lost", async () => {
		if (process.platform === "win32") return;
		const payload = JSON.stringify(
			Array.from({ length: 12 }, (_, i) => ({ ".id": `*${i}`, name: `svc${i}`, port: 80 + i, proto: "tcp" })),
		);
		expect(payload.length).toBeGreaterThan(500);

		const server = await createRouterOsMock(TMP, () => payload, { payloadDelayMs: 400 });
		try {
			const result = await consoleExec(TMP, ":put [:serialize to=json [/ip/service print as-value]]", "admin", "", 10_000);
			expect(result.framed).toBe(true);
			expect(result.output).toBe(payload);
		} finally {
			await closeServer(server);
		}
	});

	// A reply the reader could not delimit must not be reported as a successful
	// empty one — that ambiguity is what blanked #79's decisive field.
	test("falls back to the prompt when the sentinel never arrives, and says so", async () => {
		if (process.platform === "win32") return;
		const server = await createRouterOsMock(TMP, () => "still-here", { dropSentinel: true });
		try {
			// 4 s budget => a 500 ms stable window (timeoutMs/8), so this exercises the
			// fallback without paying the 2 s production ceiling. A caller passing a
			// budget below that ceiling must still get `framed:false`, not a timeout.
			const result = await consoleExec(TMP, ':put "x"', "admin", "", 4_000);
			expect(result.framed).toBe(false);
			expect(result.output).toBe("still-here");
		} finally {
			await closeServer(server);
		}
	});

	test("a genuinely empty reply is framed, not a reader failure", async () => {
		if (process.platform === "win32") return;
		const server = await createRouterOsMock(TMP, () => "");
		try {
			const result = await consoleExec(TMP, ':put ""', "admin", "", 10_000);
			expect(result.framed).toBe(true);
			expect(result.output).toBe("");
		} finally {
			await closeServer(server);
		}
	});

	// The sentinel is sent as its own console line precisely so it survives an
	// error. Measured on 7.21.5: a `;` chain aborts and never runs the second
	// statement, for both syntax and runtime errors.
	test("returns the error text when the command fails", async () => {
		if (process.platform === "win32") return;
		const server = await createRouterOsMock(TMP, () => "syntax error (line 1 column 7)");
		try {
			const result = await consoleExec(TMP, "/bogus/nope print", "admin", "", 10_000);
			expect(result.framed).toBe(true);
			expect(result.output).toBe("syntax error (line 1 column 7)");
		} finally {
			await closeServer(server);
		}
	});

	test("handles login sequence then executes command", async () => {
		if (process.platform === "win32") return;
		const server = await createRouterOsMock(TMP, () => "hello-from-login", { requireLogin: true });

		try {
			const result = await consoleExec(TMP, ':put "test"', "admin", "", 15_000);
			expect(result.output).toBe("hello-from-login");
		} finally {
			await closeServer(server);
		}
	});

	test("handles CHR identity prompt (7.23+ format)", async () => {
		if (process.platform === "win32") return;
		const server = await createRouterOsMock(TMP, () => "7.23rc1", { identity: "CHR" });

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
		const server = await createRouterOsMock(TMP, () =>
			["Flags: R - RUNNING", "Columns: NAME, TYPE", "#  NAME    TYPE", "0  ether1  ether"].join("\r\n"),
		);

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
		const server = await createRouterOsMock(TMP, () => "result", { onWrite: (w) => writes.push(w) });

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
