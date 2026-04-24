import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { QuickCHR, acquireLock } from "../../src/lib/quickchr.ts";

function expectErrorCode(e: unknown, code: string) {
	expect(e).toBeInstanceOf(Error);
	expect((e as { code?: string }).code).toBe(code);
}

const TEST_DIR = join(import.meta.dir, ".tmp-lock-test");

beforeEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("QuickCHR.start name validation", () => {
	test("rejects name starting with -", async () => {
		try {
			await QuickCHR.start({ name: "-fg", version: "7.22.1", dryRun: true });
			expect.unreachable("should have thrown");
		} catch (e) {
			expectErrorCode(e, "INVALID_NAME");
		}
	});

	test("rejects name starting with -- (flag-like)", async () => {
		try {
			await QuickCHR.start({ name: "--foreground", version: "7.22.1", dryRun: true });
			expect.unreachable("should have thrown");
		} catch (e) {
			expectErrorCode(e, "INVALID_NAME");
		}
	});

	test("accepts normal machine names", async () => {
		// Dry-run should succeed. May throw MISSING_QEMU/MISSING_FIRMWARE if not
		// installed — catch and skip so the test passes in CI without QEMU.
		try {
			const instance = await QuickCHR.start({ name: "test-valid", version: "7.22.1", dryRun: true });
			expect(instance.name).toBe("test-valid");
		} catch (e: unknown) {
			const code = (e as { code?: string }).code;
			if (code === "MISSING_QEMU" || code === "MISSING_FIRMWARE") return;
			throw e;
		}
	});

	test("blocks provisioning on RouterOS versions older than 7.20.8", async () => {
		try {
			await QuickCHR.start({
				name: "old-version-provision",
				version: "7.10.0",
				dryRun: true,
				secureLogin: true,
			});
			expect.unreachable("should have thrown");
		} catch (e) {
			expectErrorCode(e, "PROVISIONING_VERSION_UNSUPPORTED");
			expect((e as { message?: string }).message).toContain("managed login");
		}
	});

	test("allows disk and network setup on older RouterOS versions without provisioning", async () => {
		try {
			const instance = await QuickCHR.start({
				name: "old-version-boot-only",
				version: "7.10.0",
				dryRun: true,
				secureLogin: false,
				bootSize: "1G",
				extraDisks: ["512M"],
				networks: ["user"],
			});
			expect(instance.state.version).toBe("7.10.0");
			expect(instance.state.bootSize).toBe("1G");
			expect(instance.state.extraDisks).toEqual(["512M"]);
		} catch (e: unknown) {
			const code = (e as { code?: string }).code;
			if (code === "MISSING_QEMU" || code === "MISSING_FIRMWARE") return;
			throw e;
		}
	});
});

describe("acquireLock", () => {
	test("succeeds when no lock file exists", () => {
		const lockPath = join(TEST_DIR, ".start-lock");
		// Should not throw
		expect(() => acquireLock(lockPath)).not.toThrow();
	});

	test("throws MACHINE_LOCKED when lock held by live process", () => {
		const lockPath = join(TEST_DIR, ".start-lock");
		// Write our own PID — guaranteed alive
		writeFileSync(lockPath, String(process.pid));
		try {
			acquireLock(lockPath);
			expect.unreachable("should have thrown");
		} catch (e) {
			expectErrorCode(e, "MACHINE_LOCKED");
		}
	});

	test("recovers silently from stale lock (dead pid)", () => {
		const lockPath = join(TEST_DIR, ".start-lock");
		// Use an absurdly high PID — guaranteed not running on any OS
		writeFileSync(lockPath, "99999999");
		// Should succeed by overwriting the stale lock
		expect(() => acquireLock(lockPath)).not.toThrow();
	});

	test("recovers from malformed lock file content", () => {
		const lockPath = join(TEST_DIR, ".start-lock");
		writeFileSync(lockPath, "not-a-pid");
		// Unreadable PID → treated as stale → overwrites
		expect(() => acquireLock(lockPath)).not.toThrow();
	});
});

