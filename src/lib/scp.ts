/**
 * SCP file transfer to/from a running CHR.
 *
 * Uses the same SSH_ASKPASS trick as {@link ./packages.ts uploadPackages} so
 * no `sshpass` dependency is required. Both directions share the askpass
 * lifecycle (written to a private tmpdir, removed after the transfer).
 */

import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { QuickCHRError } from "./types.ts";

export interface ScpOptions {
	sshPort: number;
	user: string;
	password: string;
}

/** Copy a local file to the CHR. `remotePath` defaults to `/<basename>` (RouterOS flash root). */
export async function scpPush(
	localPath: string,
	remotePath: string | undefined,
	opts: ScpOptions,
): Promise<void> {
	const remote = remotePath ?? `/${basename(localPath)}`;
	await runScp([localPath, `${opts.user}@127.0.0.1:${remote}`], opts, `upload ${basename(localPath)}`);
}

/** Copy a file from the CHR to the local filesystem. */
export async function scpPull(
	remotePath: string,
	localPath: string,
	opts: ScpOptions,
): Promise<void> {
	await runScp([`${opts.user}@127.0.0.1:${remotePath}`, localPath], opts, `download ${remotePath}`);
}

/** Shared plumbing: write askpass, invoke `scp`, clean up, translate exit code to QuickCHRError. */
async function runScp(
	scpArgs: string[],
	opts: ScpOptions,
	label: string,
): Promise<void> {
	const { askpassPath, env } = await writeAskpass(opts.password);
	try {
		const args = [
			"scp",
			"-P", String(opts.sshPort),
			"-o", "StrictHostKeyChecking=accept-new",
			"-o", "UserKnownHostsFile=/dev/null",
			...scpArgs,
		];
		const result = Bun.spawnSync(args, {
			stdout: "pipe",
			stderr: "pipe",
			env,
		});
		if (result.exitCode !== 0) {
			const stderr = new TextDecoder().decode(result.stderr);
			throw new QuickCHRError(
				"PROCESS_FAILED",
				`SCP ${label} failed: ${stderr.trim() || `exit ${result.exitCode}`}`,
			);
		}
	} finally {
		try { rmSync(dirname(askpassPath), { recursive: true, force: true }); } catch { /* ignore */ }
	}
}

/**
 * Write an SSH_ASKPASS helper for the given password.
 *
 * SSH_ASKPASS: a small program OpenSSH invokes to fetch a password when no
 * TTY is available. `SSH_ASKPASS_REQUIRE=force` (OpenSSH 8.4+) makes it work
 * without a display. On Windows we emit a `.cmd`; on Unix a `.sh`
 * with the execute bit set.
 *
 * `force`, not `prefer`: under `prefer` OpenSSH skips askpass unless DISPLAY
 * is non-empty — and we set `DISPLAY: ""` below — so askpass never runs and
 * ssh falls back to stdin (EOF in a non-interactive spawn) and submits an
 * *empty* password. Every non-empty password then fails with a
 * genuine-looking "Permission denied" while empty ones keep working, which is
 * exactly how this hid: all SCP traffic used factory `admin:` until `set
 * --package` reached `--disable-admin` machines. Measured on OpenSSH 10.6:
 * `prefer` + empty/unset DISPLAY never runs askpass; `force` runs it with
 * DISPLAY unset and empty alike. Exported for the unit test that pins this.
 */
export async function writeAskpass(password: string): Promise<{ askpassPath: string; env: Record<string, string> }> {
	const isWindows = process.platform === "win32";
	const ext = isWindows ? ".cmd" : ".sh";
	// A private directory first: the script carries the password, and a file
	// created directly in shared tmpdir is world-readable between creation
	// and chmod. mkdtemp creates the directory owner-only (0o700).
	const dir = mkdtempSync(join(tmpdir(), "quickchr-askpass-"));
	const askpassPath = join(dir, `askpass${ext}`);
	try {
		if (isWindows) {
			await Bun.write(askpassPath, `@echo off\r\necho ${password.replace(/[&|<>^%]/g, "^$&")}\r\n`);
		} else {
			await Bun.write(askpassPath, `#!/bin/sh\nprintf '%s' '${password.replace(/'/g, "'\\''")}'`);
			// Owner-only: OpenSSH runs askpass as us, so no other user needs
			// read or execute.
			chmodSync(askpassPath, 0o700);
		}
	} catch (e) {
		// The caller's cleanup only runs once this returns, so a failed setup
		// must not leave a (possibly password-bearing) directory behind.
		rmSync(dir, { recursive: true, force: true });
		throw e;
	}
	const env: Record<string, string> = {
		...(process.env as Record<string, string>),
		DISPLAY: "",
		SSH_ASKPASS: askpassPath,
		SSH_ASKPASS_REQUIRE: "force",
	};
	return { askpassPath, env };
}
