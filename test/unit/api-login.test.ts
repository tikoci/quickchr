import { describe, test, expect, afterEach } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import {
	apiLogin,
	classifyLoginReply,
	encodeApiLength,
	encodeApiSentence,
	parseApiSentences,
} from "../../src/lib/api-login.ts";
import { readinessProbeFor, waitForApiReady } from "../../src/lib/qemu.ts";
import { classifyProbeError, newBootProbeStats, summarizeBootProbe } from "../../src/lib/diagnostics.ts";

/**
 * The native-API login readiness probe (#182).
 *
 * The reply bytes below are the exact hex a CHR 6.49.23 (x86, HVF) sent back on
 * 2026-10-21 — grounded, not reconstructed from the protocol description.
 */
const GROUNDED_DONE = "0521646f6e6500";
const GROUNDED_TRAP_THEN_DONE =
	"0521747261702a3d6d6573736167653d696e76616c69642075736572206e616d65206f722070617373776f726420283629000521646f6e6500";

const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));

describe("API word encoding", () => {
	test("each length class uses its own prefix width", () => {
		expect([...encodeApiLength(0)]).toEqual([0x00]);
		expect([...encodeApiLength(0x7f)]).toEqual([0x7f]);
		expect([...encodeApiLength(0x80)]).toEqual([0x80, 0x80]);
		expect([...encodeApiLength(0x3fff)]).toEqual([0xbf, 0xff]);
		expect([...encodeApiLength(0x4000)]).toEqual([0xc0, 0x40, 0x00]);
		expect([...encodeApiLength(0x1fffff)]).toEqual([0xdf, 0xff, 0xff]);
		expect([...encodeApiLength(0x200000)]).toEqual([0xe0, 0x20, 0x00, 0x00]);
		expect([...encodeApiLength(0x0fffffff)]).toEqual([0xef, 0xff, 0xff, 0xff]);
		expect([...encodeApiLength(0x10000000)]).toEqual([0xf0, 0x10, 0x00, 0x00, 0x00]);
	});

	test("every length class round-trips through the parser", () => {
		for (const size of [0x7f, 0x80, 0x3fff, 0x4000, 0x20000]) {
			const word = "x".repeat(size);
			expect(parseApiSentences(encodeApiSentence([word]))).toEqual([[word]]);
		}
	});

	test("the login sentence is what the grounding probe sent", () => {
		const sent = encodeApiSentence(["/login", "=name=admin", "=password="]);
		expect(Buffer.from(sent).toString("hex")).toBe(
			`06${Buffer.from("/login").toString("hex")}0b${Buffer.from("=name=admin").toString("hex")}0a${Buffer.from("=password=").toString("hex")}00`,
		);
	});
});

describe("API reply parsing", () => {
	test("a successful login is one !done sentence", () => {
		const sentences = parseApiSentences(bytes(GROUNDED_DONE));
		expect(sentences).toEqual([["!done"]]);
		expect(classifyLoginReply(sentences)).toEqual({ outcome: "done" });
	});

	test("a refused login is !trap then !done, and the message is kept", () => {
		const sentences = parseApiSentences(bytes(GROUNDED_TRAP_THEN_DONE));
		expect(sentences).toEqual([["!trap", "=message=invalid user name or password (6)"], ["!done"]]);
		expect(classifyLoginReply(sentences)).toEqual({ outcome: "trap", message: "invalid user name or password (6)" });
	});

	test("a !trap without its !done is not an answer yet", () => {
		// The trap sentence alone — the !done may still be in flight.
		const trapOnly = bytes(GROUNDED_TRAP_THEN_DONE.slice(0, GROUNDED_TRAP_THEN_DONE.length - GROUNDED_DONE.length));
		expect(classifyLoginReply(parseApiSentences(trapOnly))).toBeNull();
	});

	test("a buffer that ends mid-sentence yields only the complete sentences", () => {
		const full = bytes(GROUNDED_TRAP_THEN_DONE);
		expect(parseApiSentences(full.subarray(0, full.length - 3))).toEqual([
			["!trap", "=message=invalid user name or password (6)"],
		]);
		expect(parseApiSentences(full.subarray(0, 4))).toEqual([]);
	});

	test("!fatal is an answer on its own", () => {
		const fatal = encodeApiSentence(["!fatal", "too many commands before login"]);
		expect(classifyLoginReply(parseApiSentences(fatal))).toEqual({ outcome: "fatal", message: "too many commands before login" });
	});
});

