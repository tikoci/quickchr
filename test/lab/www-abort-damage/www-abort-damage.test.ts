/**
 * Lab: aborting a REST request mid-flight damages RouterOS `www` (#79, #69).
 *
 * FINDING: An aborted request is harmless on its own. What breaks `www` is an
 * aborted request FOLLOWED BY A COMPLETED ONE on a new connection. Repeat that
 * pair and, from the second iteration on, `www` resets every incoming
 * connection, and one of the surviving connections receives the response
 * computed for the ABORTED request — an `admin:` probe with a valid empty
 * password is answered `401`, the status belonging to the aborted bogus-
 * credential request.
 *
 * That pair is exactly what `waitForBoot()` produces: `restGet(url, auth, 3000)`
 * (src/lib/qemu.ts:538) calls `req.destroy()` when a probe overruns its
 * hardcoded 3 s deadline (src/lib/rest.ts:41), then probes again 2 s later.
 *
 * GROUNDING: reproduced on RouterOS 7.21.5 on an Intel Mac, both x86 under HVF
 * and arm64 under cross-arch TCG, so it is not arm64-specific. Health is
 * checked with `curl` in a separate process, so it is not a Bun `node:http`
 * socket-reuse artifact — the damage is guest-side. Two runs of the
 * discriminating experiment produced identical output.
 *
 * NOT ESTABLISHED: the permanent wedge seen in CI. Here `www` recovers within
 * 1.3–2.4 s after the last abort. See REPORT.md.
 *
 * Lab probe, not a CI gate. Run against a running CHR:
 *
 *   quickchr add --name lab-abort --version 7.21.5 --no-secure-login
 *   quickchr start lab-abort --background
 *   QUICKCHR_INTEGRATION=1 QUICKCHR_LAB_PORT=9170 \
 *     bun test test/lab/www-abort-damage/www-abort-damage.test.ts
 */

import { describe, test, expect } from "bun:test";
import { request as nodeRequest } from "node:http";

const PORT = Number(process.env.QUICKCHR_LAB_PORT ?? 0);
// Gate matches every other test file in the repo (`!process.env.QUICKCHR_INTEGRATION`);
// the port must also be a real one, or the whole file would "pass" against nothing.
const SKIP = !process.env.QUICKCHR_INTEGRATION || !Number.isInteger(PORT) || PORT < 1 || PORT > 65535;
const PATH = "/rest/system/resource";

const BOGUS = `Basic ${btoa("cleanuser:CleanPass1")}`;
const ADMIN = `Basic ${btoa("admin:")}`;

/**
 * One connection. `abortAfterMs === null` lets it complete; otherwise the
 * socket is destroyed with the request in flight, as restGet() does at its
 * deadline.
 *
 * Outcomes are classified, never collapsed: only a genuine `ECONNRESET` counts
 * as "RST". A refusal, a stall, or any other error gets its own label, so the
 * reset assertions below cannot be satisfied by an unrelated failure — the
 * whole claim of this lab is that *the guest* resets the connection.
 */
function connect(auth: string, abortAfterMs: number | null): Promise<string> {
	return new Promise((resolve) => {
		let done = false;
		const settle = (v: string) => { if (!done) { done = true; if (timer) clearTimeout(timer); if (stall) clearTimeout(stall); resolve(v); } };
		const timer = abortAfterMs === null ? null : setTimeout(() => {
			if (!done) { req.destroy(); settle("ABORT"); }
		}, abortAfterMs);
		// A request we intend to complete must not hang the suite.
		const stall = setTimeout(() => { if (!done) { req.destroy(); settle("STALL"); } }, 20_000);
		const req = nodeRequest(
			{
				hostname: "127.0.0.1", port: PORT, path: PATH, method: "GET",
				headers: { Authorization: auth, Connection: "close" }, agent: false,
			},
			(res) => {
				res.on("data", () => { /* drain */ });
				res.on("end", () => settle(String(res.statusCode)));
				res.on("error", (e) => settle(classify(e)));
			},
		);
		req.on("error", (e) => settle(classify(e)));
		req.end();
	});
}

/** Distinguish "the guest reset us" from every other way a request can fail. */
function classify(e: unknown): string {
	const code = (e as NodeJS.ErrnoException)?.code;
	if (code === "ECONNRESET") return "RST";
	if (code === "ECONNREFUSED") return "REFUSED";
	if (code) return `ERR-${code}`;
	// Bun's node:http shim does not always populate `code` on a peer reset;
	// fall back to the message, but only for the reset shape.
	const msg = (e as Error)?.message ?? "";
	if (/closed unexpectedly|socket hang up|ECONNRESET|reset by peer/i.test(msg)) return "RST";
	return `ERR-${msg.slice(0, 30)}`;
}

