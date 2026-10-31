import { describe, test, expect, spyOn } from "bun:test";
import { createServer } from "node:http";
import { resolveAuth } from "../../src/lib/auth.ts";
import { restExecute, restExecuteWithRetry, isExecTransportFailure } from "../../src/lib/exec.ts";
import { QuickCHRError } from "../../src/lib/types.ts";

// --- resolveAuth tests ---

describe("resolveAuth", () => {
	test("explicit user+password overrides everything", async () => {
		const state = { name: "test-chr", user: { name: "prov", password: "provpass" }, disableAdmin: true };
		const result = await resolveAuth(state, "explicit", "secret");
		expect(result.user).toBe("explicit");
		expect(result.header).toBe(`Basic ${btoa("explicit:secret")}`);
	});

	test("explicit user with no password uses empty password", async () => {
		const state = { name: "test-chr", user: undefined, disableAdmin: false };
		const result = await resolveAuth(state, "admin");
		expect(result.user).toBe("admin");
		expect(result.header).toBe(`Basic ${btoa("admin:")}`);
	});

	test("uses provisioned user from state when no explicit override", async () => {
		const state = { name: "test-chr", user: { name: "myuser", password: "mypass" }, disableAdmin: false };
		const result = await resolveAuth(state);
		expect(result.user).toBe("myuser");
		expect(result.header).toBe(`Basic ${btoa("myuser:mypass")}`);
	});

	test("falls back to admin with empty password", async () => {
		const state = { name: "test-chr", user: undefined, disableAdmin: false };
		const result = await resolveAuth(state);
		expect(result.user).toBe("admin");
		expect(result.header).toBe(`Basic ${btoa("admin:")}`);
	});

	test("returns admin even when disableAdmin is true and no provisioned user", async () => {
		const state = { name: "test-chr", user: undefined, disableAdmin: true };
		const result = await resolveAuth(state);
		expect(result.user).toBe("admin");
		// Caller will get 401 — we don't throw
	});
});

// --- restExecute tests (real Bun.serve mock server) ---
// restExecute uses node:http (not fetch) to avoid Bun's connection pool.
// globalThis.fetch mocking does not intercept node:http — use a real server instead.