let server: Server | undefined;
afterEach(() => {
	server?.close();
	server = undefined;
});

/** A fake API service: `reply` decides what each connection gets back. */
async function fakeApi(reply: (socket: Socket, received: Buffer) => void): Promise<number> {
	server = createServer((socket) => {
		socket.on("data", (data: Buffer) => reply(socket, data));
		socket.on("error", () => {});
	});
	await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	return address.port;
}

describe("apiLogin", () => {
	test("sends the login sentence and resolves on !done", async () => {
		let seen: string[][] = [];
		const port = await fakeApi((socket, received) => {
			seen = parseApiSentences(received);
			socket.write(bytes(GROUNDED_DONE));
		});
		expect(await apiLogin(port, "admin", "")).toEqual({ outcome: "done" });
		expect(seen).toEqual([["/login", "=name=admin", "=password="]]);
	});

	test("resolves on a reply split across reads", async () => {
		const port = await fakeApi((socket) => {
			const full = bytes(GROUNDED_TRAP_THEN_DONE);
			socket.write(full.subarray(0, 10));
			setTimeout(() => socket.write(full.subarray(10)), 20);
		});
		expect(await apiLogin(port, "admin", "wrong")).toEqual({ outcome: "trap", message: "invalid user name or password (6)" });
	});

	test("a close before any reply rejects as 'closed before reply' — a reset, not a timeout", async () => {
		const port = await fakeApi((socket) => socket.end());
		const err = await apiLogin(port, "admin", "").catch((e: unknown) => e);
		expect((err as Error).message).toBe("closed before reply");
		expect(classifyProbeError(err)).toEqual({ outcome: "reset", detail: "closed before reply" });
	});

	test("silence rejects at the deadline as a probe timeout", async () => {
		const port = await fakeApi(() => {});
		const err = await apiLogin(port, "admin", "", 150).catch((e: unknown) => e);
		expect((err as Error).message).toBe("apiLogin timeout");
		expect(classifyProbeError(err).outcome).toBe("probe-timeout");
	});
});

describe("waitForApiReady", () => {
	test("needs two consecutive answers, and records them as an API probe", async () => {
		const port = await fakeApi((socket) => socket.write(bytes(GROUNDED_DONE)));
		const stats = newBootProbeStats();
		expect(await waitForApiReady(port, 10_000, { user: "admin", password: "" }, stats)).toBe(true);
		expect(stats.kind).toBe("api");
		expect(stats.counts).toEqual({ ready: 2 });
		expect(summarizeBootProbe(stats)).toContain("first API reply at");
	});

	test("a credential refusal counts as the service being up, like a REST 401", async () => {
		const port = await fakeApi((socket) => socket.write(bytes(GROUNDED_TRAP_THEN_DONE)));
		const stats = newBootProbeStats();
		expect(await waitForApiReady(port, 10_000, { user: "admin", password: "stale" }, stats)).toBe(true);
		expect(stats.counts).toEqual({ unauthorized: 2 });
	});

	test("a port that never answers times out and explains itself", async () => {
		const port = await fakeApi((socket) => socket.end());
		const stats = newBootProbeStats();
		expect(await waitForApiReady(port, 500, { user: "admin", password: "" }, stats)).toBe(false);
		expect(stats.counts.reset).toBeGreaterThan(0);
		expect(summarizeBootProbe(stats)).toContain("never produced an API reply");
	});
});

describe("readinessProbeFor", () => {
	test("RouterOS 6 uses the native API; everything else keeps REST", () => {
		expect(readinessProbeFor("6.49.23")).toBe("api");
		expect(readinessProbeFor("6.43")).toBe("api");
		expect(readinessProbeFor("7.24.5")).toBe("rest");
		expect(readinessProbeFor("7.26beta1")).toBe("rest");
		// Not a prefix match on "6": 7.6 is RouterOS 7.
		expect(readinessProbeFor("7.6")).toBe("rest");
	});
});
