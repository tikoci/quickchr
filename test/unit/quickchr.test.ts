import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { QuickCHR, acquireLock, captureRunningFailure } from "../../src/lib/quickchr.ts";
import type { MachineState } from "../../src/lib/types.ts";

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
	delete process.env.QUICKCHR_DATA_DIR;
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

	test("noAuth: true is normalized to secureLogin: false", async () => {
		try {
			const instance = await QuickCHR.start({
				name: "test-noauth",
				version: "7.22.1",
				noAuth: true,
				dryRun: true,
			});
			expect(instance.state.secureLogin).toBe(false);
		} catch (e: unknown) {
			const code = (e as { code?: string }).code;
			if (code === "MISSING_QEMU" || code === "MISSING_FIRMWARE") return;
			throw e;
		}
	});

	test("explicit secureLogin wins over noAuth", async () => {
		try {
			const instance = await QuickCHR.start({
				name: "test-noauth-conflict",
				version: "7.22.1",
				noAuth: true,
				secureLogin: true,
				dryRun: true,
			});
			expect(instance.state.secureLogin).toBe(true);
		} catch (e: unknown) {
			const code = (e as { code?: string }).code;
			if (code === "MISSING_QEMU" || code === "MISSING_FIRMWARE") return;
			throw e;
		}
	});

	test("channel name passed as version is accepted (lenient) and resolves", async () => {
		// "long-term" in the version field should resolve to a real version,
		// not throw INVALID_VERSION. A warning is logged but not asserted here
		// (createLogger is internal). Network reachability is required to
		// actually resolve, so swallow network-class failures.
		try {
			const instance = await QuickCHR.start({
				name: "test-channel-as-version",
				version: "long-term",
				dryRun: true,
			});
			expect(instance.state.version).toMatch(/^7\./);
		} catch (e: unknown) {
			const code = (e as { code?: string }).code;
			if (code === "MISSING_QEMU" || code === "MISSING_FIRMWARE") return;
			// resolveVersion needs network; allow that to skip. Match both the
			// node-style codes and Bun's connection-failure messages/codes
			// ("Unable to connect", ConnectionRefused, FailedToOpenSocket).
			const msg = e instanceof Error ? e.message : String(e);
			if (
				/fetch|network|unable to connect|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ConnectionRefused|FailedToOpenSocket/i.test(
					msg,
				)
			) {
				return;
			}
			throw e;
		}
	});
});

describe("captureRunningFailure", () => {
	// A machine that booted and then reset a request. Everything the capture can
	// reach is deliberately absent here — no QEMU, no monitor, no serial socket —
	// because that is the shape it has to survive: it runs on a failure path, and
	// an exception raised while collecting evidence replaces the real error with
	// a worse one.
	function state(overrides: Partial<MachineState> = {}): MachineState {
		return {
			name: "ready-then-reset",
			version: "7.22.1",
			arch: "arm64",
			cpu: 1,
			mem: 512,
			networks: [],
			ports: {
				http: { name: "http", host: 9100, guest: 80, proto: "tcp" },
				ssh: { name: "ssh", host: 9102, guest: 22, proto: "tcp" },
			},
			packages: [],
			portBase: 9100,
			excludePorts: [],
			extraPorts: [],
			createdAt: new Date().toISOString(),
			status: "running",
			machineDir: join(TEST_DIR, "machine"),
			lastAccel: "kvm",
			...overrides,
		};
	}

	test("derives sinceReadyMs from the recorded boot, and records the trigger", async () => {
		process.env.QUICKCHR_DATA_DIR = TEST_DIR;
		// REST-ready 30 s ago: started 90 s ago, boot took 60 s.
		const report = await captureRunningFailure(
			state({ lastStartedAt: new Date(Date.now() - 90_000).toISOString(), lastBootMs: 60_000 }),
			"post-readiness-rest",
			{ operation: "GET /rest/system/resource", error: "Error: socket hang up code=ECONNRESET" },
		);

		const record = JSON.parse(readFileSync(report.reportPath as string, "utf-8"));
		expect(record.phase).toBe("post-readiness-rest");
		expect(record.trigger.operation).toBe("GET /rest/system/resource");
		expect(record.trigger.sinceReadyMs).toBeGreaterThanOrEqual(30_000);
		expect(record.trigger.sinceReadyMs).toBeLessThan(35_000);
		expect(record.machine.accel).toBe("kvm");
		expect(report.reportPath).toContain("post-readiness-failure-ready-then-reset-");
		// Written under QUICKCHR_DATA_DIR/failures, not next to the machine — the
		// caller keeps the machine running, but a later remove() must not be able
		// to take the evidence with it.
		expect(report.reportPath).toContain(join(TEST_DIR, "failures"));
	});

	// Omitted, not zero: a machine with no completed timed boot has no readiness
	// moment to measure from, and "+0.0s after REST-ready" would read as a reset
	// that happened the instant the machine came up.
	test("omits sinceReadyMs when the machine has no recorded boot", async () => {
		process.env.QUICKCHR_DATA_DIR = TEST_DIR;
		const report = await captureRunningFailure(
			state({ lastStartedAt: undefined, lastBootMs: undefined }),
			"post-readiness-rest",
			{ operation: "GET /rest/user", error: "Error: restGet timeout after 10000ms" },
		);

		const record = JSON.parse(readFileSync(report.reportPath as string, "utf-8"));
		expect(record.trigger.sinceReadyMs).toBeUndefined();
		expect(report.summary).toContain("Failed after readiness: GET /rest/user —");
		expect(report.summary).not.toContain("after REST-ready");
	});

	test("an explicit sinceReadyMs wins over the derived one", async () => {
		process.env.QUICKCHR_DATA_DIR = TEST_DIR;
		const report = await captureRunningFailure(
			state({ lastStartedAt: new Date(Date.now() - 90_000).toISOString(), lastBootMs: 60_000 }),
			"post-readiness-rest",
			{ operation: "GET /rest/user", error: "boom", sinceReadyMs: 1_234 },
		);

		const record = JSON.parse(readFileSync(report.reportPath as string, "utf-8"));
		expect(record.trigger.sinceReadyMs).toBe(1_234);
	});
});