describe("restExecute", () => {
	/** Spin up a temporary server, run fn with its base URL, then stop it. */
	async function withServer(
		handler: (req: Request) => Response | Promise<Response>,
		fn: (baseUrl: string) => Promise<void>,
	) {
		const server = Bun.serve({ port: 0, fetch: handler });
		try {
			await fn(`http://127.0.0.1:${server.port}`);
		} finally {
			server.stop();
		}
	}

	test("sends POST to /rest/execute with script and as-string", async () => {
		let capturedUrl = "";
		let capturedBody: unknown;
		let capturedAuth: string | null = null;
		let capturedContentType: string | null = null;

		await withServer(
			async (req) => {
				capturedUrl = req.url;
				capturedBody = await req.json();
				capturedAuth = req.headers.get("authorization");
				capturedContentType = req.headers.get("content-type");
				return new Response("[]", { headers: { "Content-Type": "application/json" } });
			},
			async (baseUrl) => {
				const auth = { header: "Basic dGVzdDp0ZXN0", user: "test" };
				await restExecute(baseUrl, auth, "/system/resource/print");

				expect(capturedUrl).toContain("/rest/execute");
				expect(capturedBody).toEqual({ script: "/system/resource/print", "as-string": true });
				expect(capturedAuth).toBe("Basic dGVzdDp0ZXN0");
				expect(capturedContentType).toBe("application/json");
			},
		);
	});

	test("passes command through without wrapping", async () => {
		let capturedBody: unknown;

		await withServer(
			async (req) => {
				capturedBody = await req.json();
				return new Response(JSON.stringify({ ret: "" }), { headers: { "Content-Type": "application/json" } });
			},
			async (baseUrl) => {
				const auth = { header: "Basic dGVzdDp0ZXN0", user: "test" };
				await restExecute(baseUrl, auth, ":put [:serialize to=json [/ip/address/print]]");

				expect(capturedBody).toEqual({
					script: ":put [:serialize to=json [/ip/address/print]]",
					"as-string": true,
				});
			},
		);
	});

	test("extracts ret from object response", async () => {
		await withServer(
			() => new Response(JSON.stringify({ ret: "  name: MikroTik\r\n" }), { headers: { "Content-Type": "application/json" } }),
			async (baseUrl) => {
				const auth = { header: "Basic YWRtaW46", user: "admin" };
				const result = await restExecute(baseUrl, auth, "/system/identity/print");

				expect(result.via).toBe("rest");
				expect(result.output).toBe("  name: MikroTik\r\n");
			},
		);
	});

	test("returns empty string for empty array response", async () => {
		await withServer(
			() => new Response("[]", { headers: { "Content-Type": "application/json" } }),
			async (baseUrl) => {
				const auth = { header: "Basic YWRtaW46", user: "admin" };
				const result = await restExecute(baseUrl, auth, "/log/info message=test");

				expect(result.output).toBe("");
			},
		);
	});

	test("returns ret field from :put command", async () => {
		await withServer(
			() => new Response(JSON.stringify({ ret: "42" }), { headers: { "Content-Type": "application/json" } }),
			async (baseUrl) => {
				const auth = { header: "Basic YWRtaW46", user: "admin" };
				const result = await restExecute(baseUrl, auth, ":put 42");

				expect(result.output).toBe("42");
			},
		);
	});

	test("returns serialized JSON string from ret field", async () => {
		const innerJson = JSON.stringify([{ "board-name": "CHR", "version": "7.22" }]);

		await withServer(
			() => new Response(JSON.stringify({ ret: innerJson }), { headers: { "Content-Type": "application/json" } }),
			async (baseUrl) => {
				const auth = { header: "Basic YWRtaW46", user: "admin" };
				const result = await restExecute(
					baseUrl, auth,
					":put [:serialize to=json [/system/resource/print]]",
				);

				expect(result.output).toBe(innerJson);
				const parsed = JSON.parse(result.output);
				expect(parsed[0]["board-name"]).toBe("CHR");
			},
		);
	});

	test("throws EXEC_FAILED on HTTP error", async () => {
		await withServer(
			() => new Response(JSON.stringify({ error: 400, message: "Bad Request", detail: "Session closed" }), {
				status: 400,
				headers: { "Content-Type": "application/json" },
			}),
			async (baseUrl) => {
				const auth = { header: "Basic YWRtaW46", user: "admin" };
				await expect(
					restExecute(baseUrl, auth, "/ping address=10.0.0.1"),
				).rejects.toMatchObject({ code: "EXEC_FAILED" });
			},
		);
	});

	test("throws EXEC_FAILED on 401 Unauthorized", async () => {
		await withServer(
			() => new Response(JSON.stringify({ error: 401, message: "Unauthorized" }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			}),
			async (baseUrl) => {
				const auth = { header: "Basic YWRtaW46", user: "admin" };
				await expect(
					restExecute(baseUrl, auth, "/system/resource/print"),
				).rejects.toMatchObject({ code: "EXEC_FAILED" });
			},
		);
	});

	test("handles message field in error response", async () => {
		await withServer(
			() => new Response(JSON.stringify({ message: "no such command" }), { headers: { "Content-Type": "application/json" } }),
			async (baseUrl) => {
				const auth = { header: "Basic YWRtaW46", user: "admin" };
				const result = await restExecute(baseUrl, auth, "/nonexistent/command");

				expect(result.output).toBe("no such command");
			},
		);
	});
});

// --- transport failures: cause preservation, retry, classification ---
// A destroyed server socket surfaces client-side as ECONNRESET ("socket hang
// up") — the same code a live CHR produces when www is down or resets a
// post-boot connection (measured 2026-10-29, Bun 1.4.4).

