import { describe, test, expect, spyOn, mock, afterEach } from "bun:test";
import { promises as dns } from "node:dns";
import {
	fetchResilient,
	isConnectionFailure,
	isProxyConfiguredFor,
	isProxyRefusal,
	PROXY_ALLOWLIST_HINT,
	PROXY_CREDENTIALS_HINT,
	proxyRefusalHint,
	proxyTunnelStatus,
	ResilientFetchError,
	toIpv4Url,
} from "../../src/lib/net.ts";

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
		// A TypeError counts only with Bun's `errno: 0` connect-failure marker.
		expect(isConnectionFailure(Object.assign(new TypeError("Unable to connect"), { errno: 0 }))).toBe(
			true,
		);
	});

	test("true for a ResilientFetchError — both transports failed to connect", () => {
		// Constructed only after a direct failure that already passed this test, so a
		// caller retrying connection failures must keep retrying this one (#121).
		const both = new ResilientFetchError(
			"https://h.example/x",
			"9.9.9.9",
			Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" }),
			Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" }),
		);
		expect(isConnectionFailure(both)).toBe(true);
	});

	test("false for aborts, plain TypeErrors, and non-error values", () => {
		const abort = new Error("The operation timed out.");
		abort.name = "AbortError";
		expect(isConnectionFailure(abort)).toBe(false);
		expect(isConnectionFailure(null)).toBe(false);
		expect(isConnectionFailure("nope")).toBe(false);
		expect(isConnectionFailure(new RangeError("bad arg"))).toBe(false);
		// A bare TypeError without the errno marker is a real bug, not a connect failure.
		expect(isConnectionFailure(new TypeError("x is not a function"))).toBe(false);
	});
});

