/**
 * SCP file transfer to/from a running CHR.
 *
 * Uses the same SSH_ASKPASS trick as {@link ./packages.ts uploadPackages} so
 * no `sshpass` dependency is required. Both directions share the askpass
 * lifecycle (written to tmpdir, cleaned up on exit).
 */

import { chmodSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

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
		try { unlinkSync(askpassPath); } catch { /* ignore */ }
	}
}

/**
 * Write an SSH_ASKPASS helper for the given password.
 *
 * SSH_ASKPASS: a small program OpenSSH invokes to fetch a password when no
 * TTY is available. `SSH_ASKPASS_REQUIRE=prefer` (OpenSSH 8.4+) makes it
 * work without a display. On Windows we emit a `.cmd`; on Unix a `.sh`
 * with the execute bit set.
 */
async function writeAskpass(password: string): Promise<{ askpassPath: string; env: Record<string, string> }> {
	const isWindows = process.platform === "win32";
	const ext = isWindows ? ".cmd" : ".sh";
	const askpassPath = join(tmpdir(), `quickchr-askpass-${process.pid}-${Date.now()}${ext}`);
	if (isWindows) {
		await Bun.write(askpassPath, `@echo off\r\necho ${password.replace(/[&|<>^%]/g, "^$&")}\r\n`);
	} else {
		await Bun.write(askpassPath, `#!/bin/sh\nprintf '%s' '${password.replace(/'/g, "'\\''")}'`);
		chmodSync(askpassPath, 0o755);
	}
	const env: Record<string, string> = {
		...(process.env as Record<string, string>),
		DISPLAY: "",
		SSH_ASKPASS: askpassPath,
		SSH_ASKPASS_REQUIRE: "prefer",
	};
	return { askpassPath, env };
}
