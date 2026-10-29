import { describe, test, expect, beforeAll } from "bun:test";
import { join } from "node:path";
import { imageTarget } from "./image-target.ts";
import { bootTestTimeout } from "./timeouts.ts";

/**
 * Integration tests — `quickchr set <name> --package …` (#24).
 *
 * The library path (`installPackage()`) is covered in `start-stop.test.ts`; this
 * covers the route as a *user* meets it. A parser, dispatch or output regression
 * would leave the command printed by PROVISIONING_WINDOW_CLOSED unusable while
 * every other test stayed green.
 *
 * Requires QEMU. Skipped unless QUICKCHR_INTEGRATION=1.
 */

const SKIP = !process.env.QUICKCHR_INTEGRATION;

async function cleanupMachine(name: string): Promise<void> {
	const { QuickCHR } = await import("../../src/lib/quickchr.ts");
	const existing = QuickCHR.get(name);
	if (!existing) return;
	try { await existing.stop(); } catch { /* ignore */ }
	try { await existing.remove(); } catch { /* ignore */ }
}

describe.skipIf(SKIP)("set --package", () => {
	beforeAll(async () => {
		await cleanupMachine("integration-set-pkg-cli");
	});

	test("the CLI command the refusal prints actually works, run as a process", async () => {
		const { QuickCHR } = await import("../../src/lib/quickchr.ts");
		const { QuickCHRError } = await import("../../src/lib/types.ts");
		// Not `new URL(...).pathname`: on Windows that is "/D:/...", which bun cannot load (#196).
		const cli = join(import.meta.dir, "../../src/cli/index.ts");

		const arch = process.arch === "arm64" ? "arm64" : "x86";
		let instance: Awaited<ReturnType<typeof QuickCHR.start>> | undefined;

		try {
			instance = await QuickCHR.start({
				...imageTarget(),
				arch,
				background: true,
				name: "integration-set-pkg-cli",
				deviceMode: { mode: "skip" },
				secureLogin: false,
			});

			expect(instance.state.status).toBe("running");

			// The window is shut, so the same request through start() is refused — and
			// the refusal names the CLI command that does work.
			let refusal: unknown;
			try {
				await QuickCHR.start({ name: "integration-set-pkg-cli", background: true, packages: ["container"] });
			} catch (e) { refusal = e; }
			expect(refusal).toBeInstanceOf(QuickCHRError);
			expect((refusal as InstanceType<typeof QuickCHRError>).code).toBe("PROVISIONING_WINDOW_CLOSED");
			expect((refusal as Error).message).toContain("quickchr set integration-set-pkg-cli --package container");

			// Now take that route, as a process — the shape a user pastes.
			const proc = Bun.spawn(["bun", cli, "set", "integration-set-pkg-cli", "--package", "container"], {
				env: { ...process.env, NO_COLOR: "1", QUICKCHR_NO_PROMPT: "1" },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			const output = stdout + stderr;

			expect({ exitCode, output }).toMatchObject({ exitCode: 0 });
			expect(output).toContain("Installing packages on integration-set-pkg-cli: container");
			expect(output).toContain("Installed 1 package on integration-set-pkg-cli: container");
			expect(output).toContain("rebooted to activate");
			expect(output).toContain('quickchr exec integration-set-pkg-cli "/system/package/print"');

			// And the guest agrees — the package is present and active after the reboot.
			const systemPkgs = await instance.rest("/system/package") as Array<Record<string, unknown>>;
			const entry = systemPkgs.find((p) => p.name === "container");
			expect(entry, 'package "container" should appear in /system/package').toBeDefined();
			expect(entry?.disabled, 'package "container" should not be disabled').not.toBe("true");

			// The step is recorded, which is what turns a later start passing the
			// same packages into a recognised no-op rather than a second refusal.
			const reloaded = QuickCHR.get("integration-set-pkg-cli");
			expect(reloaded?.state.packages).toContain("container");
			expect(reloaded?.state.provisioning?.steps).toContain("packages");
			await QuickCHR.start({ name: "integration-set-pkg-cli", background: true, packages: ["container"] });
		} finally {
			await cleanupMachine("integration-set-pkg-cli");
		}
	}, bootTestTimeout({ withPackages: true, extraMs: 120_000 })); // + SCP upload and a reboot
});
