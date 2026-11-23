/**
 * #265: quickchr sets `/system/identity` to the machine name when it provisions,
 * and only then. `secureLogin: true` is the cheapest provisioning step, so it is
 * the trigger here.
 */
import { describe, expect, test } from "bun:test";
import { resolveAuth } from "../../src/lib/auth.ts";
import { restGet } from "../../src/lib/rest.ts";
import { chrGet } from "./chr-rest.ts";
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

/** The identity as RouterOS reports it, past the post-boot REST race.
 *
 *  The retries ride out an expected condition, so they use plain `restGet()`
 *  (testing.instructions.md): `chrGet()` would collect a forensic report per retry.
 *  When they run out, one terminal `chrGet()` outside the retry loop makes a
 *  persistent transport failure on an already-ready guest throw with that report.
 *  `after` names the change that preceded the request, when there was one. */
async function identityOf(instance: Instance, after?: string): Promise<string> {
	const auth = resolveAuth(instance.state).header;
	const url = `http://127.0.0.1:${instance.ports.http}/rest/system/identity`;
	const nameIn = (body: string): string | undefined => {
		try {
			const parsed = JSON.parse(body) as { name?: unknown } | null;
			return typeof parsed?.name === "string" ? parsed.name : undefined;
		} catch {
			return undefined;
		}
	};
	const deadline = Date.now() + 30_000;
	let last = "no answer";
	while (Date.now() < deadline) {
		try {
			const got = await restGet(url, auth);
			const name = got.status === 200 ? nameIn(got.body) : undefined;
			if (name !== undefined) return name;
			last = `HTTP ${got.status} ${got.body.slice(0, 200)}`;
		} catch (e) {
			last = e instanceof Error ? e.message : String(e);
		}
		await Bun.sleep(1000);
	}
	const final = await chrGet(instance, "/rest/system/identity", auth, { after });
	const name = final.status === 200 ? nameIn(final.body) : undefined;
	if (name !== undefined) return name;
	throw new Error(
		`${instance.name}: /system/identity answered without a name ` +
		`(last retry: ${last}; final: HTTP ${final.status} ${final.body.slice(0, 200)})`,
	);
}

describe.skipIf(SKIP)("identity follows the machine name when quickchr provisions (#265)", () => {
	const arch = process.arch === "arm64" ? "arm64" : "x86";

	test("a provisioned machine's identity is its name, and the step is recorded", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		const name = NAMES[0] as string;
		await cleanup(name);
		try {
			const instance = await QuickCHR.start({ ...imageTarget(), arch, name, secureLogin: true, networks: ["user"] });
			expect(await identityOf(instance, "provisioning: identity set, secureLogin account created")).toBe(name);
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
			expect(await identityOf(instance, "provisioning: secureLogin account created, identity skipped")).not.toBe(name);
			const steps = QuickCHR.get(name)?.state.provisioning?.steps ?? [];
			expect(steps).toContain("secureLogin");
			expect(steps).not.toContain("identity");
		} finally {
			await cleanup(name);
		}
	}, bootTestTimeout());
});
