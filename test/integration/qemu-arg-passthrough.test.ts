import { describe, test, expect, beforeAll, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { imageTarget } from "./image-target.ts";
import { bootTestTimeout, bootTestTimeoutFor } from "./timeouts.ts";
import { detectAccel } from "../../src/lib/platform.ts";
import { isMachineRunning } from "../../src/lib/state.ts";
import { QuickCHRError, type ChrInstance } from "../../src/lib/types.ts";

/**
 * Integration test — `--qemu-arg` passthrough (#213).
 *
 * The audio recipe is inherently x86/pc-machine-only (the `pcspk-audiodev`
 * machine property does not exist on `virt`), so that boot is gated to x86
 * hosts — the same platform-gating the repo uses for Windows-only tests.
 * Cross-arch x86-on-arm64 TCG would spend a ~30 min boot budget re-proving arg
 * plumbing that the native `-name` test below already covers at native speed
 * on every leg.
 */

const SKIP = !process.env.QUICKCHR_INTEGRATION;
const SKIP_NON_X86 = SKIP || process.arch !== "x64";
// Module scope: `detectAccel` is async and the test timeout below is sync.
// Gated like TEST_ACCEL so a unit-only run stays side-effect free.
const X86_ACCEL = process.env.QUICKCHR_INTEGRATION ? await detectAccel("x86") : "tcg";

const TMP = join(import.meta.dir, ".tmp-qemu-arg-passthrough");

async function cleanupMachine(name: string): Promise<void> {
	const { QuickCHR } = await import("../../src/lib/quickchr.ts");
	const existing = QuickCHR.get(name);
	if (!existing) return;
	try { await existing.stop(); } catch { /* ignore */ }
	try { await existing.remove(); } catch { /* ignore */ }
}

afterEach(() => {
	rmSync(TMP, { recursive: true, force: true });
});

describe.skipIf(SKIP_NON_X86)("qemu-arg audio passthrough (x86)", () => {
	const name = "qemu-arg-audio";

	beforeAll(async () => {
		await cleanupMachine(name);
	});

	test("add-recorded audiodev boots REST-ready and writes a WAV header; session args replace stored for one boot", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		mkdirSync(TMP, { recursive: true });
		const wav1 = join(TMP, "cap1.wav");
		const wav2 = join(TMP, "cap2.wav");
		const stored = ["-M", "pc,pcspk-audiodev=cap", "-audiodev", `wav,id=cap,path=${wav1}`];
		const session = ["-M", "pc,pcspk-audiodev=cap", "-audiodev", `wav,id=cap,path=${wav2}`];

		try {
			// Recorded via add: reused on a plain start with no session args.
			await QuickCHR.add({ ...imageTarget(), arch: "x86", name, qemuArgs: stored });
			const first = await QuickCHR.start({ name });
			expect(first.state.status).toBe("running");
			const resource = await first.rest("/system/resource") as Record<string, unknown>;
			expect(String(resource["board-name"])).toContain("CHR");
			assertWavCreated(wav1);
			await quitForWav(first);
			assertWavHeaderOnly(wav1);

			// Session args replace stored for this boot only.
			const second = await QuickCHR.start({ name, qemuArgs: session });
			expect(second.state.status).toBe("running");
			const resource2 = await second.rest("/system/resource") as Record<string, unknown>;
			expect(String(resource2["board-name"])).toContain("CHR");
			assertWavCreated(wav2);
			// Stored intent is untouched by the session override.
			expect(QuickCHR.get(name)?.state.qemuArgs).toEqual(stored);
			await quitForWav(second);
			assertWavHeaderOnly(wav2);
		} finally {
			await cleanupMachine(name);
		}
	}, bootTestTimeoutFor("x86", X86_ACCEL, { boots: 2 }));
});

/** Finalize QEMU's buffered WAV output before checking it. stop() sends SIGTERM,
 *  which terminates QEMU abruptly on Windows and leaves the file empty. */
async function quitForWav(instance: ChrInstance): Promise<void> {
	try {
		await instance.monitor("quit");
	} catch (error) {
		// Windows can reset the monitor connection as QEMU exits. Accept that
		// only if the process actually exits; the WAV assertions still follow.
		if (!(error instanceof QuickCHRError) || error.code !== "PROCESS_FAILED" || !error.message.includes("ECONNRESET")) throw error;
	}
	expect(await instance.waitFor(async () => !isMachineRunning(instance.state), 5000)).toBe(true);
	// QEMU has already exited: persist stopped state without terminating it.
	await instance.stop();
}

/** QEMU creates the wav backend file at spawn but flushes the RIFF header only
 *  on an orderly exit (measured on QEMU 11.1.1: monitor quit writes 44 bytes;
 *  forced termination leaves 0). Existence while running proves the wiring;
 *  the header is asserted after quit. Header-only (no samples) is expected: stock
 *  CHR skips `:beep` under a hypervisor, so the guest never emits audio
 *  without the #214 RAM-patch workflow. */
function assertWavCreated(path: string): void {
	expect(existsSync(path)).toBe(true);
}

function assertWavHeaderOnly(path: string): void {
	expect(statSync(path).size).toBe(44);
	expect(readFileSync(path).subarray(0, 4).toString("ascii")).toBe("RIFF");
}

describe.skipIf(SKIP)("qemu-arg mechanism (native arch)", () => {
	const name = "qemu-arg-mechanism";
	const arch = process.arch === "arm64" ? "arm64" : "x86";

	beforeAll(async () => {
		await cleanupMachine(name);
	});

	test("passthrough reaches QEMU: -name is observable via info name", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		const vmName = `qemu-arg-${process.pid}`;
		let instance: Awaited<ReturnType<typeof QuickCHR.start>> | undefined;
		try {
			instance = await QuickCHR.start({
				...imageTarget(),
				arch,
				name,
				qemuArgs: ["-name", vmName],
			});
			expect(instance.state.status).toBe("running");
			const resource = await instance.rest("/system/resource") as Record<string, unknown>;
			expect(String(resource["board-name"])).toContain("CHR");
			expect(await instance.monitor("info name")).toContain(vmName);
		} finally {
			if (instance) {
				try { await instance.stop(); } catch { /* ignore */ }
			}
			await cleanupMachine(name);
		}
	}, bootTestTimeout({ boots: 1 }));
});
