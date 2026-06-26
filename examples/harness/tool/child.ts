/**
 * child.ts — a stand-in for an *external* RouterOS tool driven against a live CHR.
 *
 * It receives nothing but the connection environment that quickchr's
 * `ChrInstance.subprocessEnv()` injects, and talks to the CHR's REST API on its
 * own. This is the pattern restraml / centrs use: quickchr owns the VM lifecycle;
 * the child only needs the env.
 *
 * Important: `BASICAUTH` / `QUICKCHR_AUTH` are the raw `user:password` string, NOT
 * a ready-made header. Base64-encode it yourself for HTTP Basic auth.
 */

const urlbase = process.env.URLBASE; //   e.g. http://127.0.0.1:9180/rest
const basicauth = process.env.BASICAUTH; // raw "user:password" (secret-bearing)

if (!urlbase || !basicauth) {
	console.error("missing URLBASE / BASICAUTH in env");
	process.exit(2);
}

const res = await fetch(`${urlbase}/system/resource`, {
	headers: { Authorization: `Basic ${btoa(basicauth)}` },
	signal: AbortSignal.timeout(10_000),
});

if (!res.ok) {
	console.error(`CHR REST returned HTTP ${res.status}`);
	process.exit(1);
}

const body = (await res.json()) as Record<string, string>;
// Print the board name so the parent can assert the child reached the CHR.
console.log(body["board-name"] ?? "");
