import { describe, test, expect } from "bun:test";
import { resolveAuth } from "../../src/lib/auth.ts";
import { restExecute } from "../../src/lib/exec.ts";

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
