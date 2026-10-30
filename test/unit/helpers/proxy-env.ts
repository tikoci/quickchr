/**
 * Swap the proxy environment for a test, and put it back.
 *
 * Every variable the proxy verdict reads is covered — the developer's own shell
 * may export any of them. Two passes, clear then assign, because Windows env
 * names are case-insensitive: a one-pass loop that set `HTTPS_PROXY` and then
 * deleted `https_proxy` deleted the value it had just set, so the "proxy
 * configured" tests ran with no proxy at all on Windows only. Only variables
 * that are actually set are deleted, so a swap on a clean environment leaves
 * nothing behind but what the test asked for.
 */

const PROXY_ENV_KEYS = [
	"HTTPS_PROXY",
	"https_proxy",
	"HTTP_PROXY",
	"http_proxy",
	"ALL_PROXY",
	"all_proxy",
	"NO_PROXY",
	"no_proxy",
];

export type ProxyEnv = Record<string, string | undefined>;

function replaceProxyEnv(values: ProxyEnv): void {
	for (const key of PROXY_ENV_KEYS) {
		if (process.env[key] !== undefined) delete process.env[key];
	}
	for (const key of PROXY_ENV_KEYS) {
		const value = values[key];
		if (value !== undefined) process.env[key] = value;
	}
}

/** Replace the proxy variables with `next` (unlisted ones unset); returns what to restore. */
export function swapProxyEnv(next: ProxyEnv): ProxyEnv {
	const prev: ProxyEnv = {};
	for (const key of PROXY_ENV_KEYS) prev[key] = process.env[key];
	replaceProxyEnv(next);
	return prev;
}

export function restoreProxyEnv(prev: ProxyEnv): void {
	replaceProxyEnv(prev);
}
