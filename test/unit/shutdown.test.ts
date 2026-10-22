import { describe, expect, test } from "bun:test";
import { shutdownGuest, validateShutdownTimeout } from "../../src/lib/shutdown.ts";

describe("bounded guest shutdown (#143)", () => {
	test("rejects invalid or overflowing HTTP timer budgets", () => {
		for (const value of [0, -1, 0.5, NaN, Infinity, 2_147_483_648]) {
			expect(() => validateShutdownTimeout(value)).toThrow("positive integer");
		}
		expect(validateShutdownTimeout(10_000)).toBe(10_000);
	});

	test("HTTP 400 interrupted with later guest exit is not forced", async () => {
		let running = true;
		let calls = 0;
		let forced = false;
		const timer = setTimeout(() => { running = false; }, 20);
		try {
			const result = await shutdownGuest(200, async () => {
				calls++;
				throw new Error("HTTP 400 interrupted");
			}, () => running, async () => { forced = true; });
			expect(result).toEqual({ outcome: "guest-exited", requestError: "HTTP 400 interrupted" });
			expect(calls).toBe(1);
			expect(forced).toBe(false);
		} finally { clearTimeout(timer); }
	});

	test("a pending request is settled even if the guest exits first", async () => {
		let running = true;
		let settled = false;
		const result = await shutdownGuest(200, async (budget) => {
			expect(budget).toBeLessThanOrEqual(200);
			running = false;
			await Bun.sleep(25);
			settled = true;
		}, () => running, async () => { throw new Error("must not force"); });
		expect(result).toEqual({ outcome: "guest-exited" });
		expect(settled).toBe(true);
	});

	test("request failure waits out the grace budget before hard stop", async () => {
		let running = true;
		const start = performance.now();
		const result = await shutdownGuest(40, async () => { throw new Error("HTTP 401"); }, () => running, async () => {
			expect(performance.now() - start).toBeGreaterThanOrEqual(39);
			running = false;
		});
		expect(result).toEqual({ outcome: "forced", requestError: "HTTP 401" });
	});

	test("HTTP success without process exit still forces a power cut", async () => {
		let running = true;
		const result = await shutdownGuest(10, async () => "OK", () => running, async () => { running = false; });
		expect(result.outcome).toBe("forced");
	});

	test("a failed hard stop is a typed error, not a stopped result", async () => {
		await expect(shutdownGuest(1, async () => {}, () => true, async () => { throw new Error("denied"); }))
			.rejects.toMatchObject({ code: "STATE_ERROR" });
	});

	test("a kill that returns while the process survives is not success", async () => {
		await expect(shutdownGuest(1, async () => {}, () => true, async () => {}))
			.rejects.toMatchObject({ code: "STATE_ERROR" });
	});
});
