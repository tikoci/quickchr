import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageTarget } from "./image-target.ts";
import { bootTestTimeout } from "./timeouts.ts";

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
const MACHINE_SECURE = "integration-file-transfer-secure";

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
		await cleanupMachine(MACHINE_SECURE);
		workDir = mkdtempSync(join(tmpdir(), "quickchr-ft-"));
	});

	afterAll(async () => {
		await cleanupMachine(MACHINE);
		await cleanupMachine(MACHINE_SECURE);
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
				...imageTarget(),
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
	}, bootTestTimeout());

	// The managed `quickchr` user has an SSH key, and RouterOS refuses password login
	// for a user with a key, so this only passes over the key (#229). The factory-admin
	// test above never reaches that path.
	test("secure-login machine transfers over its managed key", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");

		const payload = `quickchr managed-key round-trip ${Date.now()}\n`;
		const localIn = join(workDir, "secure-in.txt");
		const localOut = join(workDir, "secure-out.txt");
		await Bun.write(localIn, payload);

		let instance: Awaited<ReturnType<typeof QuickCHR.start>> | undefined;
		try {
			instance = await QuickCHR.start({
				...imageTarget(),
				background: true,
				name: MACHINE_SECURE,
				secureLogin: true,
			});

			// Prove the shape first, so a pass cannot have ridden a password login.
			expect(instance.state.user?.name).toBe("quickchr");
			expect(instance.state.managedSshKey?.batchVerified).toBe(true);

			await instance.upload(localIn, "/ft-secure.txt");
			await instance.download("/ft-secure.txt", localOut);
			expect(await Bun.file(localOut).text()).toBe(payload);
		} finally {
			if (instance) {
				await instance.stop();
			}
		}
	}, bootTestTimeout());
});
