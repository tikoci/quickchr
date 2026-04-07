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
