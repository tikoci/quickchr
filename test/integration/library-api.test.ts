import { describe, test, expect } from "bun:test";
import { join } from "node:path";
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
	// stdout. add() used to drop its logger on the way to the image cache. Run in a
	// child with stdout piped, so every writer counts (console.info and Bun.stdout
	// bypass an in-process spy). A cache miss takes the same logger (ensureCachedImage
	// hands it to the download), and the warm-up stays inside the child so a cold
	// cache is covered by this test's own timeout, not Bun's 5 s default.
	test("add({ onProgress }) writes nothing to stdout", async () => {
		const { QuickCHR } = await import("../../src/index.ts");
		const target = imageTarget();
		const version = "version" in target ? target.version : await QuickCHR.resolveVersion(target.channel);
		const src = join(import.meta.dir, "../../src");
		const script = `
			import { QuickCHR } from ${JSON.stringify(join(src, "index.ts"))};
			import { ensureCachedImage } from ${JSON.stringify(join(src, "lib/images.ts"))};
			import { createLogger } from ${JSON.stringify(join(src, "lib/log.ts"))};
			const version = ${JSON.stringify(version)};
			await ensureCachedImage(version, "x86", undefined, createLogger(() => {}));
			const name = "onprogress-" + crypto.randomUUID().slice(0, 8);
			const progress = (m) => process.stderr.write("PROGRESS " + m + "\\n");
			await QuickCHR.add({ version, arch: "x86", name, onProgress: progress });
			// Only the machine this child created is removed.
			await QuickCHR.get(name).remove();
		`;
		const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe", env: process.env });
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect({ code, stdout }).toEqual({ code: 0, stdout: "" });
		expect(stderr).toContain("PROGRESS   Using cached image");
	}, 600_000);
});
