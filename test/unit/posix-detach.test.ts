/**
 * POSIX detach: a backgrounded QEMU survives a signal sent to the process group
 * of the CLI that started it (#159).
 *
 * `unref()` alone is not detachment. It lets the parent exit *voluntarily* and
 * leaves the child adopted by init/launchd, which is why this looked fine for so
 * long — but the child stays in the caller's process group, so a group signal
 * reaches it: Ctrl-C in the terminal, a shell `timeout`, a CI step teardown, an
 * agent harness killing a stuck command. The reporter's workaround was to wrap
 * every start in `nohup`.
 *
 * The test spawns a harness in its own process group, has it background a
 * long-running stand-in process through `spawnQemu`, then signals the *group*.
 * The stand-in is `sleep`, not QEMU: what is under test is the spawn mode, which
 * is the same code path whatever binary it launches.
 *
 * The harness assertion is the control. Without it a broken detach and an
 * undelivered signal look identical — both leave the stand-in alive — so the
 * test only means something once the harness itself is confirmed dead.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

const isWindows = process.platform === "win32";

/** True while the process exists and is signalable. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Poll until `check()` holds or the budget runs out. Returns whether it held. */
async function until(check: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return true;
		await Bun.sleep(50);
	}
	return check();
}

describe.skipIf(isWindows)("POSIX spawnQemu — detached from the caller's process group", () => {
	const TMP = join(tmpdir(), "quickchr-posix-detach-test");
	const machineDir = join(TMP, "machine");
	const harnessPath = join(TMP, "harness.ts");
	const readyPath = join(TMP, "ready");

	let harnessPid: number | undefined;
	let childPid: number | undefined;

	beforeEach(() => {
		rmSync(TMP, { recursive: true, force: true });
		mkdirSync(machineDir, { recursive: true });
	});

	afterEach(() => {
		for (const pid of [childPid, harnessPid]) {
			if (pid !== undefined && alive(pid)) {
				try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
			}
		}
		childPid = undefined;
		harnessPid = undefined;
		rmSync(TMP, { recursive: true, force: true });
	});

	test("a group signal kills the caller and leaves the backgrounded process running", async () => {
		const qemuModule = join(import.meta.dir, "..", "..", "src", "lib", "qemu.ts");

		// Stands in for the CLI: backgrounds a process through spawnQemu, then
		// waits forever so it is still in its group when the signal arrives.
		writeFileSync(
			harnessPath,
			`import { spawnQemu } from ${JSON.stringify(qemuModule)};
import { writeFileSync } from "node:fs";

await spawnQemu(["sleep", "120"], ${JSON.stringify(machineDir)}, true);
writeFileSync(${JSON.stringify(readyPath)}, "ready");
await new Promise(() => {});
`,
		);

		// detached: true makes the harness its own process-group leader, so the
		// signal below cannot reach this test runner.
		const harness = spawn(process.execPath, [harnessPath], {
			detached: true,
			stdio: ["ignore", "ignore", "ignore"],
		});
		expect(harness.pid).toBeDefined();
		if (harness.pid === undefined) return;
		const leaderPid = harness.pid;
		harnessPid = leaderPid;

		// spawnQemu holds the child for 1.5 s to catch an immediate exit.
		expect(await until(() => existsSync(readyPath), 20_000)).toBe(true);

		childPid = Number(readFileSync(join(machineDir, "qemu.pid"), "utf-8").trim());
		expect(Number.isInteger(childPid)).toBe(true);
		expect(alive(childPid)).toBe(true);

		// The negative process id is the whole point: this addresses the group,
		// exactly as Ctrl-C or a shell `timeout` would.
		process.kill(-leaderPid, "SIGTERM");

		// Control: the signal was delivered, so a surviving child means detachment
		// and not a signal that went nowhere.
		expect(await until(() => !alive(leaderPid), 10_000)).toBe(true);

		expect(alive(childPid)).toBe(true);
	}, 45_000);
});