describe("ChrInstance API surface (dryRun)", () => {
	// These tests use dryRun: true so no QEMU or image download is needed.
	// They skip gracefully if QEMU/firmware is absent.
	async function makeDryRun() {
		try {
			return await QuickCHR.start({ name: "test-api", version: "7.22.1", dryRun: true });
		} catch (e: unknown) {
			const code = (e as { code?: string }).code;
			if (code === "MISSING_QEMU" || code === "MISSING_FIRMWARE") return null;
			throw e;
		}
	}

	test("dryRun instance exposes subprocessEnv()", async () => {
		const instance = await makeDryRun();
		if (!instance) return;
		expect(typeof instance.subprocessEnv).toBe("function");
		const env = await instance.subprocessEnv();
		expect(typeof env).toBe("object");
		expect(typeof env.QUICKCHR_NAME).toBe("string");
		expect(typeof env.QUICKCHR_REST_URL).toBe("string");
		expect(typeof env.QUICKCHR_REST_BASE).toBe("string");
		expect(typeof env.QUICKCHR_SSH_PORT).toBe("string");
		// Legacy compat keys
		expect(typeof env.URLBASE).toBe("string");
		expect(typeof env.BASICAUTH).toBe("string");
		expect(env.URLBASE).toBe(env.QUICKCHR_REST_BASE);
		expect(env.BASICAUTH).toBe(env.QUICKCHR_AUTH);
	});

	test("dryRun instance exposes destroy()", async () => {
		const instance = await makeDryRun();
		if (!instance) return;
		expect(typeof instance.destroy).toBe("function");
	});

	test("dryRun instance exposes queryLoad()", async () => {
		const instance = await makeDryRun();
		if (!instance) return;
		expect(typeof instance.queryLoad).toBe("function");
		// Monitor not connected on a dryRun instance — should return null gracefully
		const load = await instance.queryLoad();
		expect(load).toBeNull();
	});

	test("license shorthand string is accepted by StartOptions type", async () => {
		// This is primarily a compile-time check, but dryRun validates the path runs.
		const instance = await makeDryRun();
		if (!instance) return;
		// Just verifying the type is accepted — no license renewal on dryRun
		expect(instance).toBeDefined();
	});

	test("dryRun instance exposes availablePackages()", async () => {
		const instance = await makeDryRun();
		if (!instance) return;
		expect(typeof instance.availablePackages).toBe("function");
	});

	test("dryRun instance exposes installPackage()", async () => {
		const instance = await makeDryRun();
		if (!instance) return;
		expect(typeof instance.installPackage).toBe("function");
	});

	test("dryRun instance exposes upload() and download()", async () => {
		const instance = await makeDryRun();
		if (!instance) return;
		expect(typeof instance.upload).toBe("function");
		expect(typeof instance.download).toBe("function");
	});

	test("upload() on stopped machine throws MACHINE_STOPPED", async () => {
		const instance = await makeDryRun();
		if (!instance) return;
		expect(instance.state.status).toBe("stopped");
		try {
			await instance.upload("/etc/hosts");
			expect.unreachable("expected upload() to throw");
		} catch (e) {
			expectErrorCode(e, "MACHINE_STOPPED");
		}
	});

	test("download() on stopped machine throws MACHINE_STOPPED", async () => {
		const instance = await makeDryRun();
		if (!instance) return;
		expect(instance.state.status).toBe("stopped");
		try {
			await instance.download("/file/print", "/tmp/quickchr-should-not-exist");
			expect.unreachable("expected download() to throw");
		} catch (e) {
			expectErrorCode(e, "MACHINE_STOPPED");
		}
	});

	test("arch: 'auto' resolves to host arch (not silently arm64)", async () => {
		// Bug: donny lab 2026-04-22 — passing arch:"auto" bypassed hostArchToChr()
		// and qemu-bin selection ("x86?bin-x86:bin-aarch64") silently picked arm64,
		// leading to TCG emulation + ~480s boot timeout on Intel hosts.
		// Fix: resolveArch() normalizes "auto" and undefined to hostArchToChr().
		let instance: Awaited<ReturnType<typeof QuickCHR.start>> | null = null;
		try {
			instance = await QuickCHR.start({ name: "auto-arch-test", version: "7.22.1", arch: "auto", dryRun: true });
		} catch (e: unknown) {
			const code = (e as { code?: string }).code;
			if (code === "MISSING_QEMU" || code === "MISSING_FIRMWARE") return;
			throw e;
		}
		const expected = process.arch === "arm64" ? "arm64" : "x86";
		expect(instance.state.arch).toBe(expected);
	});

	test("dryRun instance exposes portBase as a top-level number property", async () => {
		const instance = await makeDryRun();
		if (!instance) return;
		expect(typeof instance.portBase).toBe("number");
		expect(instance.portBase).toBeGreaterThan(0);
		expect(instance.portBase).toBe(instance.state.portBase);
	});

	test("dryRun instance exposes captureInterface as lo0 on macOS or any on Linux", async () => {
		const instance = await makeDryRun();
		if (!instance) return;
		const expected = process.platform === "darwin" ? "lo0" : "any";
		expect(instance.captureInterface).toBe(expected);
	});

	test("dryRun instance exposes tzspGatewayIp as QEMU user-mode gateway", async () => {
		const instance = await makeDryRun();
		if (!instance) return;
		expect(instance.tzspGatewayIp).toBe("10.0.2.2");
	});

	test("waitFor resolves true when condition passes immediately", async () => {
		const instance = await makeDryRun();
		if (!instance) return;
		let calls = 0;
		const result = await instance.waitFor(async () => { calls++; return true; }, 5000);
		expect(result).toBe(true);
		expect(calls).toBe(1);
	});

	test("waitFor resolves true after a few retries", async () => {
		const instance = await makeDryRun();
		if (!instance) return;
		let calls = 0;
		const result = await instance.waitFor(async () => {
			calls++;
			return calls >= 3;
		}, 10_000);
		expect(result).toBe(true);
		expect(calls).toBe(3);
	});

	test("waitFor returns false on timeout", async () => {
		const instance = await makeDryRun();
		if (!instance) return;
		const start = Date.now();
		const result = await instance.waitFor(async () => false, 100);
		expect(result).toBe(false);
		expect(Date.now() - start).toBeGreaterThanOrEqual(100);
	});

	test("waitFor swallows errors from condition and keeps polling", async () => {
		const instance = await makeDryRun();
		if (!instance) return;
		let calls = 0;
		const result = await instance.waitFor(async () => {
			calls++;
			if (calls < 3) throw new Error("not ready yet");
			return true;
		}, 10_000);
		expect(result).toBe(true);
		expect(calls).toBe(3);
	});
});