describe("fetchResilient", () => {
	afterEach(() => {
		mock.restore();
	});

	test("uses a plain fetch on the system resolver as the primary path", async () => {
		const resolveSpy = mockResolve4({ reject: new Error("resolve4 must not be called") });
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
			input: string | URL | Request,
		) => {
			expect(String(input)).toBe("https://upgrade.mikrotik.com/x"); // original URL, not rewritten
			return new Response("7.23.1 123", { status: 200 });
		}) as unknown as typeof fetch);

		const res = await fetchResilient("https://upgrade.mikrotik.com/x");
		expect(await res.text()).toBe("7.23.1 123");
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(resolveSpy).toHaveBeenCalledTimes(0); // no public-DNS detour on the happy path
	});

	test("returns the HTTP response as-is (no fallback) on a 5xx", async () => {
		const resolveSpy = mockResolve4({ reject: new Error("resolve4 must not be called") });
		const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("nope", { status: 503 }),
		);
		const res = await fetchResilient("https://download.mikrotik.com/x");
		expect(res.status).toBe(503);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(resolveSpy).toHaveBeenCalledTimes(0);
	});

	test("falls back to public-DNS IPv4 (Host + TLS SNI preserved) on a connection failure", async () => {
		mockResolve4({ resolve: ["159.148.147.251"] });
		let call = 0;
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
			input: string | URL | Request,
			init?: BunFetchRequestInit,
		) => {
			call++;
			if (call === 1) {
				expect(String(input)).toBe("https://upgrade.mikrotik.com/x"); // normal attempt, original URL
				throw Object.assign(new Error("Unable to connect"), { code: "ECONNREFUSED" });
			}
			expect(String(input)).toBe("https://159.148.147.251/x"); // IPv4 fallback (rewritten)
			expect(new Headers(init?.headers).get("Host")).toBe("upgrade.mikrotik.com");
			// serverName must pin to the real host even when the caller passes a conflicting one.
			expect(init?.tls?.serverName).toBe("upgrade.mikrotik.com");
			return new Response("recovered", { status: 200 });
		}) as unknown as typeof fetch);

		const res = await fetchResilient("https://upgrade.mikrotik.com/x", {
			tls: { serverName: "attacker.example" },
		});
		expect(await res.text()).toBe("recovered");
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	test("surfaces the original connection failure when public DNS has no answer", async () => {
		// Message mirrors Node's real dns.resolve4 rejection ("queryA ESERVFAIL <host>");
		// only `code` drives fetchResilient's branch, but the realistic text keeps the
		// mock faithful to what production actually sees.
		mockResolve4({ reject: Object.assign(new Error("queryA ESERVFAIL"), { code: "ESERVFAIL" }) });
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
			throw Object.assign(new Error("Unable to connect"), { code: "ECONNREFUSED" });
		}) as unknown as typeof fetch);
		await expect(fetchResilient("https://h.example/x")).rejects.toThrow("Unable to connect");
		expect(fetchSpy).toHaveBeenCalledTimes(1); // normal attempt only; IPv4 path never reached
	});

	test("reports host, both transports' errors and the fallback address when both fail", async () => {
		mockResolve4({ resolve: ["159.148.147.251"] });
		let call = 0;
		spyOn(globalThis, "fetch").mockImplementation((async () => {
			call++;
			throw call === 1
				? Object.assign(new Error("Unable to connect via system resolver"), {
						code: "ConnectionRefused",
					})
				: Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), {
						code: "ConnectionRefused",
					});
		}) as unknown as typeof fetch);

		// Anchor on the message: the whole point of #121's gap 2 is that a log which
		// names only the IP literal cannot say which transport failed or where the
		// address came from.
		const err = (await fetchResilient(
			"https://upgrade.mikrotik.com/routeros/NEWESTa7.testing",
		).catch((e) => e)) as ResilientFetchError;

		expect(err).toBeInstanceOf(ResilientFetchError);
		expect(err.host).toBe("upgrade.mikrotik.com");
		expect(err.address).toBe("159.148.147.251");
		expect(err.message).toContain("https://upgrade.mikrotik.com/routeros/NEWESTa7.testing");
		expect(err.message).toContain("system resolver — ConnectionRefused: Unable to connect via system resolver");
		expect(err.message).toContain("public DNS (1.1.1.1, 8.8.8.8, 1.0.0.1) → 159.148.147.251");
		expect(err.message).toContain("Is the computer able to access the url?");
		// The direct failure stays reachable programmatically, not just in the text.
		expect((err.cause as { code?: string }).code).toBe("ConnectionRefused");
	});

	test("rethrows non-connection errors (e.g. timeouts) without a fallback", async () => {
		const resolveSpy = mockResolve4({ reject: new Error("resolve4 must not be called") });
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
			const e = new Error("The operation timed out.");
			e.name = "AbortError";
			throw e;
		}) as unknown as typeof fetch);
		await expect(fetchResilient("https://h.example/x")).rejects.toThrow("The operation timed out.");
		expect(fetchSpy).toHaveBeenCalledTimes(1); // normal attempt only; no public-DNS retry
		expect(resolveSpy).toHaveBeenCalledTimes(0);
	});

	test("does not retry on a plain TypeError lacking the errno-0 connect marker", async () => {
		const resolveSpy = mockResolve4({ reject: new Error("resolve4 must not be called") });
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
			throw new TypeError("x is not a function"); // a real bug, not a connect failure
		}) as unknown as typeof fetch);
		await expect(fetchResilient("https://h.example/x")).rejects.toThrow("x is not a function");
		expect(fetchSpy).toHaveBeenCalledTimes(1); // surfaced immediately; no public-DNS retry
		expect(resolveSpy).toHaveBeenCalledTimes(0);
	});

	test("lets a proxy refusal through without a fallback — no resolver can clear a policy", async () => {
		// Sandboxed cloud sessions answer 403 to CONNECT for hosts off the
		// allowlist (#210). The public-DNS/IPv4 fallback must not run: there is
		// no direct egress for it to use, and its error would only confuse the log.
		const resolveSpy = mockResolve4({ reject: new Error("resolve4 must not be called") });
		const refusal = Object.assign(new Error("proxy CONNECT refused: 403"), {
			code: "ERR_PROXY_TUNNEL",
		});
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
			throw refusal;
		}) as unknown as typeof fetch);
		const err = await fetchResilient("https://upgrade.mikrotik.com/x").catch((e) => e);
		expect(err).toBe(refusal); // unchanged, not wrapped in a ResilientFetchError
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(resolveSpy).toHaveBeenCalledTimes(0);
	});

	test("still skips the fallback for a refusal that also reads as a connection failure", async () => {
		// The no-fallback guarantee is explicit, not emergent from the predicates
		// never overlapping: this shape matches both, and the refusal wins.
		const resolveSpy = mockResolve4({ reject: new Error("resolve4 must not be called") });
		const both = Object.assign(new Error("proxy CONNECT refused: 403"), {
			code: "ConnectionRefused",
		});
		expect(isProxyRefusal(both)).toBe(true);
		expect(isConnectionFailure(both)).toBe(true);
		spyOn(globalThis, "fetch").mockImplementation((async () => {
			throw both;
		}) as unknown as typeof fetch);
		const err = await fetchResilient("https://upgrade.mikrotik.com/x").catch((e) => e);
		expect(err).toBe(both); // unchanged, not wrapped in a ResilientFetchError
		expect(resolveSpy).toHaveBeenCalledTimes(0);
	});
});

