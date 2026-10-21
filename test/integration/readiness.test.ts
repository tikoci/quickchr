import { describe, test, expect, beforeAll } from "bun:test";
import { imageTarget } from "./image-target.ts";
import { bootTestTimeout, bootTestTimeoutFor, TEST_ACCEL } from "./timeouts.ts";
import { newBootProbeStats } from "../../src/lib/diagnostics.ts";
import { QuickCHRError } from "../../src/lib/types.ts";

/**
 * The two non-default readiness paths of `start()`:
 *
 * - `wait: false` (#159) resolves once QEMU is running, before RouterOS is ready, and
 *   the guest gets there on its own.
 * - RouterOS 6 (#182) is ready when its native API answers a `/login` — it has no
 *   REST, and the REST probe ran to timeout and then removed the machine.
 *
 * Requires QEMU. Skipped unless QUICKCHR_INTEGRATION=1.
 */

const SKIP = !process.env.QUICKCHR_INTEGRATION;

/** The 6.x release the v6 test boots. Pinned: RouterOS 6 has no channel quickchr
 *  resolves (every channel is 7.x), and 6.49.x is the last v6 line. */
const V6_VERSION = "6.49.23";

/** RouterOS 6 CHR is x86-only, so on an arm64 host it is a cross-arch TCG boot. */
const V6_ACCEL = process.arch === "arm64" ? "tcg" : TEST_ACCEL;

async function cleanupMachine(name: string): Promise<void> {
	const { QuickCHR } = await import("../../src/lib/quickchr.ts");
	const existing = QuickCHR.get(name);
	if (!existing) return;
	try { await existing.stop(); } catch { /* ignore */ }
	try { await existing.remove(); } catch { /* ignore */ }
}

describe.skipIf(SKIP)("start readiness paths", () => {
	beforeAll(async () => {
		await cleanupMachine("integration-no-wait");
		await cleanupMachine("integration-v6");
	});

	test("wait: false resolves before REST is ready, and the guest gets there on its own", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		const { restGet } = await import("../../src/lib/rest.ts");
		try {
			const t0 = Date.now();
			const instance = await QuickCHR.start({ ...imageTarget(), name: "integration-no-wait", wait: false });
			const returnedMs = Date.now() - t0;

			expect(instance.state.status).toBe("running");
			expect(instance.state.pid).toBeGreaterThan(0);
			// Nothing waited for the guest, so no boot was recorded.
			expect(instance.state.lastBootMs).toBeUndefined();
			console.log(`[no-wait] start() resolved in ${returnedMs} ms`);

			// REST is not up yet: the first probe, made immediately, does not get the
			// resource object. A plain restGet — this call is expected to fail.
			const early = await restGet(`${instance.restUrl}/rest/system/resource`, `Basic ${btoa("admin:")}`, 3000)
				.then((r) => r.status)
				.catch((e: unknown) => (e as Error).message);
			expect(early).not.toBe(200);

			const stats = newBootProbeStats();
			expect(await instance.waitForBoot(undefined, stats)).toBe(true);
			console.log(`[no-wait] REST ready ${Date.now() - t0} ms after start(): ${JSON.stringify(stats.counts)}`);
		} finally {
			await cleanupMachine("integration-no-wait");
		}
	}, bootTestTimeout());

	test(`RouterOS ${V6_VERSION} boots to ready over the native API, and REST is refused`, async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		try {
			const instance = await QuickCHR.start({ version: V6_VERSION, arch: "x86", name: "integration-v6" });
			expect(instance.state.status).toBe("running");
			expect(instance.state.lastBootMs).toBeGreaterThan(0);
			console.log(`[v6] ready in ${instance.state.lastBootMs} ms`);

			const stats = newBootProbeStats();
			expect(await instance.waitForBoot(30_000, stats)).toBe(true);
			expect(stats.kind).toBe("api");
			expect(stats.counts.ready).toBe(2);

			const err = await instance.exec("/system/resource/print").catch((e: unknown) => e);
			expect(err).toBeInstanceOf(QuickCHRError);
			expect((err as QuickCHRError).code).toBe("REST_UNAVAILABLE");

			const descriptor = await instance.descriptor();
			expect(descriptor.services["rest-api"]?.available).toBe(false);
			expect(descriptor.services["native-api"]?.available).toBe(true);
		} finally {
			await cleanupMachine("integration-v6");
		}
	}, bootTestTimeoutFor("x86", V6_ACCEL));
});
