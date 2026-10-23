import { describe, expect, test } from "bun:test";
import { join } from "node:path";

describe("wizard prerequisites (#208)", () => {
	test("missing qemu-img refuses with remedy before prompts, downloads, or start", async () => {
		// Isolate module mocks from the other unit tests importing the wizard/library.
		const worker = Bun.spawn([process.execPath, join(import.meta.dir, "helpers/wizard-missing-qemu-img-worker.ts")], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(worker.stdout).text(), new Response(worker.stderr).text(), worker.exited,
		]);
		expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
		expect(JSON.parse(stdout)).toEqual({
			prompts: 0, downloads: 0, starts: 0,
			code: "MISSING_QEMU",
			message: "qemu-img not found (required for disk operations)",
			installHint: "Install QEMU including qemu-img",
		});
	});
});