describe("isProxyRefusal", () => {
	test("true for ERR_PROXY_TUNNEL by code, including through a cause chain", () => {
		expect(isProxyRefusal(Object.assign(new Error("nope"), { code: "ERR_PROXY_TUNNEL" }))).toBe(
			true,
		);
		const wrapped = new Error("fetch failed", {
			cause: Object.assign(new Error("proxy CONNECT refused"), { code: "ERR_PROXY_TUNNEL" }),
		});
		expect(isProxyRefusal(wrapped)).toBe(true);
	});

	test("true for messages naming a refused proxy tunnel", () => {
		expect(isProxyRefusal(new Error("proxy CONNECT refused: 403"))).toBe(true);
		expect(isProxyRefusal(new Error("Proxy tunnel creation failed with 403 Forbidden"))).toBe(
			true,
		);
		expect(isProxyRefusal(new Error("CONNECT tunnel failed: 403"))).toBe(true);
	});

	test("true for a 407 tunnel failure — refused for credentials, still terminal", () => {
		// Bun's exact shape (probed): the code alone cannot tell 407 from 403.
		const auth = Object.assign(
			new Error("Proxy refused to open a tunnel: 407 Proxy Authentication Required"),
			{ code: "ERR_PROXY_TUNNEL", status: 407, statusText: "Proxy Authentication Required" },
		);
		expect(isProxyRefusal(auth)).toBe(true);
		const wrapped = new Error("fetch failed", { cause: auth });
		expect(isProxyRefusal(wrapped)).toBe(true);
	});

	test("false for a 5xx tunnel failure — the proxy is sick, not refusing", () => {
		// A 5xx CONNECT answer must keep the retries it had before proxy mapping
		// existed: classifying it as a refusal would make it terminal (#210).
		const sick = Object.assign(
			new Error("Proxy refused to open a tunnel: 503 Service Unavailable"),
			{ code: "ERR_PROXY_TUNNEL", status: 503, statusText: "Service Unavailable" },
		);
		expect(isProxyRefusal(sick)).toBe(false);
		const wrapped = new Error("fetch failed", { cause: sick });
		expect(isProxyRefusal(wrapped)).toBe(false);
	});

	test("false for connection failures, aborts, and unrelated errors", () => {
		// A proxy refusal must never read as a connection failure — that is what
		// would send it down the public-DNS fallback and the retry loops.
		expect(isConnectionFailure(Object.assign(new Error("x"), { code: "ERR_PROXY_TUNNEL" }))).toBe(
			false,
		);
		expect(isProxyRefusal(Object.assign(new Error("Unable to connect"), { code: "ECONNREFUSED" }))).toBe(
			false,
		);
		const abort = new Error("The operation timed out.");
		abort.name = "AbortError";
		expect(isProxyRefusal(abort)).toBe(false);
		expect(isProxyRefusal(new TypeError("x is not a function"))).toBe(false);
		expect(isProxyRefusal(null)).toBe(false);
		// A bare 407 message with no tunnel code is not attributable to the
		// proxy — the *.mikrotik.com hint would mislead.
		expect(isProxyRefusal(new Error("Proxy Authentication Required"))).toBe(false);
	});

	test("false for failures that merely mention tunnels or connecting", () => {
		// No bare "tunnel": a DNS failure for a host with "tunnel" in its name
		// is not a proxy refusal.
		expect(isProxyRefusal(new Error("getaddrinfo ENOTFOUND proxy-tunnel-01.example.com"))).toBe(
			false,
		);
		expect(isProxyRefusal(new Error("getaddrinfo ENOTFOUND tunnel.internal"))).toBe(false);
		// CONNECT matches case-sensitively: the HTTP method is uppercase, while
		// "Unable to connect" (a connection failure) is not.
		expect(isProxyRefusal(new Error("Unable to connect to host: connection refused"))).toBe(
			false,
		);
	});
});

