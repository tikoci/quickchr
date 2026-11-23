import { describe, expect, test } from "bun:test";
import { applyIdentity, type IdentityIo } from "../../src/lib/identity.ts";
import type { RestResponse } from "../../src/lib/rest.ts";

/** A fake REST endpoint: scripted answers for set and read-back, recorded calls. */
function fakeIo(set: Array<RestResponse | Error>, get: Array<RestResponse | Error>) {
	const calls: string[] = [];
	const next = (queue: Array<RestResponse | Error>) => {
		const r = queue.length > 1 ? queue.shift() : queue[0];
		if (r instanceof Error) throw r;
		return r as RestResponse;
	};
	const io: IdentityIo = {
		post: async (url, _auth, body) => {
			calls.push(`POST ${url.replace(/^http:\/\/127\.0\.0\.1:\d+/, "")} ${JSON.stringify(body)}`);
			return next(set);
		},
		get: async (url) => {
			calls.push(`GET ${url.replace(/^http:\/\/127\.0\.0\.1:\d+/, "")}`);
			return next(get);
		},
		sleep: async () => {},
	};
	return { io, calls };
}

const ok = (body: unknown): RestResponse => ({ status: 200, body: JSON.stringify(body) }) as RestResponse;

describe("applyIdentity (#265)", () => {
	test("sets the name once and polls the read-back through the post-boot race", async () => {
		const { io, calls } = fakeIo(
			[ok([])],
			[ok({ "board-name": "CHR" }), ok({ name: "CHR" }), ok({ name: "lab-1" })],
		);
		await applyIdentity(9100, "lab-1", "Basic x", 30_000, io);
		expect(calls).toEqual([
			'POST /rest/system/identity/set {"name":"lab-1"}',
			"GET /rest/system/identity",
			"GET /rest/system/identity",
			"GET /rest/system/identity",
		]);
	});

	test("a RouterOS failure (4xx) is final, with RouterOS's words", async () => {
		const { io, calls } = fakeIo(
			[{ status: 400, body: '{"detail":"failure: could not change identity: too long"}' } as RestResponse],
			[ok({ name: "CHR" })],
		);
		await expect(applyIdentity(9100, "x".repeat(65), "Basic x", 30_000, io)).rejects.toThrow("too long");
		expect(calls).toHaveLength(1);
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
		const { io } = fakeIo([ok([])], [ok({ name: "CHR" })]);
		await expect(applyIdentity(9100, "lab-1", "Basic x", 0, io)).rejects.toThrow('did not read back as "lab-1"');
	});
});
