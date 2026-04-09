import { describe, test, expect, afterEach } from "bun:test";
import { resolveAuth } from "../../src/lib/auth.ts";
import { restExecute } from "../../src/lib/exec.ts";

// --- resolveAuth tests ---

describe("resolveAuth", () => {
	test("explicit user+password overrides everything", () => {
		const state = { user: { name: "prov", password: "provpass" }, disableAdmin: true };
		const result = resolveAuth(state, "explicit", "secret");
		expect(result.user).toBe("explicit");
		expect(result.header).toBe(`Basic ${btoa("explicit:secret")}`);
	});

	test("explicit user with no password uses empty password", () => {
		const state = { user: undefined, disableAdmin: false };
		const result = resolveAuth(state, "admin");
		expect(result.user).toBe("admin");
		expect(result.header).toBe(`Basic ${btoa("admin:")}`);
	});

	test("uses provisioned user from state when no explicit override", () => {
		const state = { user: { name: "myuser", password: "mypass" }, disableAdmin: false };
		const result = resolveAuth(state);
		expect(result.user).toBe("myuser");
		expect(result.header).toBe(`Basic ${btoa("myuser:mypass")}`);
	});

	test("falls back to admin with empty password", () => {
		const state = { user: undefined, disableAdmin: false };
		const result = resolveAuth(state);
		expect(result.user).toBe("admin");
		expect(result.header).toBe(`Basic ${btoa("admin:")}`);
	});

	test("returns admin even when disableAdmin is true and no provisioned user", () => {
		const state = { user: undefined, disableAdmin: true };
		const result = resolveAuth(state);
		expect(result.user).toBe("admin");
		// Caller will get 401 — we don't throw
	});
});

// --- restExecute tests (mocked fetch) ---

describe("restExecute", () => {
	const originalFetch = globalThis.fetch;

	function createMockFetch(status: number, body: unknown, contentType = "application/json") {
		return (_url: string | URL | Request, _init?: RequestInit) => {
			return Promise.resolve(new Response(
				typeof body === "string" ? body : JSON.stringify(body),
				{
					status,
					headers: { "Content-Type": contentType },
				},
			));
		};
	}

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	function mockFetch(fn: (url: string | URL | Request, init?: RequestInit) => Promise<Response>) {
		globalThis.fetch = Object.assign(fn, { preconnect: (_url: string | URL) => {} }) as typeof fetch;
	}

	test("sends POST to /rest/execute with script and as-string", async () => {
		let capturedUrl: string | undefined;
		let capturedBody: string | undefined;
		let capturedHeaders: Headers | undefined;

		mockFetch((url, init) => {
			capturedUrl = String(url);
			capturedBody = init?.body as string;
			capturedHeaders = new Headers(init?.headers);
			return Promise.resolve(new Response("[]", {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}));
		});

		const auth = { header: "Basic dGVzdDp0ZXN0", user: "test" };
		await restExecute("http://127.0.0.1:9100", auth, "/system/resource/print");

		expect(capturedUrl).toBe("http://127.0.0.1:9100/rest/execute");
		expect(JSON.parse(capturedBody ?? "")).toEqual({
			script: "/system/resource/print",
			"as-string": "",
		});
		expect(capturedHeaders?.get("Authorization")).toBe("Basic dGVzdDp0ZXN0");
		expect(capturedHeaders?.get("Content-Type")).toBe("application/json");
	});

	test("passes command through without wrapping", async () => {
		let capturedBody: string | undefined;

		mockFetch((_url, init) => {
			capturedBody = init?.body as string;
			return Promise.resolve(new Response(JSON.stringify({ ret: "" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}));
		});

		const auth = { header: "Basic dGVzdDp0ZXN0", user: "test" };
		await restExecute("http://127.0.0.1:9100", auth, ":put [:serialize to=json [/ip/address/print]]");

		expect(JSON.parse(capturedBody ?? "")).toEqual({
			script: `:put [:serialize to=json [/ip/address/print]]`,
			"as-string": "",
		});
	});

	test("extracts ret from object response", async () => {
		mockFetch(createMockFetch(200, { ret: "  name: MikroTik\r\n" }));

		const auth = { header: "Basic YWRtaW46", user: "admin" };
		const result = await restExecute("http://127.0.0.1:9100", auth, "/system/identity/print");

		expect(result.via).toBe("rest");
		expect(result.output).toBe("  name: MikroTik\r\n");
	});

	test("returns empty string for empty array response", async () => {
		mockFetch(createMockFetch(200, []));

		const auth = { header: "Basic YWRtaW46", user: "admin" };
		const result = await restExecute("http://127.0.0.1:9100", auth, "/log/info message=test");

		expect(result.output).toBe("");
	});

	test("returns ret field from :put command", async () => {
		mockFetch(createMockFetch(200, { ret: "42" }));

		const auth = { header: "Basic YWRtaW46", user: "admin" };
		const result = await restExecute("http://127.0.0.1:9100", auth, ":put 42");

		expect(result.output).toBe("42");
	});

	test("returns serialized JSON string from ret field", async () => {
		const innerJson = JSON.stringify([{ "board-name": "CHR", "version": "7.22" }]);
		mockFetch(createMockFetch(200, { ret: innerJson }));

		const auth = { header: "Basic YWRtaW46", user: "admin" };
		const result = await restExecute(
			"http://127.0.0.1:9100", auth,
			":put [:serialize to=json [/system/resource/print]]",
		);

		expect(result.output).toBe(innerJson);
		const parsed = JSON.parse(result.output);
		expect(parsed[0]["board-name"]).toBe("CHR");
	});

	test("throws EXEC_FAILED on HTTP error", async () => {
		mockFetch(createMockFetch(400, {
			error: 400,
			message: "Bad Request",
			detail: "Session closed",
		}));

		const auth = { header: "Basic YWRtaW46", user: "admin" };

		expect(
			restExecute("http://127.0.0.1:9100", auth, "/ping address=10.0.0.1"),
		).rejects.toMatchObject({
			code: "EXEC_FAILED",
		});
	});

	test("throws EXEC_FAILED on 401 Unauthorized", async () => {
		mockFetch(createMockFetch(401, { error: 401, message: "Unauthorized" }));

		const auth = { header: "Basic YWRtaW46", user: "admin" };

		expect(
			restExecute("http://127.0.0.1:9100", auth, "/system/resource/print"),
		).rejects.toMatchObject({
			code: "EXEC_FAILED",
		});
	});

	test("handles message field in error response", async () => {
		mockFetch(createMockFetch(200, { message: "no such command" }));

		const auth = { header: "Basic YWRtaW46", user: "admin" };
		const result = await restExecute("http://127.0.0.1:9100", auth, "/nonexistent/command");

		expect(result.output).toBe("no such command");
	});
});
