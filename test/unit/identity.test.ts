import { describe, expect, test } from "bun:test";
import { applyIdentity, type IdentityIo } from "../../src/lib/identity.ts";
import type { RestResponse } from "../../src/lib/rest.ts";

type Answer = RestResponse | Error;

/** A fake REST endpoint on a fake clock: scripted answers for set and read-back,
 *  recorded calls with the timeout each was given. `costMs` is how long each request
 *  takes on the clock; `sleep` advances it by what was asked. */
function fakeIo(set: Answer[], get: Answer[], costMs = 0) {
	const calls: string[] = [];
	const timeouts: number[] = [];
	let clock = 0;
	const next = (queue: Answer[]) => {
		const r = queue.length > 1 ? queue.shift() : queue[0];
		if (r instanceof Error) throw r;
		return r as RestResponse;
	};
	const io: IdentityIo = {
		post: async (url, _auth, body, timeoutMs) => {
			calls.push(`POST ${url.replace(/^http:\/\/127\.0\.0\.1:\d+/, "")} ${JSON.stringify(body)}`);
			timeouts.push(timeoutMs);
			clock += Math.min(costMs, timeoutMs);
			return next(set);
		},
		get: async (url, _auth, timeoutMs) => {
			calls.push(`GET ${url.replace(/^http:\/\/127\.0\.0\.1:\d+/, "")}`);
			timeouts.push(timeoutMs);
			clock += Math.min(costMs, timeoutMs);
			return next(get);
		},
		sleep: async (ms) => {
			clock += ms;
		},
		now: () => clock,
	};
	return { io, calls, timeouts, elapsed: () => clock };
}

const ok = (body: unknown): RestResponse => ({ status: 200, body: JSON.stringify(body) }) as RestResponse;
const SET = 'POST /rest/system/identity/set {"name":"lab-1"}';
const GET = "GET /rest/system/identity";

async function failure(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (e) {
		return e as Error;
	}
	throw new Error("expected a rejection");
}

describe("applyIdentity (#265)", () => {
	test("sets the name once and polls the read-back through the post-boot race", async () => {
		const { io, calls } = fakeIo(
			[ok([])],
			[ok({ "board-name": "CHR" }), ok({ name: "CHR" }), ok({ name: "lab-1" })],
		);
		await applyIdentity(9100, "lab-1", "Basic x", 30_000, io);
		expect(calls).toEqual([SET, GET, GET, GET]);
	});

	test("a set answered with another menu's data did not land, and is sent again", async () => {
		// The startup race: a provisioning POST can answer with /system/resource's body.
		const { io, calls } = fakeIo(
			[ok({ "board-name": "CHR", "architecture-name": "x86_64" }), ok([])],
			[ok({ name: "lab-1" })],
		);
		await applyIdentity(9100, "lab-1", "Basic x", 30_000, io);
		expect(calls).toEqual([SET, SET, GET]);
	});

	test("a RouterOS failure (4xx) on the set is final, with RouterOS's words", async () => {
		const { io, calls } = fakeIo(
			[{ status: 400, body: '{"detail":"failure: could not change identity: too long"}' } as RestResponse],
			[ok({ name: "CHR" })],
		);
		await expect(applyIdentity(9100, "x".repeat(65), "Basic x", 30_000, io)).rejects.toThrow("too long");
		expect(calls).toHaveLength(1);
	});

	test("a 4xx on the read-back is final too, with status and body", async () => {
		const { io, calls } = fakeIo(
			[ok([])],
			[{ status: 401, body: '{"error":401,"message":"Unauthorized"}' } as RestResponse, ok({ name: "lab-1" })],
		);
		const err = await failure(applyIdentity(9100, "lab-1", "Basic x", 30_000, io));
		expect(err.message).toContain("HTTP 401");
		expect(err.message).toContain('"message":"Unauthorized"');
		expect(calls).toEqual([SET, GET]);
	});

	test("connection errors and 5xx retry until the set lands", async () => {
		const { io, calls } = fakeIo(
			[new Error("ECONNREFUSED"), { status: 500, body: "" } as RestResponse, ok([])],
			[ok({ name: "lab-1" })],
		);
		await applyIdentity(9100, "lab-1", "Basic x", 30_000, io);
		expect(calls.filter((c) => c.startsWith("POST"))).toHaveLength(3);
	});

	test("gives up with the last answer when the read-back never matches", async () => {
		const { io, calls } = fakeIo([ok([])], [ok({ name: "CHR" })]);
		const err = await failure(applyIdentity(9100, "lab-1", "Basic x", 5_000, io));
		expect(err.message).toContain('did not read back as "lab-1"');
		expect(err.message).toContain('{"name":"CHR"}');
		expect(calls.filter((c) => c === GET).length).toBeGreaterThan(1);
	});

	test("each request and delay is capped to what is left of the budget", async () => {
		// A guest that never answers: every request runs to its timeout.
		const { io, calls, timeouts, elapsed } = fakeIo([ok([])], [ok({ name: "CHR" })], 60_000);
		await failure(applyIdentity(9100, "lab-1", "Basic x", 15_000, io));
		// The set takes 10 s; the read-back gets the 5 s that are left, not 10 more.
		expect(calls).toEqual([SET, GET]);
		expect(timeouts).toEqual([10_000, 5_000]);
		expect(elapsed()).toBe(15_000);
	});

	test("no read-back is started once the set has used the whole budget", async () => {
		const { io, calls, elapsed } = fakeIo([ok([])], [ok({ name: "lab-1" })], 60_000);
		const err = await failure(applyIdentity(9100, "lab-1", "Basic x", 8_000, io));
		expect(calls).toEqual([SET]);
		expect(elapsed()).toBe(8_000);
		expect(err.message).toContain("no time left to read it back");
	});
});