describe("exec transport failures", () => {
	const auth = { header: "Basic YWRtaW46", user: "admin" };

	/** node:http server on an ephemeral port; handler sees (req, res, count). */
	async function withNodeServer(
		handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, count: number) => void,
		fn: (baseUrl: string) => Promise<void>,
	) {
		let count = 0;
		const server = createServer((req, res) => handler(req, res, ++count));
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as { port: number }).port;
		try {
			await fn(`http://127.0.0.1:${port}`);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
		}
	}

	/** A port that is guaranteed closed: bind, then close before connecting. */
	async function deadPort(): Promise<number> {
		const server = createServer(() => {});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as { port: number }).port;
		await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
		return port;
	}

	test("restExecute attaches the transport error as cause", async () => {
		const port = await deadPort();
		const err = await restExecute(`http://127.0.0.1:${port}`, auth, ":put hi").then(
			() => { throw new Error("expected restExecute to throw against a dead port"); },
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(QuickCHRError);
		expect((err as QuickCHRError).code).toBe("EXEC_FAILED");
		expect((err as QuickCHRError).cause).toBeInstanceOf(Error);
		expect(((err as QuickCHRError).cause as { code?: unknown }).code).toBe("ECONNREFUSED");
	});

	test("restExecute carries no cause on HTTP errors — a response is an answer", async () => {
		await withNodeServer(
			(_req, res) => {
				res.writeHead(401, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: 401, message: "Unauthorized" }));
			},
			async (baseUrl) => {
				const err = await restExecute(baseUrl, auth, "/system/resource/print").then(
					() => { throw new Error("expected restExecute to throw on 401"); },
					(e: unknown) => e,
				);
				expect(err).toBeInstanceOf(QuickCHRError);
				expect((err as QuickCHRError).code).toBe("EXEC_FAILED");
				expect((err as QuickCHRError).cause).toBeUndefined();
			},
		);
	});

	test("restExecuteWithRetry does not replay after a command takes effect then resets", async () => {
		let effects = 0;
		await withNodeServer(
			(req, _res) => {
				effects++;
				req.socket.destroy();
			},
			async (baseUrl) => {
				const err = await restExecuteWithRetry(baseUrl, auth, "/example/add", { retryDelayMs: 5 }).then(
					() => { throw new Error("expected reset to surface"); },
					(e: unknown) => e,
				);
				expect(err).toBeInstanceOf(QuickCHRError);
				expect((err as QuickCHRError).code).toBe("EXEC_FAILED");
				expect(((err as QuickCHRError).cause as { code?: unknown }).code).toBe("ECONNRESET");
				expect(isExecTransportFailure(err)).toBe(false);
				expect(effects).toBe(1);
			},
		);
	});

	test("restExecuteWithRetry bounds retries for a refused connection", async () => {
		const port = await deadPort();
		const warnings = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const err = await restExecuteWithRetry(`http://127.0.0.1:${port}`, auth, ":put hi", { retries: 2, retryDelayMs: 5 }).then(
				() => { throw new Error("expected refusal"); },
				(e: unknown) => e,
			);
			expect(warnings).toHaveBeenCalledTimes(2);
			expect(((err as QuickCHRError).cause as { code?: unknown }).code).toBe("ECONNREFUSED");
			expect(isExecTransportFailure(err)).toBe(true);
		} finally {
			warnings.mockRestore();
		}
	});

	test.each(["single", "auto"])("%s REST timeout is not replayed or eligible for fallback", async (mode) => {
		let requests = 0;
		await withNodeServer(
			() => { requests++; },
			async (baseUrl) => {
				const execute = mode === "single" ? restExecute : restExecuteWithRetry;
				const err = await execute(baseUrl, auth, ":delay 30s", { timeout: 100 }).then(
					() => { throw new Error("expected timeout"); },
					(e: unknown) => e,
				);
				expect(err).toBeInstanceOf(QuickCHRError);
				expect((err as QuickCHRError).message).toContain("restPost timeout");
				expect(isExecTransportFailure(err)).toBe(false);
				expect(requests).toBe(1);
			},
		);
	});

	test("restExecuteWithRetry never retries an HTTP error", async () => {
		let requests = 0;
		await withNodeServer(
			(_req, res) => {
				requests++;
				res.writeHead(401, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: 401, message: "Unauthorized" }));
			},
			async (baseUrl) => {
				await expect(restExecuteWithRetry(baseUrl, auth, "/system/resource/print", { retryDelayMs: 5 }))
					.rejects.toMatchObject({ code: "EXEC_FAILED" });
				expect(requests).toBe(1);
			},
		);
	});

	test("isExecTransportFailure allows only known failures before delivery", async () => {
		const port = await deadPort();
		const transportErr = await restExecute(`http://127.0.0.1:${port}`, auth, ":put hi").then(
			() => { throw new Error("expected restExecute to throw against a dead port"); },
			(e: unknown) => e,
		);
		expect(isExecTransportFailure(transportErr)).toBe(true);
		for (const code of ["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET", "ETIMEDOUT", "EPIPE", undefined, "UNKNOWN"]) {
			const err = new QuickCHRError("EXEC_FAILED", "connection failure");
			err.cause = Object.assign(new Error("transport"), { code });
			expect(isExecTransportFailure(err)).toBe(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"].includes(code ?? ""));
		}
		expect(isExecTransportFailure(new QuickCHRError("EXEC_FAILED", "exec failed (HTTP 401): nope"))).toBe(false);
		expect(isExecTransportFailure(new QuickCHRError("MACHINE_STOPPED", "stopped"))).toBe(false);
		expect(isExecTransportFailure(new Error("plain"))).toBe(false);
		expect(isExecTransportFailure("nope")).toBe(false);
	});
});
