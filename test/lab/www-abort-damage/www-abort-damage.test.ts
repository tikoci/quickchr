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
 * ~6 s of the last abort. See REPORT.md.
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

const SKIP = !process.env.QUICKCHR_INTEGRATION || !process.env.QUICKCHR_LAB_PORT;
const PORT = Number(process.env.QUICKCHR_LAB_PORT ?? 0);
const PATH = "/rest/system/resource";

const BOGUS = `Basic ${btoa("cleanuser:CleanPass1")}`;
const ADMIN = `Basic ${btoa("admin:")}`;

/**
 * One connection. `abortAfterMs === null` lets it complete; otherwise the
 * socket is destroyed with the request in flight, as restGet() does at its
 * deadline. Returns the status code, "ABORT" (we tore it down) or "RST" (the
 * guest tore it down).
 */
function connect(auth: string, abortAfterMs: number | null): Promise<string> {
	return new Promise((resolve) => {
		let done = false;
		const timer = abortAfterMs === null ? null : setTimeout(() => {
			if (!done) { done = true; req.destroy(); resolve("ABORT"); }
		}, abortAfterMs);
		const req = nodeRequest(
			{
				hostname: "127.0.0.1", port: PORT, path: PATH, method: "GET",
				headers: { Authorization: auth, Connection: "close" }, agent: false,
			},
			(res) => {
				res.on("data", () => { /* drain */ });
				res.on("end", () => {
					if (!done) { done = true; if (timer) clearTimeout(timer); resolve(String(res.statusCode)); }
				});
			},
		);
		req.on("error", () => { if (!done) { done = true; if (timer) clearTimeout(timer); resolve("RST"); } });
		req.end();
	});
}

/** Health via curl — a separate process, so no Bun socket state is shared.
 *  curl exit 56 = connection reset while receiving. */
async function curlProbe(): Promise<string> {
	const p = Bun.spawn([
		"curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
		"--max-time", "20", "-u", "admin:", `http://127.0.0.1:${PORT}${PATH}`,
	], { stdout: "pipe", stderr: "pipe" });
	const out = (await new Response(p.stdout).text()).trim();
	return (await p.exited) === 0 ? out : "RST";
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
		const flat = pairs.flat();

		// Observed identically on x86/HVF and arm64/TCG:
		//   [ABORT/200  RST/RST  RST/RST  ABORT/401]
		// The guest resets connections from the second pair on …
		expect(flat.filter((o) => o === "RST").length).toBeGreaterThanOrEqual(2);
		// … and admin: with a valid empty password is answered 401 — the status
		// belonging to the aborted cleanuser request, delivered to the wrong
		// connection. This is the corruption that matters: not a lost response,
		// a WRONG one. Same family as #69.
		expect(flat).toContain("401");
		// Damage outlives the loop.
		expect(await curlProbe()).toBe("RST");
	}, 60_000);

	test("www recovers on its own within ~6 s", async () => {
		await settle();
		expect(await curlProbe()).toBe("200");
	}, 30_000);
});
