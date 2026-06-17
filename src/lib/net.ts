/**
 * Resilient HTTP fetch for MikroTik's download hosts.
 *
 * On GitHub-hosted CI runners the system DNS resolver returns `ESERVFAIL`
 * (slowly — 2 to 26 s) for `upgrade.mikrotik.com` / `download.mikrotik.com` via
 * both `getaddrinfo` and c-ares-over-resolv.conf, so a plain `fetch` either
 * times out or (when the stub hands back only the unreachable AAAA) fails with
 * Bun's `errno: 0` ConnectionRefused / FailedToOpenSocket. A direct query to a
 * public resolver answers in ~10 ms, and the hosts are dual-stack with a
 * reachable IPv4. quickchr is expected to run unattended in CI, so it resolves
 * these hosts itself rather than trusting the runner's broken resolver.
 *
 * Strategy: resolve the A record by querying a public DNS server directly
 * (bypassing the host's resolv.conf), then connect to the IPv4 literal,
 * preserving the `Host` header and TLS SNI so certificate validation still
 * passes. Fall back to a normal `fetch` (system resolver, dual-stack) when the
 * public-DNS path is unavailable — e.g. a network that blocks public resolvers
 * — so this stays correct off CI. HTTP responses and aborts/timeouts pass
 * through unchanged; they are never retried.
 */

import { promises as dns } from "node:dns";

const PUBLIC_DNS_SERVERS = ["1.1.1.1", "8.8.8.8", "1.0.0.1"];
const DNS_TIMEOUT_MS = 3000;

/**
 * True for the connection-class failures raised when a socket cannot be opened
 * (e.g. IPv4 blocked on an IPv6-only network, or Bun's `errno: 0`
 * ConnectionRefused / FailedToOpenSocket against an unreachable address), plus
 * the standard connect errors. Excludes aborts/timeouts and HTTP-level outcomes
 * (those carry a Response and never throw here). Used to decide whether to fall
 * back from the IPv4 attempt to a normal dual-stack fetch.
 */
export function isConnectionFailure(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const e = err as { name?: string; code?: string; cause?: { code?: string } };
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
	// Bun wraps low-level connect failures as a bare TypeError ("Unable to
	// connect…"). Treat those as retriable too; a wrong guess only costs one
	// normal fetch, which then surfaces the real error if it also fails.
	return e.name === "TypeError";
}

/** Rewrite a URL to target an explicit IPv4 literal, preserving port/path/query. */
export function toIpv4Url(url: string, address: string): string {
	const u = new URL(url);
	u.hostname = address;
	return u.toString();
}

/**
 * Resolve a host's A record via public DNS servers directly, bypassing the
 * host's resolv.conf (which is broken for these names on CI runners). Returns
 * undefined — never throws — when public DNS is unreachable or has no answer,
 * so the caller can fall back to a normal fetch. Bounded by DNS_TIMEOUT_MS so a
 * blocked resolver does not stall the request.
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
		tls: { serverName: host, ...init?.tls },
	});
}

/**
 * `fetch()` that resolves dual-stack hosts via public DNS and connects over
 * IPv4, so it survives a broken/slow system resolver (e.g. GitHub-hosted CI
 * runners). Falls back to a normal `fetch` when public DNS is unavailable.
 * Behaves like `fetch` for HTTP responses and aborts.
 */
export async function fetchResilient(url: string, init?: BunFetchRequestInit): Promise<Response> {
	const address = await resolveIpv4(new URL(url).hostname);
	if (address) {
		try {
			return await fetchOverIpv4(url, address, init);
		} catch (err) {
			if (!isConnectionFailure(err)) throw err;
			// IPv4 unreachable (e.g. IPv6-only egress) — fall through to a normal fetch.
		}
	}
	return fetch(url, init);
}
