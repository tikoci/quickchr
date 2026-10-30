/**
 * Resilient HTTP fetch for MikroTik's download hosts.
 *
 * Primary path: a plain `fetch` on the system resolver. This is tried first,
 * accepting the latency cost when it fails — usually small, but up to the
 * resolver's own failure time (the broken CI stub below took 2–26 s). It is
 * dual-stack (happy eyeballs) and on par with curl/most tools, and it honors
 * local DNS configuration —
 * `/etc/hosts` pins, VPN/split-horizon DNS, mirror redirects, IPv6-only egress —
 * which a forced public-DNS+IPv4 path would silently override and could itself
 * turn into a fresh failure mode. So we stay "normal" unless the normal path
 * actually breaks.
 *
 * Fallback: some environments (notably GitHub-hosted CI runners, observed
 * 2026-06) have a broken/slow stub resolver that returns `ESERVFAIL` — slowly,
 * 2 to 26 s — for `upgrade.mikrotik.com` / `download.mikrotik.com`, or hands back
 * only an unreachable AAAA, surfacing as Bun's `errno: 0` ConnectionRefused /
 * FailedToOpenSocket. When the normal fetch fails *that* way (a connection-class
 * error), we retry by resolving the A record against a public DNS server
 * directly (~10 ms), bypassing the host's resolv.conf, and connecting to the
 * IPv4 literal with the `Host` header and TLS SNI preserved so certificate
 * validation still passes. If that attempt fails too, both failures are reported
 * together as a `ResilientFetchError` — the fallback's own error names only an IP
 * literal, which on its own reads as a host nobody configured.
 *
 * Only connection-class failures trigger the fallback; HTTP responses (incl.
 * 5xx) and aborts (`AbortError`, e.g. from `AbortSignal.timeout`) pass through
 * unchanged and are never retried. (A low-level connect `ETIMEDOUT` is a
 * connection-class failure and *is* retried — see `isConnectionFailure`.)
 */

import { promises as dns } from "node:dns";

const PUBLIC_DNS_SERVERS = ["1.1.1.1", "8.8.8.8", "1.0.0.1"];
const DNS_TIMEOUT_MS = 3000;

/** `CODE: message` when the error carries a code, else just the message. */
function describeError(err: unknown): string {
	if (!err || typeof err !== "object") return String(err);
	const e = err as { name?: string; message?: string; code?: string; cause?: { code?: string } };
	const code = e.code ?? e.cause?.code;
	const label = code ?? e.name;
	const message = e.message ?? String(err);
	return label ? `${label}: ${message}` : message;
}

/**
 * Both transports failed: the direct fetch with a connection-class error, and
 * then the public-DNS/IPv4 fallback too.
 *
 * It exists because the fallback's own error is unreadable on its own — it names
 * an IP literal nobody configured and no hostname, so a log cannot distinguish
 * "the system resolver was broken" from "the host refused us" from "public DNS
 * handed back a bad address" (#121). The message carries the URL, both failures,
 * and which address the fallback tried; the direct failure is also the `cause`.
 */
export class ResilientFetchError extends Error {
	/** The hostname both transports were aiming at. */
	readonly host: string;
	/** The IPv4 literal the fallback connected to, from public DNS. */
	readonly address: string;
	/** The fallback transport's failure. The direct attempt's is `cause`. */
	readonly fallbackError: unknown;

	constructor(url: string, address: string, directError: unknown, fallbackError: unknown) {
		const host = new URL(url).hostname;
		super(
			`Fetch failed for ${url} on both transports: ` +
				`system resolver — ${describeError(directError)}; ` +
				`public DNS (${PUBLIC_DNS_SERVERS.join(", ")}) → ${address} — ${describeError(fallbackError)}`,
			{ cause: directError },
		);
		this.name = "ResilientFetchError";
		this.host = host;
		this.address = address;
		this.fallbackError = fallbackError;
	}
}

/**
 * True for the connection-class failures raised when a socket cannot be opened
 * (e.g. IPv4 blocked on an IPv6-only network, or Bun's `errno: 0`
 * ConnectionRefused / FailedToOpenSocket against an unreachable address), plus
 * the standard connect errors. Excludes `AbortError` (aborts/`AbortSignal`
 * timeouts) and HTTP-level outcomes (those carry a Response and never throw
 * here). Used to decide whether to fall back from the normal fetch to the
 * public-DNS IPv4 attempt, and by callers deciding whether a failure is worth
 * another attempt.
 */
