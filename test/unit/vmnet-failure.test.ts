import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const kind of ["reboot", "retry", "retry-secure", "retry-preserve", "retry-preserve-bare", "timeout"]) {
	test(`socket_vmnet ${kind} failure has bounded, consistent cleanup`, async () => {
		const dir = mkdtempSync(join(tmpdir(), "quickchr-tmp-vmnet-failure-"));
		let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
		let deadline: ReturnType<typeof setTimeout> | undefined;
		try {
			child = Bun.spawn([process.execPath, join(import.meta.dir, "helpers/vmnet-failure-worker.ts"), kind], {
				env: { ...process.env, QUICKCHR_DATA_DIR: dir, QUICKCHR_PRESERVE_ON_FAILURE: kind.startsWith("retry-preserve") ? "1" : "0" }, stdout: "pipe", stderr: "pipe",
			});
			deadline = setTimeout(() => child?.kill("SIGKILL"), 10_000);
			const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
			expect({ exit, output: out + err }).toEqual({ exit: 0, output: expect.any(String) });
			expect(out).toContain("vmnet-failure-ok");
		} finally {
			clearTimeout(deadline);
			if (child && child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
			rmSync(dir, { recursive: true, force: true });
		}
	}, 15_000);
}
