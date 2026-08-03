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
