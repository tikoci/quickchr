import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { imageTarget } from "./image-target.ts";
import { bootTestTimeout, TEST_ACCEL } from "./timeouts.ts";

/**
 * Integration test — `start --frozen` + `quickchr continue` (#214).
 *
 * POSIX-only by scope, not by failure: `--frozen` emits a unix-socket gdbstub
 * and the Windows TCP fallback is parked as a follow-up in the issue. Revisit
 * this gate with a Windows repro when that lands.
 */

const SKIP = !process.env.QUICKCHR_INTEGRATION || process.platform === "win32";
const arch = process.arch === "arm64" ? "arm64" : "x86";

async function cleanupMachine(name: string): Promise<void> {
	const { QuickCHR } = await import("../../src/lib/quickchr.ts");
	const existing = QuickCHR.get(name);
	if (!existing) return;
	try { await existing.stop(); } catch { /* ignore */ }
	try { await existing.remove(); } catch { /* ignore */ }
}

describe.skipIf(SKIP)("frozen start + continue", () => {
	beforeAll(async () => {
		await cleanupMachine("frozen-resume");
		await cleanupMachine("frozen-no-wait");
		await cleanupMachine("frozen-stop");
		await cleanupMachine("frozen-remove");
	});

	test("frozen start holds at reset; continue resumes to REST-ready", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		const name = "frozen-resume";
		try {
			const frozen = await QuickCHR.start({ ...imageTarget(), arch, name, frozen: true });
			expect(frozen.state.status).toBe("running");
			expect(frozen.state.frozen).toBe(true);
			const { detectAccel } = await import("../../src/lib/platform.ts");
			expect(frozen.state.lastAccel).toBe(await detectAccel(arch));
			expect(await frozen.monitor("info status")).toContain("prelaunch");
			expect(existsSync(join(frozen.state.machineDir, "gdb.sock"))).toBe(true);

			// gdb-continued shape: resume behind quickchr's back (marker stays
			// set), then continue() must notice `running` and just clear it.
			await frozen.monitor("cont");
			expect(frozen.state.frozen).toBe(true);
			await frozen.continue();
			expect(frozen.state.frozen).toBeFalsy();
			const resource = await frozen.rest("/system/resource") as Record<string, unknown>;
			expect(String(resource["board-name"])).toContain("CHR");

			// Idempotent: already running, just clears (already clear) and resolves.
			await frozen.continue();
			expect(frozen.state.status).toBe("running");
		} finally {
			await cleanupMachine(name);
		}
	}, bootTestTimeout({ boots: 1 }));

	test("continue --no-wait returns immediately; the guest boots on its own", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		const name = "frozen-no-wait";
		try {
			const frozen = await QuickCHR.start({ ...imageTarget(), arch, name, frozen: true });
			expect(frozen.state.frozen).toBe(true);
			const resumedAt = Date.now();
			await frozen.continue({ wait: false });
			expect(Date.now() - resumedAt).toBeLessThan(30_000);
			expect(frozen.state.frozen).toBeFalsy();
			expect(frozen.state.status).toBe("running");
			// Readiness is the caller's now — the boot wait still passes on the
			// same budget the library would use (TEST_ACCEL is this arch's).
			const { defaultBootTimeout } = await import("../../src/lib/quickchr.ts");
			expect(await frozen.waitForBoot(defaultBootTimeout(arch, undefined, TEST_ACCEL))).toBe(true);
		} finally {
			await cleanupMachine(name);
		}
	}, bootTestTimeout({ boots: 1 }));
});

describe.skipIf(SKIP)("frozen lifecycle", () => {
	test("stop then remove work on a frozen machine", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		const name = "frozen-stop";
		try {
			const frozen = await QuickCHR.start({ ...imageTarget(), arch, name, frozen: true });
			expect(frozen.state.frozen).toBe(true);
			await frozen.stop();
			expect(frozen.state.status).toBe("stopped");
			expect(frozen.state.frozen).toBeFalsy();
			await frozen.remove();
			expect(QuickCHR.get(name)).toBeNull();
		} finally {
			await cleanupMachine(name);
		}
	}, bootTestTimeout());

	test("direct remove works on a frozen machine", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		const name = "frozen-remove";
		try {
			const frozen = await QuickCHR.start({ ...imageTarget(), arch, name, frozen: true });
			expect(frozen.state.frozen).toBe(true);
			await frozen.remove();
			expect(QuickCHR.get(name)).toBeNull();
		} finally {
			await cleanupMachine(name);
		}
	}, bootTestTimeout());
});