describe("proxyTunnelStatus", () => {
	test("reads the CONNECT status through the cause chain", () => {
		expect(
			proxyTunnelStatus(Object.assign(new Error("tunnel"), { code: "ERR_PROXY_TUNNEL", status: 407 })),
		).toBe(407);
		const wrapped = new Error("fetch failed", {
			cause: Object.assign(new Error("tunnel"), { code: "ERR_PROXY_TUNNEL", status: 503 }),
		});
		expect(proxyTunnelStatus(wrapped)).toBe(503);
	});

	test("undefined without a tunnel failure or without a numeric status", () => {
		// Shapes with no status keep the historical allowlist reading.
		expect(
			proxyTunnelStatus(Object.assign(new Error("tunnel"), { code: "ERR_PROXY_TUNNEL" })),
		).toBeUndefined();
		// A bare status with no tunnel code is not a tunnel failure.
		expect(proxyTunnelStatus(Object.assign(new Error("x"), { status: 503 }))).toBeUndefined();
		expect(
			proxyTunnelStatus(Object.assign(new Error("x"), { code: "ERR_PROXY_TUNNEL", status: "503" })),
		).toBeUndefined();
		expect(proxyTunnelStatus(new Error("nope"))).toBeUndefined();
		expect(proxyTunnelStatus(null)).toBeUndefined();
	});
});

describe("proxyRefusalHint", () => {
	test("407 names the credentials fix, 403 and status-less shapes the allowlist", () => {
		expect(
			proxyRefusalHint(
				Object.assign(new Error("tunnel"), { code: "ERR_PROXY_TUNNEL", status: 407 }),
			),
		).toBe(PROXY_CREDENTIALS_HINT);
		expect(
			proxyRefusalHint(
				Object.assign(new Error("tunnel"), { code: "ERR_PROXY_TUNNEL", status: 403 }),
			),
		).toBe(PROXY_ALLOWLIST_HINT);
		expect(
			proxyRefusalHint(Object.assign(new Error("tunnel"), { code: "ERR_PROXY_TUNNEL" })),
		).toBe(PROXY_ALLOWLIST_HINT);
	});
});

