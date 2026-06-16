import { describe, test, expect, spyOn, mock, afterEach } from "bun:test";
import { promises as dns } from "node:dns";
import { fetchResilient, isConnectionFailure, toIpv4Url } from "../../src/lib/net.ts";

/** Spy the public-DNS A-record lookup that fetchResilient performs. */
function mockResolve4(impl: { resolve?: string[]; reject?: unknown }) {
	const spy = spyOn(dns.Resolver.prototype, "resolve4");
	if (impl.reject !== undefined) spy.mockRejectedValue(impl.reject);
	else spy.mockResolvedValue(impl.resolve ?? []);
	return spy;
}

describe("toIpv4Url", () => {
	test("rewrites hostname to the IPv4 literal, preserving the path", () => {
		expect(
			toIpv4Url("https://upgrade.mikrotik.com/routeros/NEWESTa7.stable", "159.148.147.251"),
		).toBe("https://159.148.147.251/routeros/NEWESTa7.stable");
	});

	test("preserves port and query string", () => {
		expect(toIpv4Url("https://h.example/a?b=c&d=e", "9.9.9.9")).toBe("https://9.9.9.9/a?b=c&d=e");
		expect(toIpv4Url("https://h.example:8443/p", "9.9.9.9")).toBe("https://9.9.9.9:8443/p");
	});
});

describe("isConnectionFailure", () => {
	test("true for the dual-stack / IPv6-unreachable failures Bun raises (errno 0)", () => {
		expect(isConnectionFailure({ code: "ConnectionRefused", errno: 0 })).toBe(true);
		expect(isConnectionFailure({ code: "FailedToOpenSocket", errno: 0 })).toBe(true);
		expect(isConnectionFailure({ code: "ECONNREFUSED" })).toBe(true);
		expect(isConnectionFailure({ cause: { code: "ENETUNREACH" } })).toBe(true);
		expect(isConnectionFailure(new TypeError("Unable to connect"))).toBe(true);
	});

	test("false for aborts/timeouts and non-error values", () => {
		const abort = new Error("The operation timed out.");
		abort.name = "AbortError";
		expect(isConnectionFailure(abort)).toBe(false);
		expect(isConnectionFailure(null)).toBe(false);
		expect(isConnectionFailure("nope")).toBe(false);
		expect(isConnectionFailure(new RangeError("bad arg"))).toBe(false);
	});
});

describe("fetchResilient", () => {
	afterEach(() => {
		mock.restore();
	});

	test("connects over IPv4 (public-DNS A record) with Host + TLS SNI preserved", async () => {
		mockResolve4({ resolve: ["159.148.147.251"] });
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
			input: string | URL | Request,
			init?: BunFetchRequestInit,
		) => {
			expect(String(input)).toBe("https://159.148.147.251/x");
			expect(new Headers(init?.headers).get("Host")).toBe("upgrade.mikrotik.com");
			expect(init?.tls?.serverName).toBe("upgrade.mikrotik.com");
			return new Response("7.23.1 123", { status: 200 });
		}) as unknown as typeof fetch);

		const res = await fetchResilient("https://upgrade.mikrotik.com/x");
		expect(await res.text()).toBe("7.23.1 123");
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	test("returns the IPv4 HTTP response as-is (no fallback) on a 5xx", async () => {
		mockResolve4({ resolve: ["159.148.147.251"] });
		const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("nope", { status: 503 }),
		);
		const res = await fetchResilient("https://download.mikrotik.com/x");
		expect(res.status).toBe(503);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	test("falls back to a normal fetch when public DNS has no answer", async () => {
		mockResolve4({ reject: Object.assign(new Error("queryA ESERVFAIL"), { code: "ESERVFAIL" }) });
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
			input: string | URL | Request,
		) => {
			expect(String(input)).toBe("https://h.example/x"); // original URL, not rewritten
			return new Response("ok", { status: 200 });
		}) as unknown as typeof fetch);
		const res = await fetchResilient("https://h.example/x");
		expect(await res.text()).toBe("ok");
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	test("falls back to a normal fetch when the IPv4 socket fails (IPv6-only egress)", async () => {
		mockResolve4({ resolve: ["203.0.113.7"] });
		let call = 0;
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
			input: string | URL | Request,
		) => {
			call++;
			if (call === 1) {
				expect(String(input)).toBe("https://203.0.113.7/x"); // IPv4 attempt (rewritten)
				throw Object.assign(new Error("Unable to connect"), { code: "ECONNREFUSED" });
			}
			expect(String(input)).toBe("https://h.example/x"); // normal fallback, original URL
			return new Response("recovered", { status: 200 });
		}) as unknown as typeof fetch);
		const res = await fetchResilient("https://h.example/x");
		expect(await res.text()).toBe("recovered");
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	test("rethrows non-connection errors (e.g. timeouts) without a fallback", async () => {
		mockResolve4({ resolve: ["203.0.113.7"] });
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
			const e = new Error("The operation timed out.");
			e.name = "AbortError";
			throw e;
		}) as unknown as typeof fetch);
		await expect(fetchResilient("https://h.example/x")).rejects.toThrow("The operation timed out.");
		expect(fetchSpy).toHaveBeenCalledTimes(1); // IPv4 attempt only; no normal-fetch retry
	});
});
