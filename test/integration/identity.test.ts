/**
 * #265: quickchr sets `/system/identity` to the machine name when it provisions,
 * and only then. `secureLogin: true` is the cheapest provisioning step, so it is
 * the trigger here.
 */
import { describe, expect, test } from "bun:test";
import { imageTarget } from "./image-target.ts";
import { bootTestTimeout } from "./timeouts.ts";

const SKIP = !process.env.QUICKCHR_INTEGRATION;
const NAMES = ["integration-identity-provisioned", "integration-identity-boot-only", "integration-identity-opt-out"];

type Instance = Awaited<ReturnType<typeof import("../../src/lib/quickchr.ts").QuickCHR.start>>;

async function cleanup(name: string): Promise<void> {
	const { QuickCHR } = await import("../../src/lib/quickchr.ts");
	const existing = QuickCHR.get(name);
	if (!existing) return;
	try { await existing.stop(); } catch { /* ignore */ }
	try { await existing.remove(); } catch { /* ignore */ }
}

/** The identity as RouterOS reports it, past the post-boot REST race. */
async function identityOf(instance: Instance): Promise<string> {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		try {
			const got = (await instance.rest("/system/identity")) as { name?: string };
			if (typeof got.name === "string") return got.name;
		} catch { /* REST can lag readiness */ }
		await Bun.sleep(1000);
	}
	throw new Error(`${instance.name}: /system/identity never answered`);
}

describe.skipIf(SKIP)("identity follows the machine name when quickchr provisions (#265)", () => {
	const arch = process.arch === "arm64" ? "arm64" : "x86";

	test("a provisioned machine's identity is its name, and the step is recorded", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		const name = NAMES[0] as string;
		await cleanup(name);
		try {
			const instance = await QuickCHR.start({ ...imageTarget(), arch, name, secureLogin: true, networks: ["user"] });
			expect(await identityOf(instance)).toBe(name);
			expect(QuickCHR.get(name)?.state.provisioning?.steps).toContain("identity");
		} finally {
			await cleanup(name);
		}
	}, bootTestTimeout());

	test("a boot-only machine keeps the factory identity", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		const name = NAMES[1] as string;
		await cleanup(name);
		try {
			const instance = await QuickCHR.start({ ...imageTarget(), arch, name, networks: ["user"] });
			expect(await identityOf(instance)).not.toBe(name);
			expect(QuickCHR.get(name)?.state.provisioning).toBeUndefined();
		} finally {
			await cleanup(name);
		}
	}, bootTestTimeout());

	test("add({ identity: false }) then a provisioning start keeps the factory identity", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		const name = NAMES[2] as string;
		await cleanup(name);
		try {
			await QuickCHR.add({ ...imageTarget(), arch, name, secureLogin: true, identity: false, networks: ["user"] });
			const instance = await QuickCHR.start({ name });
			expect(await identityOf(instance)).not.toBe(name);
			const steps = QuickCHR.get(name)?.state.provisioning?.steps ?? [];
			expect(steps).toContain("secureLogin");
			expect(steps).not.toContain("identity");
		} finally {
			await cleanup(name);
		}
	}, bootTestTimeout());
});