export function isConnectionFailure(err: unknown): boolean {
	// Connection-class by construction: fetchResilient raises this only after a
	// direct failure that already passed this test. Callers retrying on a
	// connection failure must keep retrying once the fallback also fails.
	if (err instanceof ResilientFetchError) return true;
	if (!err || typeof err !== "object") return false;
	const e = err as { name?: string; code?: string; errno?: number; cause?: { code?: string } };
	if (e.name === "AbortError") return false;
	const code = e.code ?? e.cause?.code;
	if (
		code === "ConnectionRefused" ||
		code === "FailedToOpenSocket" ||
		code === "ConnectionClosed" ||
		code === "ECONNREFUSED" ||
		code === "ECONNRESET" ||
		code === "EHOSTUNREACH" ||
		code === "ENETUNREACH" ||
		code === "ETIMEDOUT"
	) {
		return true;
	}
	// Bun has also surfaced low-level connect failures as a `TypeError` carrying
	// `errno: 0` (its connect-failure marker; the typed `code`s above catch the
	// current form — Bun 1.3 throws an `Error` with `code: "ConnectionRefused"`,
	// confirmed by probe). Gate on that marker so an unrelated `TypeError` (a real
	// bug) surfaces immediately instead of triggering a pointless DNS retry.
	return e.name === "TypeError" && e.errno === 0;
}

/**
 * Hint attached when an egress proxy refuses a MikroTik host. Sandboxed cloud
 * sessions answer 403 to CONNECT for hosts off their allowlist (#210) — the
 * error message names the refused host, this says what to do about it.
 */
export const PROXY_ALLOWLIST_HINT =
	"Allow *.mikrotik.com in the proxy or sandbox allowed-domains list (or switch to full network access), then retry in a new session — allowlist changes do not apply to a running session.";

/**
 * Hint attached when the egress proxy answers 407 to CONNECT. A credentials
 * problem, not an allowlist refusal: the proxy is reachable and the host may
 * be allowed, but the request carried no (or bad) proxy authentication.
 */
export const PROXY_CREDENTIALS_HINT =
	"The egress proxy requires authentication (HTTP 407) — put credentials in the proxy URL (https://user:password@host:port in HTTPS_PROXY/https_proxy), then retry.";

/**
 * The CONNECT status carried by an `ERR_PROXY_TUNNEL` failure, following the
 * cause chain since runtimes wrap the original failure. `undefined` when the
 * error is not a proxy-tunnel failure, or when the shape carries no status
 * (older runtimes that attach none, message-only matches).
 */
export function proxyTunnelStatus(err: unknown): number | undefined {
	let current: unknown = err;
	for (let depth = 0; depth < 3 && current && typeof current === "object"; depth++) {
		const e = current as {
			name?: string;
			message?: string;
			code?: string;
			status?: unknown;
			cause?: unknown;
		};
		const text = `${e.name ?? ""} ${e.message ?? ""}`;
		if (e.code === "ERR_PROXY_TUNNEL" || /ERR_PROXY_TUNNEL/i.test(text)) {
			// A status-less tunnel node does not stop the scan: a deeper status
			// belongs to the more original failure, which is the operative verdict.
			if (typeof e.status === "number") return e.status;
		}
		current = e.cause;
	}
	return undefined;
}

/**
 * The remediation hint for an error `isProxyRefusal` already accepted: a 407
 * is a credentials problem, everything else (403, shapes with no status) reads
 * as the allowlist refusal. Only meaningful after `isProxyRefusal(err)` is true —
 * a 5xx here would wrongly get the allowlist hint.
 */
export function proxyRefusalHint(err: unknown): string {
	return proxyTunnelStatus(err) === 407 ? PROXY_CREDENTIALS_HINT : PROXY_ALLOWLIST_HINT;
}

/**
 * True when a fetch threw because of an egress-proxy policy verdict on the
 * CONNECT tunnel — terminal, not retriable, and never a connection failure.
 *
 * Bun rejects ANY non-2xx CONNECT answer with `code: "ERR_PROXY_TUNNEL"`,
 * carrying the proxy's `status`/`statusText`/`headers` (docs + local probe,
 * Bun 1.4.4) — so the code alone cannot tell "refused" from "the proxy is
 * sick". The status decides, read through the cause chain: a 5xx is the proxy
 * failing (transient — NOT a refusal, the retry loops own it); 407 is refused
 * for credentials (still a refusal — `proxyRefusalHint` picks its hint); 403,
 * and shapes with no status at all, read as the allowlist refusal.
 *
 * The message branches exist for runtimes/wrappers that drop the code. They
 * deliberately avoid bare "tunnel": a DNS failure for a host with "tunnel" in
 * its name is not a proxy refusal. CONNECT matches case-sensitively — the HTTP
 * method is uppercase, while "Unable to connect" (a connection failure) is not.
 */
