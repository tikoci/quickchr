import { describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { writeAskpass } from "../../src/lib/scp.ts";

/**
 * The SSH_ASKPASS contract `scpPush()`/`scpPull()` rely on.
 *
 * Under `SSH_ASKPASS_REQUIRE=prefer` OpenSSH skips askpass unless DISPLAY is
 * non-empty — and we spawn with `DISPLAY: ""` — so askpass never ran and ssh
 * submitted an empty password for every SCP transfer. Empty passwords kept
 * working, every real one failed with "Permission denied", and nothing pointed
 * at the client: this hid until `set --package` reached `--disable-admin`
 * machines (live coverage in `test/integration/set-package.test.ts`). `force`
 * runs askpass regardless of DISPLAY (measured on OpenSSH 10.6).
 */

describe("writeAskpass", () => {
	test("requires askpass unconditionally — prefer skips it on an empty DISPLAY", async () => {
		const { askpassPath, env } = await writeAskpass("lab-pass-1");
		try {
			expect(env.SSH_ASKPASS).toBe(askpassPath);
			expect(env.SSH_ASKPASS_REQUIRE).toBe("force");
			expect(env.DISPLAY).toBe("");
		} finally {
			unlinkSync(askpassPath);
		}
	});

	// The script round-trip needs a POSIX shell to execute; the quoting it pins
	// is the Unix branch. (Windows emits a .cmd instead, which needs cmd.exe.)
	test.skipIf(process.platform === "win32")("the script prints exactly the password", async () => {
		for (const password of ["lab-pass-1", "", `pa'ss"wo\\rd$1 `]) {
			const { askpassPath } = await writeAskpass(password);
			try {
				const result = Bun.spawnSync([askpassPath], { stdout: "pipe", stderr: "pipe" });
				expect(result.exitCode).toBe(0);
				expect(new TextDecoder().decode(result.stdout)).toBe(password);
			} finally {
				unlinkSync(askpassPath);
			}
		}
	});
});
