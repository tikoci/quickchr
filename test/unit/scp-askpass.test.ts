import { describe, expect, test } from "bun:test";
import { rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
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
			rmSync(dirname(askpassPath), { recursive: true, force: true });
		}
	});

	// POSIX-only: Windows ACLs do not report Unix mode bits, though the
	// script still lives in a private directory there.
	test.skipIf(process.platform === "win32")("the script and its directory are owner-only", async () => {
		// The script carries the password: world-readable in shared tmpdir
		// would expose it to other local users for the transfer window.
		const { askpassPath } = await writeAskpass("lab-pass-1");
		try {
			expect(statSync(askpassPath).mode & 0o777).toBe(0o700);
			expect(statSync(dirname(askpassPath)).mode & 0o777).toBe(0o700);
		} finally {
			rmSync(dirname(askpassPath), { recursive: true, force: true });
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
				rmSync(dirname(askpassPath), { recursive: true, force: true });
			}
		}
	});
});