/**
 * Health via curl — a separate process, so no Bun socket state is shared.
 * curl exit codes are mapped individually for the same reason as `classify()`:
 * 56 is "reset while receiving", and nothing else may masquerade as it.
 */
async function curlProbe(): Promise<string> {
	const p = Bun.spawn([
		"curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
		"--max-time", "20", "-u", "admin:", `http://127.0.0.1:${PORT}${PATH}`,
	], { stdout: "pipe", stderr: "ignore" });
	const out = (await new Response(p.stdout).text()).trim();
	const rc = await p.exited;
	if (rc === 0) return out;
	if (rc === 56) return "RST";       // recv failure: connection reset by peer
	if (rc === 7) return "REFUSED";    // failed to connect
	if (rc === 28) return "TIMEOUT";   // --max-time exceeded
	if (rc === 127) return "NO-CURL";  // curl missing — a broken lab, not a finding
	return `curl-rc${rc}`;
}

/** www recovers on its own; settle before each pattern so rounds are independent. */
const settle = () => Bun.sleep(6000);

describe.skipIf(SKIP)("RouterOS www — aborted REST requests", () => {
	test("baseline: www answers admin: immediately", async () => {
		expect(await curlProbe()).toBe("200");
	}, 30_000);

	test("a failed login answers well inside restGet's 3 s deadline", async () => {
		// Why the credential half of #79 is not on its own fatal: waitForBoot()
		// counts 401 as "the REST layer responded", so probing as a user the
		// factory reset deleted would still satisfy it — if the answer arrives.
		const t0 = Date.now();
		expect(await connect(BOGUS, null)).toBe("401");
		expect(Date.now() - t0).toBeLessThan(3000);
	}, 30_000);

	test("aborts alone are harmless — 4 of them, nothing completing in between", async () => {
		await settle();
		const outcomes: string[] = [];
		for (let i = 0; i < 4; i++) { outcomes.push(await connect(BOGUS, 50)); await Bun.sleep(1000); }
		expect(outcomes).toEqual(["ABORT", "ABORT", "ABORT", "ABORT"]);
		expect(await curlProbe()).toBe("200");
		expect(await curlProbe()).toBe("200");
	}, 60_000);

	test("abort-then-complete, repeated, breaks www", async () => {
		await settle();
		const pairs: Array<[string, string]> = [];
		for (let i = 0; i < 4; i++) {
			pairs.push([await connect(BOGUS, 50), await connect(ADMIN, null)]);
			await Bun.sleep(1000);
		}
		// Observed identically on x86/HVF and arm64/TCG:
		//   [ABORT/200  RST/RST  RST/RST  ABORT/401]

		// The guest resets connections from the second pair on. Assert on the
		// SECOND slot of each pair — the request we let complete — so a reset of
		// the request we were going to abort anyway cannot satisfy this.
		const completed = pairs.map(([, c]) => c);
		expect(completed.filter((o) => o === "RST").length).toBeGreaterThanOrEqual(2);

		// The corruption that matters. `admin:` carries a valid empty password,
		// so 401 is not a legitimate answer to it — it is the status computed for
		// the ABORTED cleanuser request in the same pair, delivered to the wrong
		// connection. Asserting on the pair (not on a flattened list) is what
		// makes this evidence of wrong-response delivery: a 401 in the abort slot
		// would just be the bogus request answering normally.
		expect(pairs.some(([aborted, admin]) => aborted === "ABORT" && admin === "401")).toBe(true);

		// Damage outlives the loop.
		expect(await curlProbe()).toBe("RST");
	}, 60_000);

	test("www recovers on its own, measured at 1.3–2.4 s", async () => {
		// Polled rather than a fixed sleep: recovery time varies with host and
		// TCG scheduling, and the claim being recorded is "it recovers", not
		// "it recovers in exactly 6 s".
		const deadline = Date.now() + 60_000;
		let last = "";
		let recoveredAfterMs = 0;
		const t0 = Date.now();
		while (Date.now() < deadline) {
			last = await curlProbe();
			if (last === "200") { recoveredAfterMs = Date.now() - t0; break; }
			await Bun.sleep(1000);
		}
		console.log(`  www recovered after ${recoveredAfterMs} ms`);
		expect(last).toBe("200");
	}, 90_000);
});