export function isProxyRefusal(err: unknown): boolean {
	// A 5xx CONNECT answer is the proxy failing, not refusing — transient, so
	// the retry loops (and never the allowlist verdict) own it.
	const status = proxyTunnelStatus(err);
	if (status !== undefined && status >= 500 && status <= 599) return false;
	let current: unknown = err;
	for (let depth = 0; depth < 3 && current && typeof current === "object"; depth++) {
		const e = current as { name?: string; message?: string; code?: string; cause?: unknown };
		if (e.code === "ERR_PROXY_TUNNEL") return true;
		const text = `${e.name ?? ""} ${e.message ?? ""}`;
		if (/ERR_PROXY_TUNNEL/i.test(text)) return true;
		if (/proxy/i.test(text) && /(403|forbidden)/i.test(text)) return true;
		if (/\bCONNECT\b/.test(text) && /(403|forbidden|denied|refused|refuses|refusal)/i.test(text))
			return true;
		current = e.cause;
	}
	return false;
}

/**
 * True when `value` names a proxy Bun would actually attempt for a request —
 * an `http(s)://` URL or a scheme-less `host[:port]` (Bun defaults those to
 * http, probed). A value naming another kind of proxy (`socks5://…`) is never
 * used as one: on the scheme-specific variables fetch throws
 * `UnsupportedProxyProtocol`, on `ALL_PROXY` it is ignored and the request goes
 * direct (both probed, Bun 1.4.4).
 */
export function isUsableProxyValue(value: string | undefined): boolean {
	if (value === undefined) return false;
	const v = value.trim();
	if (v === "") return false;
	const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.exec(v)?.[0].toLowerCase();
	// No `://` scheme: a bare host[:port], optionally with userinfo — used as-is.
	if (scheme === undefined) return true;
	return scheme === "http://" || scheme === "https://";
}

/**
 * The proxy entry Bun would select for `https:` URLs: the scheme-specific
 * variable wins over `ALL_PROXY`, and within a tier uppercase is shown first
 * (the docs list upper first and document no case precedence). The source
 * variable travels with the value because an unusable scheme fails on
 * `HTTPS_PROXY` but is ignored on `ALL_PROXY` (probed, Bun 1.4.4) — the
 * doctor row cannot diagnose one wording for both.
 * Empty string counts as unset — probed to fall through to the next variable.
 * Whitespace-only is treated the same, matching `isUsableProxyValue`, so the
 * two helpers cannot disagree about which variable is selected.
 */
export function httpsProxyEnvValue(env: NodeJS.ProcessEnv): { name: string; value: string } | undefined {
	const entries: Array<[string, string | undefined]> = [
		["HTTPS_PROXY", env.HTTPS_PROXY],
		["https_proxy", env.https_proxy],
		["ALL_PROXY", env.ALL_PROXY],
		["all_proxy", env.all_proxy],
	];
	const hit = entries.find(([, v]) => v !== undefined && v.trim() !== "");
	if (hit?.[1] === undefined) return undefined;
	return { name: hit[0], value: hit[1].trim() };
}

/** Parse a dotted-quad IPv4 address to its 32-bit value, or undefined. */
function parseIpv4(s: string): number | undefined {
	const parts = s.split(".");
	if (parts.length !== 4) return undefined;
	let n = 0;
	for (const part of parts) {
		if (!/^\d+$/.test(part)) return undefined;
		const b = Number(part);
		if (b > 255) return undefined;
		n = n * 256 + b;
	}
	return n;
}

/** Parse an IPv6 address to its 128-bit value, or undefined. */
function parseIpv6(s: string): bigint | undefined {
	// One `::` may compress one or more zero groups.
	const halves = s.split("::");
	if (halves.length > 2) return undefined;
	const parseGroups = (side: string): number[] | undefined => {
		if (side === "") return [];
		const groups = side.split(":");
		const out: number[] = [];
		for (const g of groups) {
			if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return undefined;
			out.push(Number.parseInt(g, 16));
		}
		return out;
	};
	const left = parseGroups(halves[0] ?? "");
	const right = halves.length === 2 ? parseGroups(halves[1] ?? "") : [];
	if (left === undefined || right === undefined) return undefined;
	if (halves.length === 1 && left.length !== 8) return undefined;
	if (halves.length === 2 && left.length + right.length > 7) return undefined;
	const groups = [...left, ...new Array(8 - left.length - right.length).fill(0), ...right];
	let n = 0n;
	for (const g of groups) n = (n << 16n) | BigInt(g);
	return n;
}

