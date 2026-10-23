import { describe, test, expect } from "bun:test";
import { renameWithRetry } from "../../src/lib/rename.ts";

/** Anchors the Windows publish retry (#202): a scanner holding a fresh file makes
 *  `rename` fail with EPERM/EACCES/EBUSY for a moment, and quickchr waits it out
 *  within a bounded budget instead of failing the cache publish. */

function failing(times: number, code: string) {
	const calls: Array<[string, string]> = [];
	return {
		calls,
		rename(from: string, to: string) {
			calls.push([from, to]);
			if (calls.length <= times) throw Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
		},
	};
}

describe("renameWithRetry", () => {
	test("on Windows, retries a transient sharing violation until the rename succeeds", () => {
		const sleeps: number[] = [];
		const fake = failing(2, "EPERM");
		renameWithRetry("a.tmp", "a", { platform: "win32", rename: fake.rename, sleep: (ms) => sleeps.push(ms) });
		expect(fake.calls).toEqual([["a.tmp", "a"], ["a.tmp", "a"], ["a.tmp", "a"]]);
		expect(sleeps).toEqual([25, 50]);
	});

	test("on Windows, EACCES and EBUSY are retried too", () => {
		for (const code of ["EACCES", "EBUSY"]) {
			const fake = failing(1, code);
			renameWithRetry("a.tmp", "a", { platform: "win32", rename: fake.rename, sleep: () => {} });
			expect(fake.calls.length).toBe(2);
		}
	});

	test("on Windows, gives up after the bounded budget with the original error", () => {
		const sleeps: number[] = [];
		const fake = failing(Number.POSITIVE_INFINITY, "EPERM");
		expect(() =>
			renameWithRetry("a.tmp", "a", { platform: "win32", rename: fake.rename, sleep: (ms) => sleeps.push(ms) }),
		).toThrow("EPERM");
		expect(fake.calls.length).toBe(7);
		expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(1575);
	});

	test("on Windows, a non-transient error is thrown at once", () => {
		const fake = failing(1, "ENOENT");
		expect(() => renameWithRetry("a.tmp", "a", { platform: "win32", rename: fake.rename, sleep: () => {} })).toThrow("ENOENT");
		expect(fake.calls.length).toBe(1);
	});

	test("elsewhere, EPERM is not retried", () => {
		const fake = failing(1, "EPERM");
		expect(() => renameWithRetry("a.tmp", "a", { platform: "linux", rename: fake.rename, sleep: () => {} })).toThrow("EPERM");
		expect(fake.calls.length).toBe(1);
	});
});
