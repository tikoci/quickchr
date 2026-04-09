import { describe, test, expect, beforeAll, afterAll } from "bun:test";

/**
 * Integration test — exec() against a real CHR instance.
 *
 * Requires QEMU installed. Skipped unless QUICKCHR_INTEGRATION=1.
 * All tests share a single CHR to avoid 3× boot overhead.
 */

const SKIP = !process.env.QUICKCHR_INTEGRATION;

async function cleanupMachine(name: string): Promise<void> {
	const { QuickCHR } = await import("../../src/lib/quickchr.ts");
	const existing = QuickCHR.get(name);
	if (!existing) return;
	try { await existing.stop(); } catch { /* ignore */ }
	try { await existing.remove(); } catch { /* ignore */ }
}

async function waitForExecReady(
	instance: Awaited<ReturnType<typeof import("../../src/lib/quickchr.ts").QuickCHR.start>>,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const result = await instance.exec(":put ready", { timeout: 10_000 });
			if (result.via === "rest" && result.output.trim() === "ready") return;
		} catch {
			// RouterOS can accept HTTP before /rest/execute is fully ready.
		}
		await Bun.sleep(1000);
	}

	throw new Error(`Timed out waiting for /rest/execute readiness after ${timeoutMs}ms`);
}

describe.skipIf(SKIP)("exec — REST /execute", () => {
	const MACHINE = "integration-exec-1";
	let instance: Awaited<ReturnType<typeof import("../../src/lib/quickchr.ts").QuickCHR.start>> | undefined;

	beforeAll(async () => {
		await cleanupMachine(MACHINE);
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		instance = await QuickCHR.start({
			channel: "stable",
			background: true,
			name: MACHINE,
		});

		expect(instance).toBeDefined();
		if (!instance) {
			throw new Error("Failed to start integration CHR instance");
		}
		// _launchNew() returns immediately for non-provisioning starts; wait explicitly.
		const booted = await instance.waitForBoot(120_000);
		expect(booted).toBe(true);
		await waitForExecReady(instance, 60_000);
	}, 240_000);

	afterAll(async () => {
		if (instance) {
			try { await instance.stop(); } catch { /* ignore */ }
			try { await instance.remove(); } catch { /* ignore */ }
		}
	});

	test("exec /system/identity/print returns identity text", async () => {
		expect(instance).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: guarded by expect above
		const result = await instance!.exec("/system/identity/print");
		expect(result.via).toBe("rest");
		expect(typeof result.output).toBe("string");
		// With as-string, we get CLI-formatted text like "  name: MikroTik"
		expect(result.output).toContain("name:");
	}, 30_000);

	test("exec with :serialize returns parseable JSON", async () => {
		expect(instance).toBeDefined();
		// Caller wraps in :serialize — exec passes command through as-is
		// biome-ignore lint/style/noNonNullAssertion: guarded by expect above
		const result = await instance!.exec(
			":local r [/system/resource/print as-value]; :put [:serialize to=json $r]",
		);
		expect(result.via).toBe("rest");
		const parsed = JSON.parse(result.output);
		expect(parsed).toBeDefined();
		if (Array.isArray(parsed) && parsed.length > 0) {
			expect(parsed[0]["board-name"]).toMatch(/^CHR/);
		} else {
			expect(JSON.stringify(parsed)).toContain("board-name");
		}
	}, 30_000);

	test("exec log command completes without error", async () => {
		expect(instance).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: guarded by expect above
		const result = await instance!.exec('/log/info message="exec-integration-test"');
		expect(result.via).toBe("rest");
		// Log commands produce no output — just verify no exception
	}, 30_000);

	test("exec :put returns the value directly", async () => {
		expect(instance).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: guarded by expect above
		const result = await instance!.exec(":put hello");
		expect(result.via).toBe("rest");
		expect(result.output).toBe("hello");
	}, 30_000);
});