/** True when the IP-literal `host` is inside the `base/prefix` CIDR block. */
function inCidrBlock(host: string, base: string, prefixText: string): boolean {
	if (!/^\d+$/.test(prefixText)) return false;
	if (base.includes(":")) {
		const prefix = Number(prefixText);
		if (prefix > 128) return false;
		const hostNum = parseIpv6(host);
		const baseNum = parseIpv6(base);
		if (hostNum === undefined || baseNum === undefined) return false;
		const shift = BigInt(128 - prefix);
		return (hostNum >> shift) === (baseNum >> shift);
	}
	const prefix = Number(prefixText);
	if (prefix > 32) return false;
	const hostNum = parseIpv4(host);
	const baseNum = parseIpv4(base);
	if (hostNum === undefined || baseNum === undefined) return false;
	// >>> 0 keeps the 32-bit shifts unsigned (a /0's shift-by-32 is a no-op in
	// JS, but `>>> 0` still normalizes both sides for the comparison).
	return prefix === 0 || hostNum >>> (32 - prefix) === baseNum >>> (32 - prefix);
}

/**
 * True when one `NO_PROXY` entry bypasses `host` (lowercased, brackets
 * stripped) on `port`. Mirrors Bun's documented entry table: `*`, bare /
 * dot-prefixed / star-prefixed domains (host plus subdomains), IP literals,
 * CIDR blocks, and `host:port` (that host on that port only).
 */
function matchesNoProxyEntry(host: string, port: number, entry: string): boolean {
	const e = entry.toLowerCase();
	if (e === "*") return true;
	// CIDR carries no port form — a "/" always means a block.
	const slash = e.indexOf("/");
	if (slash !== -1) {
		return inCidrBlock(host, e.slice(0, slash), e.slice(slash + 1));
	}
	let entryHost = e;
	let entryPort: string | undefined;
	if (e.startsWith("[")) {
		const close = e.indexOf("]");
		if (close === -1) return false;
		entryHost = e.slice(1, close);
		const rest = e.slice(close + 1);
		if (rest !== "") {
			if (!rest.startsWith(":")) return false;
			entryPort = rest.slice(1);
		}
	} else if (e.indexOf(":") === e.lastIndexOf(":") && e.includes(":")) {
		// Exactly one colon: host:port. A bare IPv6 literal has two or more and
		// can only take a port in brackets.
		entryHost = e.slice(0, e.indexOf(":"));
		entryPort = e.slice(e.indexOf(":") + 1);
	}
	if (entryPort !== undefined && (!/^\d+$/.test(entryPort) || Number(entryPort) !== port)) {
		return false;
	}
	// An IP-literal entry compares numerically — never by domain suffix, and
	// across form variants ("::1" still matches "0:0:0:0:0:0:0:1").
	const entryIpv4 = parseIpv4(entryHost);
	if (entryIpv4 !== undefined) return parseIpv4(host) === entryIpv4;
	const entryIpv6 = parseIpv6(entryHost);
	if (entryIpv6 !== undefined) return parseIpv6(host) === entryIpv6;
	const base = entryHost.replace(/^\*\./, "").replace(/^\./, "");
	return host === base || host.endsWith(`.${base}`);
}

/**
 * True when `fetch(url)` would go through a proxy from the environment: a
 * usable proxy URL is configured for the URL's scheme and `NO_PROXY` does not
 * bypass the host. Mirrors Bun's selection (docs + local probes, Bun 1.4.4):
 * `HTTP_PROXY` only for `http:` URLs, `HTTPS_PROXY` only for `https:` URLs
 * (either case), `ALL_PROXY` for both when the scheme-specific variable is
 * unset, non-`http(s)` values never proxied, `no_proxy`/`NO_PROXY` (lowercase
 * first) bypassing per the documented entry table.
 *
 * Precedence between two SET variables needs no ordering here: the question is
 * only whether a usable proxy is in play, and any usable one answers it. (A
 * set-but-fatal value, e.g. scheme-specific `socks5://`, throws before any
 * response can arrive, so verdict-time callers never observe that conflict.)
 */
