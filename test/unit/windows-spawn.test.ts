/**
 * Windows-only unit tests for QEMU process spawning (Job Object escape).
 * Skipped automatically on macOS and Linux.
 *
 * Verifies that on Windows, spawnQemu uses node:child_process.spawn with
 * detached: true + windowsHide: true so QEMU survives the parent process exit.
 *
 * Implementation note: spawnQemu internally does `await import("node:child_process")`
 * — we intercept via monkey-patching the already-loaded module. Because spawnQemu
 * also waits 1.5 s for QEMU to start and then calls process.kill(pid, 0), we make
 * the mock child return our own process.pid so the liveness check passes.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as cp from "node:child_process";
import { spawnQemu } from "../../src/lib/qemu.ts";

const isWindows = process.platform === "win32";

describe.skipIf(!isWindows)("Windows spawnQemu — node:child_process with detached: true", () => {
	const TMP = join(tmpdir(), "quickchr-win-spawn-test");

	beforeEach(() => mkdirSync(TMP, { recursive: true }));
	afterEach(() => rmSync(TMP, { recursive: true, force: true }));

	test("spawnQemu passes detached: true and windowsHide: true on Windows", async () => {
		let capturedOptions: Record<string, unknown> | undefined;

		const originalSpawn = cp.spawn;
		// biome-ignore lint/suspicious/noExplicitAny: test spy
		(cp as any).spawn = (_bin: string, _args: string[], options: Record<string, unknown>) => {
			capturedOptions = options;
			return { pid: process.pid, unref: () => {} };
		};

		try {
			await spawnQemu(["qemu-system-x86_64", "-version"], TMP, true);
		} catch {
			// May throw SPAWN_FAILED — we only care that spawn was called with correct options
		} finally {
			// biome-ignore lint/suspicious/noExplicitAny: restore original
			(cp as any).spawn = originalSpawn;
		}

		expect(capturedOptions).toBeDefined();
		expect(capturedOptions?.detached).toBe(true);
		expect(capturedOptions?.windowsHide).toBe(true);
		expect(capturedOptions?.stdio).toBeDefined();
	});

	test("spawnQemu calls child.unref() so QEMU survives parent exit", async () => {
		let unrefCalled = false;

		const originalSpawn = cp.spawn;
		// biome-ignore lint/suspicious/noExplicitAny: test spy
		(cp as any).spawn = (_bin: string, _args: string[], _options: unknown) => ({
			pid: process.pid,
			unref: () => { unrefCalled = true; },
		});

		try {
			await spawnQemu(["qemu-system-x86_64", "-version"], TMP, true);
		} catch {
			// May throw after spawn — that's fine
		} finally {
			// biome-ignore lint/suspicious/noExplicitAny: restore original
			(cp as any).spawn = originalSpawn;
		}

		expect(unrefCalled).toBe(true);
	});
});