describe("isProxyConfiguredFor", () => {
	const HTTPS_URL = "https://upgrade.mikrotik.com/routeros/NEWESTa7.stable";
	const HTTP_URL = "http://127.0.0.1:8080/x";
	const PROXY = "http://proxy.example:8080";

	test("scheme-specific variables apply to their scheme only, either case", () => {
		expect(isProxyConfiguredFor(HTTPS_URL, { HTTPS_PROXY: PROXY })).toBe(true);
		expect(isProxyConfiguredFor(HTTPS_URL, { https_proxy: PROXY })).toBe(true);
		expect(isProxyConfiguredFor(HTTPS_URL, { HTTP_PROXY: PROXY })).toBe(false);
		expect(isProxyConfiguredFor(HTTP_URL, { HTTP_PROXY: PROXY })).toBe(true);
		expect(isProxyConfiguredFor(HTTP_URL, { http_proxy: PROXY })).toBe(true);
		expect(isProxyConfiguredFor(HTTP_URL, { HTTPS_PROXY: PROXY })).toBe(false);
		expect(isProxyConfiguredFor(HTTPS_URL, {})).toBe(false);
	});

	test("ALL_PROXY covers both schemes when the scheme-specific variable is unset", () => {
		expect(isProxyConfiguredFor(HTTPS_URL, { ALL_PROXY: PROXY })).toBe(true);
		expect(isProxyConfiguredFor(HTTPS_URL, { all_proxy: PROXY })).toBe(true);
		expect(isProxyConfiguredFor(HTTP_URL, { ALL_PROXY: PROXY })).toBe(true);
		// Empty string counts as unset and falls through to ALL_PROXY (probed).
		expect(isProxyConfiguredFor(HTTPS_URL, { HTTPS_PROXY: "", ALL_PROXY: PROXY })).toBe(true);
		expect(isProxyConfiguredFor(HTTPS_URL, { HTTPS_PROXY: "" })).toBe(false);
	});

	test("values naming another kind of proxy never count as configured", () => {
		expect(isProxyConfiguredFor(HTTPS_URL, { HTTPS_PROXY: "socks5://proxy.example:1080" })).toBe(
			false,
		);
		expect(isProxyConfiguredFor(HTTPS_URL, { ALL_PROXY: "socks5://proxy.example:1080" })).toBe(
			false,
		);
		// Scheme-less host[:port] is used as an http proxy (probed).
		expect(isProxyConfiguredFor(HTTPS_URL, { HTTPS_PROXY: "proxy.example:8080" })).toBe(true);
		expect(isProxyConfiguredFor("not a url", { HTTPS_PROXY: PROXY })).toBe(false);
		expect(isProxyConfiguredFor("ftp://h.example/x", { ALL_PROXY: PROXY })).toBe(false);
	});

	test("NO_PROXY bypasses by host, subdomain, wildcard, and list", () => {
		const proxy = { HTTPS_PROXY: PROXY };
		expect(
			isProxyConfiguredFor(HTTPS_URL, { ...proxy, NO_PROXY: "upgrade.mikrotik.com" }),
		).toBe(false);
		// A parent domain bypasses the host and its subdomains.
		expect(isProxyConfiguredFor(HTTPS_URL, { ...proxy, NO_PROXY: "mikrotik.com" })).toBe(false);
		expect(isProxyConfiguredFor(HTTPS_URL, { ...proxy, NO_PROXY: ".mikrotik.com" })).toBe(false);
		expect(isProxyConfiguredFor(HTTPS_URL, { ...proxy, NO_PROXY: "*.mikrotik.com" })).toBe(false);
		expect(isProxyConfiguredFor(HTTPS_URL, { ...proxy, NO_PROXY: "*" })).toBe(false);
		expect(isProxyConfiguredFor(HTTPS_URL, { ...proxy, NO_PROXY: "other.com, mikrotik.com" })).toBe(
			false,
		);
		expect(isProxyConfiguredFor(HTTPS_URL, { ...proxy, NO_PROXY: "other.com" })).toBe(true);
		// Substring hosts must not bypass by suffix: "evil-mikrotik.com" is not
		// under "mikrotik.com".
		expect(
			isProxyConfiguredFor("https://evil-mikrotik.com/x", { ...proxy, NO_PROXY: "mikrotik.com" }),
		).toBe(true);
		// Lowercase wins; uppercase is the fallback when it is unset or empty.
		expect(isProxyConfiguredFor(HTTPS_URL, { ...proxy, no_proxy: "mikrotik.com" })).toBe(false);
		expect(
			isProxyConfiguredFor(HTTPS_URL, { ...proxy, no_proxy: "other.com", NO_PROXY: "*" }),
		).toBe(true);
		expect(isProxyConfiguredFor(HTTPS_URL, { ...proxy, no_proxy: "", NO_PROXY: "*" })).toBe(false);
	});

	test("NO_PROXY matches IP literals, CIDR blocks, and host:port", () => {
		const proxy = { HTTP_PROXY: PROXY };
		expect(isProxyConfiguredFor(HTTP_URL, { ...proxy, NO_PROXY: "127.0.0.1" })).toBe(false);
		expect(isProxyConfiguredFor(HTTP_URL, { ...proxy, NO_PROXY: "127.0.0.0/8" })).toBe(false);
		expect(isProxyConfiguredFor(HTTP_URL, { ...proxy, NO_PROXY: "10.0.0.0/8" })).toBe(true);
		// An IP entry matches only that address, never by domain suffix.
		expect(isProxyConfiguredFor(HTTP_URL, { ...proxy, NO_PROXY: "127.0.0.2" })).toBe(true);
		// Port-qualified entries bypass that host on that port only.
		expect(isProxyConfiguredFor(HTTP_URL, { ...proxy, NO_PROXY: "127.0.0.1:8080" })).toBe(false);
		expect(isProxyConfiguredFor(HTTP_URL, { ...proxy, NO_PROXY: "127.0.0.1:9090" })).toBe(true);
		// Default ports count: 443 for https.
		expect(isProxyConfiguredFor(HTTPS_URL, { HTTPS_PROXY: PROXY, NO_PROXY: "mikrotik.com:443" })).toBe(
			false,
		);
		expect(isProxyConfiguredFor(HTTPS_URL, { HTTPS_PROXY: PROXY, NO_PROXY: "mikrotik.com:8443" })).toBe(
			true,
		);
		expect(
			isProxyConfiguredFor("http://[fd00::1]/x", { ...proxy, NO_PROXY: "fd00::/8" }),
		).toBe(false);
		expect(isProxyConfiguredFor("http://[fd00::1]/x", { ...proxy, NO_PROXY: "[fd00::1]" })).toBe(
			false,
		);
		expect(isProxyConfiguredFor("http://[fd00::1]/x", { ...proxy, NO_PROXY: "::1" })).toBe(true);
		// Form variants match numerically, not textually.
		expect(
			isProxyConfiguredFor("http://[0:0:0:0:0:0:0:1]/x", { ...proxy, NO_PROXY: "::1" }),
		).toBe(false);
	});
});
