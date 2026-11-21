/**
 * #294: removeOrphan() must not delete a machine directory whose QEMU is still
 * running. `start()` saves machine.json only after spawning, so a run killed in that
 * window leaves a live VM behind a directory that looks half-created. The directory's
 * `qemu.pid` is the only record of it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { QuickCHR } from "../../src/lib/quickchr.ts";
import { liveQemuPidFor } from "../../src/lib/qemu.ts";
import { getMachineDir } from "../../src/lib/state.ts";

const TEST_DIR = join(import.meta.dir, ".tmp-remove-orphan-live-qemu");
const origDataDir = process.env.QUICKCHR_DATA_DIR;
const children: Array<ReturnType<typeof Bun.spawn>> = [];

/** A live stand-in for QEMU whose command line carries `extraArg`, as QEMU's carries
 *  the machine directory. Bun itself, so it exists on every platform. */
function spawnIdle(extraArg?: string) {
	const argv = [process.execPath, "-e", "await Bun.sleep(60_000)"];
	if (extraArg) argv.push(extraArg);
	const child = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" });
	children.push(child);
	return child;
}

/** A directory with no machine.json, as a start killed before its first save leaves. */
function orphanWithPid(name: string, pid: number): string {
	const dir = getMachineDir(name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "qemu.pid"), String(pid));
	return dir;
}

beforeEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.QUICKCHR_DATA_DIR = TEST_DIR;
});

afterEach(async () => {
	for (const child of children.splice(0)) {
		child.kill();
		await child.exited;
	}
	rmSync(TEST_DIR, { recursive: true, force: true });
	if (origDataDir === undefined) delete process.env.QUICKCHR_DATA_DIR;
	else process.env.QUICKCHR_DATA_DIR = origDataDir;
});

describe("removeOrphan with a live QEMU (#294)", () => {
	test("refuses with MACHINE_RUNNING and the pid, and deletes nothing", () => {
		const dir = getMachineDir("half-made");
		const child = spawnIdle(dir);
		orphanWithPid("half-made", child.pid);

		let error: unknown;
		try {
			QuickCHR.removeOrphan("half-made");
		} catch (e) {
			error = e;
		}
		expect((error as { code?: string }).code).toBe("MACHINE_RUNNING");
		expect((error as Error).message).toContain(`PID ${child.pid}`);
		expect(existsSync(dir)).toBe(true);
	});

	test("removes the directory once that QEMU has exited", async () => {
		const dir = getMachineDir("half-made");
		const child = spawnIdle(dir);
		orphanWithPid("half-made", child.pid);
		child.kill();
		await child.exited;

		expect(QuickCHR.removeOrphan("half-made")).toBe(true);
		expect(existsSync(dir)).toBe(false);
	});

	test("a missing or garbage qemu.pid does not block removal", () => {
		mkdirSync(getMachineDir("no-pidfile"), { recursive: true });
		expect(QuickCHR.removeOrphan("no-pidfile")).toBe(true);

		const dir = getMachineDir("bad-pidfile");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "qemu.pid"), "not a pid");
		expect(QuickCHR.removeOrphan("bad-pidfile")).toBe(true);
	});

	// qemu.pid survives a background stop, so its pid can be reused by an unrelated
	// process. Where the command line is readable it must name the machine directory.
	// Windows has no command-line check: there, a live pid counts (the first test).
	test.skipIf(process.platform === "win32")("a live pid whose command line does not name the directory is a reused pid, not QEMU", () => {
		const unrelated = spawnIdle();
		const dir = orphanWithPid("reused-pid", unrelated.pid);

		expect(liveQemuPidFor(dir)).toBeUndefined();
		expect(QuickCHR.removeOrphan("reused-pid")).toBe(true);
		expect(existsSync(dir)).toBe(false);
	});
});
