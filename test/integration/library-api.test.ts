import { describe, test, expect, spyOn } from "bun:test";
import { imageTarget } from "./image-target.ts";

/**
 * Integration test — library API usage patterns (mimics bun test consumer).
 *
 * Requires QEMU installed. Set QUICKCHR_INTEGRATION=1 to run.
 */

const SKIP = !process.env.QUICKCHR_INTEGRATION;

describe.skipIf(SKIP)("library API", () => {
	test("import QuickCHR from @tikoci/quickchr", async () => {
		const { QuickCHR, QuickCHRError } = await import("../../src/index.ts");

		expect(QuickCHR).toBeDefined();
		expect(QuickCHR.start).toBeFunction();
		expect(QuickCHR.list).toBeFunction();
		expect(QuickCHR.get).toBeFunction();
		expect(QuickCHR.doctor).toBeFunction();
		expect(QuickCHRError).toBeDefined();
	});

	test("doctor returns DoctorResult", async () => {
		const { QuickCHR } = await import("../../src/index.ts");
		const result = await QuickCHR.doctor();

		expect(result.checks).toBeArray();
		expect(result.checks.length).toBeGreaterThan(0);
		expect(typeof result.ok).toBe("boolean");

		// Bun check should always pass
		const bunCheck = result.checks.find((c) => c.label === "Bun runtime");
		expect(bunCheck).toBeDefined();
		expect(bunCheck?.status).toBe("ok");

		const storageCheck = result.checks.find((c) => c.label === "Storage (.local)" || c.label === "Storage");
		expect(storageCheck).toBeDefined();
	}, 30_000);

	test("resolveVersion returns valid version", async () => {
		const { QuickCHR } = await import("../../src/index.ts");
		const version = await QuickCHR.resolveVersion("stable");

		expect(version).toMatch(/^\d+\.\d+/);
	});

	test("list returns array", async () => {
		const { QuickCHR } = await import("../../src/index.ts");
		const machines = QuickCHR.list();
		expect(machines).toBeArray();
	});

	test("get returns null for non-existent", async () => {
		const { QuickCHR } = await import("../../src/index.ts");
		const instance = QuickCHR.get("does-not-exist-12345");
		expect(instance).toBeNull();
	});

	test("dry-run start returns instance without spawning", async () => {
		const { QuickCHR } = await import("../../src/index.ts");
		const instance = await QuickCHR.start({
			version: "7.22.1",
			arch: "arm64",
			dryRun: true,
			name: "dry-run-test",
		});

		expect(instance.name).toBe("dry-run-test");
		expect(instance.state.version).toBe("7.22.1");
		expect(instance.state.arch).toBe("arm64");
		expect(instance.state.status).toBe("stopped");
		expect(instance.ports.http).toBeGreaterThan(0);
		expect(instance.restUrl).toContain("http://127.0.0.1:");
	});

	// #290: a caller that passes onProgress gets its lines there, and nothing on
	// stdout. add() used to drop its logger on the way to the image cache. A cache
	// miss takes the same logger (ensureCachedImage hands it to the download), so the
	// test warms the cache first to keep it fast and deterministic.
	test("add({ onProgress }) writes nothing to stdout", async () => {
		const { QuickCHR } = await import("../../src/index.ts");
		const { ensureCachedImage } = await import("../../src/lib/images.ts");
		const { createLogger } = await import("../../src/lib/log.ts");
		const target = imageTarget();
		const version = "version" in target ? target.version : await QuickCHR.resolveVersion(target.channel);
		await ensureCachedImage(version, "x86", undefined, createLogger(() => {}));

		const name = `onprogress-${process.pid}`;
		const lines: string[] = [];
		const stdout: string[] = [];
		const logSpy = spyOn(console, "log").mockImplementation((...a: unknown[]) => { stdout.push(a.join(" ")); });
		const writeSpy = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
			stdout.push(String(chunk));
			return true;
		});
		try {
			await QuickCHR.add({ version, arch: "x86", name, onProgress: (m) => lines.push(m) });
		} finally {
			logSpy.mockRestore();
			writeSpy.mockRestore();
			try { await QuickCHR.get(name)?.remove(); } catch { /* best effort */ }
		}
		expect(stdout).toEqual([]);
		expect(lines.some((l) => l.includes("Using cached image"))).toBe(true);
	});
});