export function isProxyConfiguredFor(url: string, env: NodeJS.ProcessEnv = process.env): boolean {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return false;
	}
	const schemeVars =
		u.protocol === "https:"
			? [env.HTTPS_PROXY, env.https_proxy]
			: u.protocol === "http:"
				? [env.HTTP_PROXY, env.http_proxy]
				: [];
	if (schemeVars.length === 0) return false;
	const usable = [...schemeVars, env.ALL_PROXY, env.all_proxy].some(isUsableProxyValue);
	if (!usable) return false;
	// Bun reads NO_PROXY when no_proxy is unset or empty, like curl and Node.js.
	const noProxy =
		env.no_proxy !== undefined && env.no_proxy !== "" ? env.no_proxy : env.NO_PROXY;
	if (noProxy === undefined || noProxy === "") return true;
	const rawHost = u.hostname.toLowerCase();
	const host = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;
	const port = u.port !== "" ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
	for (const entry of noProxy.split(/[,\s]+/)) {
		if (entry === "") continue;
		if (matchesNoProxyEntry(host, port, entry)) return false;
	}
	return true;
}

/** Rewrite a URL to target an explicit IPv4 literal, preserving port/path/query. */
export function toIpv4Url(url: string, address: string): string {
	const u = new URL(url);
	u.hostname = address;
	return u.toString();
}

/**
 * Resolve a host's A record via public DNS servers directly, bypassing the
 * host's resolv.conf. Used only as the fallback path, after a normal fetch has
 * already failed with a connection-class error (e.g. a broken stub resolver on
 * CI runners). Returns undefined — never throws — when public DNS is unreachable
 * or has no answer, so the caller can surface the original failure. Bounded by
 * DNS_TIMEOUT_MS so a blocked resolver does not stall the request.
 */
async function resolveIpv4(host: string): Promise<string | undefined> {
	const resolver = new dns.Resolver();
	resolver.setServers(PUBLIC_DNS_SERVERS);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const addresses = await Promise.race([
			resolver.resolve4(host),
			new Promise<string[]>((_, reject) => {
				timer = setTimeout(() => reject(new Error("public DNS timeout")), DNS_TIMEOUT_MS);
			}),
		]);
		return addresses[0];
	} catch {
		return undefined;
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * Fetch `url` but connect to an explicit IPv4 `address`, keeping HTTP and TLS
 * pointed at the original host: the `Host` header and TLS SNI (`serverName`) are
 * set to the URL's hostname so virtual-hosting routing and certificate
 * validation still pass against the IP literal. The failback transport.
 */
async function fetchOverIpv4(
	url: string,
	address: string,
	init?: BunFetchRequestInit,
): Promise<Response> {
	const host = new URL(url).hostname;
	const headers = new Headers(init?.headers);
	headers.set("Host", host);
	return fetch(toIpv4Url(url, address), {
		...init,
		headers,
		// serverName last: it must pin to the real host for cert validation against
		// the IP literal — a caller-provided init.tls.serverName must not override it.
		tls: { ...init?.tls, serverName: host },
	});
}

/**
 * `fetch()` that tries the system resolver first (a normal dual-stack fetch)
 * and, only when that fails with a connection-class error, falls back to
 * resolving via public DNS and connecting over the IPv4 literal — so it survives
 * a broken/slow system resolver (e.g. GitHub-hosted CI runners) without
 * overriding local DNS in the common case. Behaves like `fetch` for HTTP
 * responses and aborts.
 */
export async function fetchResilient(url: string, init?: BunFetchRequestInit): Promise<Response> {
	try {
		return await fetch(url, init);
	} catch (err) {
		// A proxy policy refusal never sees the fallback — no resolver can clear
		// it, and in a proxied sandbox there is no direct egress to fall back to.
		// Stated explicitly rather than relying on the predicates below never
		// overlapping: even a shape matching both must not be retried over IPv4.
		if (isProxyRefusal(err)) throw err;
		// Only a connection-class failure (e.g. a broken/slow stub resolver, or an
		// unreachable AAAA) is worth the public-DNS workaround. Aborts (AbortError)
		// and everything else propagate unchanged.
		if (!isConnectionFailure(err)) throw err;
		const address = await resolveIpv4(new URL(url).hostname);
		// Public DNS can't help (unreachable / no answer) — surface the original failure.
		if (address === undefined) throw err;
		try {
			return await fetchOverIpv4(url, address, init);
		} catch (fallbackErr) {
			// Never let the fallback's error stand alone: it names only an IP literal,
			// which is the one thing the reader cannot map back to what was attempted.
			throw new ResilientFetchError(url, address, err, fallbackErr);
		}
	}
}
