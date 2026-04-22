import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Integration test — ChrInstance.upload() / .download() round-trip.
 *
 * Boots a CHR, uploads a small text file, downloads it back, and asserts
 * the contents match byte-for-byte. Gates the SCP push/pull surface that
 * public API consumers depend on.
 *
 * Requires QEMU. Skipped in CI unless QUICKCHR_INTEGRATION=1.
 */

const SKIP = !process.env.QUICKCHR_INTEGRATION;
const MACHINE = "integration-file-transfer";

async function cleanupMachine(name: string): Promise<void> {
	const { QuickCHR } = await import("../../src/lib/quickchr.ts");
	const existing = QuickCHR.get(name);
	if (!existing) return;
	try { await existing.stop(); } catch { /* ignore */ }
	try { await existing.remove(); } catch { /* ignore */ }
}

describe.skipIf(SKIP)("ChrInstance upload/download round-trip", () => {
	let workDir: string;

	beforeAll(async () => {
		await cleanupMachine(MACHINE);
		workDir = mkdtempSync(join(tmpdir(), "quickchr-ft-"));
	});

	afterAll(async () => {
		await cleanupMachine(MACHINE);
		if (workDir) {
			try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test("upload a file, download it back, verify byte-equal", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");

		// Content includes non-ASCII + newlines so we catch encoding regressions.
		const payload = `quickchr round-trip ${Date.now()}\n«₀⇆₁»\nLINE3\n`;
		const localIn = join(workDir, "in.txt");
		const localOut = join(workDir, "out.txt");
		await Bun.write(localIn, payload);

		let instance: Awaited<ReturnType<typeof QuickCHR.start>> | undefined;
		try {
			instance = await QuickCHR.start({
				channel: "stable",
				background: true,
				name: MACHINE,
			});

			// Explicit remote path. RouterOS flash root is writable; `/ft-probe.txt`
			// lands as a first-class file visible via `/file/print`.
			const remote = "/ft-probe.txt";
			await instance.upload(localIn, remote);
			await instance.download(remote, localOut);

			const roundTripped = await Bun.file(localOut).text();
			expect(roundTripped).toBe(payload);

			// Also verify the default-path form (no remotePath arg → /<basename>).
			await instance.upload(localIn);
			const defaultOut = join(workDir, "out-default.txt");
			await instance.download(`/${"in.txt"}`, defaultOut);
			expect(await Bun.file(defaultOut).text()).toBe(payload);
		} finally {
			if (instance) {
				await instance.stop();
			}
		}
	}, 240_000); // 4-minute ceiling — matches start-stop.test.ts boot budget
});

