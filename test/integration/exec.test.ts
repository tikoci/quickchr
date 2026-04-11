import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";

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

describe.skipIf(SKIP)("exec — shared CHR instance", () => {
	const MACHINE = "integration-exec-1";
	let instance: Awaited<ReturnType<typeof import("../../src/lib/quickchr.ts").QuickCHR.start>> | undefined;
	let machineArch: string | undefined;
	let isQgaAvailable = false;

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

		// Capture arch for transport-specific gating.
		machineArch = instance.state.arch;

		// Detect QGA availability once (x86 only; RouterOS CHR may not implement QGA).
		if (machineArch === "x86") {
			const { qgaProbe } = await import("../../src/lib/qga.ts");
			const qgaSockPath = join(instance.state.machineDir, "qga.sock");
			isQgaAvailable = await qgaProbe(qgaSockPath, 10_000);
			if (!isQgaAvailable) {
				console.log("[exec.test] QGA daemon did not respond on this x86 instance — QGA tests will be skipped");
			}
		}
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

	// --- QGA transport (x86 only) ---

	test("QGA: probe returns true on running x86 CHR", async () => {
		if (machineArch !== "x86") return; // skip on arm64
		if (!isQgaAvailable) { console.log("[exec.test] QGA not available, skipping probe test"); return; }
		expect(instance).toBeDefined();
		const { qgaProbe } = await import("../../src/lib/qga.ts");
		// biome-ignore lint/style/noNonNullAssertion: guarded by expect above
		const socketPath = join(instance!.state.machineDir, "qga.sock");
		const ready = await qgaProbe(socketPath, 10_000);
		expect(ready).toBe(true);
	}, 30_000);

	test("QGA: exec :put hello returns hello", async () => {
		if (!isQgaAvailable) return; // skip if QGA daemon not available on this host
		expect(instance).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: guarded by expect above
		const result = await instance!.exec(":put hello", { via: "qga", timeout: 20_000 });
		expect(result.via).toBe("qga");
		expect(result.output.trim()).toBe("hello");
	}, 30_000);

	test("QGA: exec identity query", async () => {
		if (!isQgaAvailable) return; // skip if QGA daemon not available on this host
		expect(instance).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: guarded by expect above
		const result = await instance!.exec(":put [/system/identity/get name]", { via: "qga", timeout: 20_000 });
		expect(result.via).toBe("qga");
		expect(result.output.trim().length).toBeGreaterThan(0);
	}, 30_000);

	test("QGA: guest-info lists supported commands", async () => {
		if (!isQgaAvailable) return; // skip if QGA daemon not available on this host
		expect(instance).toBeDefined();
		const { qgaInfo } = await import("../../src/lib/qga.ts");
		// biome-ignore lint/style/noNonNullAssertion: guarded by expect above
		const socketPath = join(instance!.state.machineDir, "qga.sock");
		const commands = await qgaInfo(socketPath, 10_000);
		expect(commands.length).toBeGreaterThan(0);
		const names = commands.map((c) => c.name);
		expect(names).toContain("guest-exec");
		expect(names).toContain("guest-ping");
	}, 30_000);

	test("QGA: qgaPing returns true", async () => {
		if (!isQgaAvailable) return;
		expect(instance).toBeDefined();
		const { qgaPing } = await import("../../src/lib/qga.ts");
		// biome-ignore lint/style/noNonNullAssertion: guarded by expect above
		const socketPath = join(instance!.state.machineDir, "qga.sock");
		await qgaPing(socketPath, 10_000);
		// qgaPing returns void; if we reach here, the ping succeeded
	}, 30_000);

	test("QGA: qgaGetOsInfo returns RouterOS identity", async () => {
		if (!isQgaAvailable) return;
		expect(instance).toBeDefined();
		const { qgaGetOsInfo } = await import("../../src/lib/qga.ts");
		// biome-ignore lint/style/noNonNullAssertion: guarded by expect above
		const socketPath = join(instance!.state.machineDir, "qga.sock");
		const info = await qgaGetOsInfo(socketPath, 10_000);
		expect(info.id).toBe("routeros");
		expect(info.machine).toBe("x86_64");
		expect(typeof info.prettyName).toBe("string");
	}, 30_000);

	test("QGA: qgaGetNetworkInterfaces includes ether1", async () => {
		if (!isQgaAvailable) return;
		expect(instance).toBeDefined();
		const { qgaGetNetworkInterfaces } = await import("../../src/lib/qga.ts");
		// biome-ignore lint/style/noNonNullAssertion: guarded by expect above
		const socketPath = join(instance!.state.machineDir, "qga.sock");
		const ifaces = await qgaGetNetworkInterfaces(socketPath, 10_000);
		expect(Array.isArray(ifaces)).toBe(true);
		const names = ifaces.map((i) => i.name);
		expect(names.some((n) => n.startsWith("ether"))).toBe(true);
	}, 30_000);

	test("QGA: qgaGetHostName returns non-empty string", async () => {
		if (!isQgaAvailable) return;
		expect(instance).toBeDefined();
		const { qgaGetHostName } = await import("../../src/lib/qga.ts");
		// biome-ignore lint/style/noNonNullAssertion: guarded by expect above
		const socketPath = join(instance!.state.machineDir, "qga.sock");
		const hostname = await qgaGetHostName(socketPath, 10_000);
		expect(typeof hostname).toBe("string");
		expect(hostname.length).toBeGreaterThan(0);
	}, 30_000);

	test("QGA: throws on arm64", async () => {
		if (machineArch !== "arm64") return;
		expect(instance).toBeDefined();
		await expect(
			// biome-ignore lint/style/noNonNullAssertion: guarded by expect above
			instance!.exec(":put test", { via: "qga" }),
		).rejects.toMatchObject({ code: "QGA_UNSUPPORTED" });
	}, 10_000);

	// --- Console transport ---

	test("Console: isConsoleReady returns ready or login", async () => {
		expect(instance).toBeDefined();
		const { isConsoleReady } = await import("../../src/lib/console.ts");
		// biome-ignore lint/style/noNonNullAssertion: guarded by expect above
		const status = await isConsoleReady(instance!.state.machineDir, 10_000);
		expect(status === "ready" || status === "login").toBe(true);
	}, 30_000);

	test("Console: exec :put hello returns hello", async () => {
		expect(instance).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: guarded by expect above
		const result = await instance!.exec(":put hello", { via: "console", timeout: 30_000 });
		expect(result.via).toBe("console");
		expect(result.output.trim()).toBe("hello");
	}, 60_000);

	test("Console: exec identity print returns identity text", async () => {
		expect(instance).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: guarded by expect above
		const result = await instance!.exec("/system/identity/print", { via: "console", timeout: 30_000 });
		expect(result.via).toBe("console");
		expect(result.output).toContain("name:");
	}, 60_000);

	test("Console: multi-line output from /interface/print", async () => {
		expect(instance).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: guarded by expect above
		const result = await instance!.exec("/interface/print", { via: "console", timeout: 30_000 });
		expect(result.via).toBe("console");
		expect(result.output).toContain("ether");
	}, 60_000);
});
