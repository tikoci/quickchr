/**
 * #294: removeOrphan() must not delete a machine directory whose QEMU is still
 * running. `start()` saves machine.json only after spawning, so a run killed in that
 * window leaves a live VM behind a directory that looks half-created. The directory's
 * `qemu.pid` is the only record of it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuickCHR } from "../../src/lib/quickchr.ts";
import { clearStalePidfile, liveQemuFor, spawnQemu } from "../../src/lib/qemu.ts";
import { getMachineDir } from "../../src/lib/state.ts";

const origDataDir = process.env.QUICKCHR_DATA_DIR;
const isWindows = process.platform === "win32";
let root: string;
const pids: number[] = [];
const children: Array<ReturnType<typeof Bun.spawn>> = [];

/** A live stand-in for QEMU with `args` on its command line, as QEMU carries its disk
 *  and channel paths. Bun itself, so it exists on every platform. */
function spawnIdle(...args: string[]) {
	const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(60_000)", ...args], { stdout: "ignore", stderr: "ignore" });
	children.push(child);
	waitForArgv(child.pid);
	return child;
}

/** Until the child has exec'd, its command line is empty (Linux) or the parent's, and
 *  liveQemuFor() rightly calls the pid unverified. A CI runner caught that window 1 ms
 *  after spawn, so wait for the child's own argv before any test reads it. */
function waitForArgv(pid: number): void {
	if (isWindows) return;
	const read = () => process.platform === "linux"
		? (() => { try { return readFileSync(`/proc/${pid}/cmdline`, "utf8"); } catch { return ""; } })()
		: Bun.spawnSync(["/bin/ps", "-ww", "-o", "command=", "-p", String(pid)], { stdout: "pipe" }).stdout.toString();
	const deadline = Date.now() + 5000;
	while (!read().includes("Bun.sleep(60_000)") && Date.now() < deadline) Bun.sleepSync(10);
}

/** A QEMU-shaped disk argument for a file in `dir`. */
function diskArg(dir: string): string {
	return `file=${join(dir, "boot.qcow2")},format=qcow2,if=virtio`;
}

/** A directory with no machine.json, as a start killed before its first save leaves. */
function orphanWithPid(name: string, pid: number | string): string {
	const dir = getMachineDir(name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "qemu.pid"), String(pid));
	return dir;
}

function errorOf(fn: () => unknown): { code?: string; message: string; installHint?: string } {
	try {
		fn();
	} catch (e) {
		return e as { code?: string; message: string; installHint?: string };
	}
	throw new Error("expected a throw");
}

beforeEach(() => {
	// Per-test directory, so parallel runs in one checkout cannot share fixtures.
	root = mkdtempSync(join(tmpdir(), "quickchr-orphan-"));
	process.env.QUICKCHR_DATA_DIR = join(root, "data");
	mkdirSync(process.env.QUICKCHR_DATA_DIR, { recursive: true });
});

afterEach(async () => {
	try {
		for (const child of children.splice(0)) {
			child.kill();
			await child.exited;
		}
		for (const pid of pids.splice(0)) {
			try { process.kill(pid); } catch { /* already gone */ }
		}
	} finally {
		if (origDataDir === undefined) delete process.env.QUICKCHR_DATA_DIR;
		else process.env.QUICKCHR_DATA_DIR = origDataDir;
		rmSync(root, { recursive: true, force: true });
	}
});

describe("removeOrphan with a live QEMU (#294)", () => {
	test("refuses with MACHINE_RUNNING and the pid, and deletes nothing", () => {
		const dir = getMachineDir("half-made");
		const child = spawnIdle(diskArg(dir));
		orphanWithPid("half-made", child.pid);

		const error = errorOf(() => QuickCHR.removeOrphan("half-made"));
		expect(error.code).toBe("MACHINE_RUNNING");
		expect(error.message).toContain(String(child.pid));
		// Windows cannot read the command line, so the pid stays unverified there and
		// the hint does not hand out a kill command.
		if (isWindows) expect(error.installHint).not.toContain("taskkill");
		else expect(error.installHint).toContain(`kill ${child.pid}`);
		expect(existsSync(dir)).toBe(true);
	});

	test("removes the directory once that QEMU has exited", async () => {
		const dir = getMachineDir("half-made");
		const child = spawnIdle(diskArg(dir));
		orphanWithPid("half-made", child.pid);
		child.kill();
		await child.exited;

		expect(QuickCHR.removeOrphan("half-made")).toBe(true);
		expect(existsSync(dir)).toBe(false);
	});

	test("a missing or non-numeric qemu.pid does not block removal", () => {
		mkdirSync(getMachineDir("no-pidfile"), { recursive: true });
		expect(QuickCHR.removeOrphan("no-pidfile")).toBe(true);

		// parseInt would read "<pid>abc" as a pid; the pidfile is digits only.
		const live = spawnIdle(diskArg(getMachineDir("bad-pidfile")));
		orphanWithPid("bad-pidfile", `${live.pid}abc`);
		expect(QuickCHR.removeOrphan("bad-pidfile")).toBe(true);
	});

	// Command lines are readable on Linux and macOS only; on Windows every live pid is
	// unverified, which the first test covers.
	describe.skipIf(isWindows)("identity by command line", () => {
		test("a live pid whose command line names another directory is a reused pid", () => {
			const unrelated = spawnIdle();
			const dir = orphanWithPid("reused-pid", unrelated.pid);
			expect(liveQemuFor(dir)).toBeUndefined();
			expect(QuickCHR.removeOrphan("reused-pid")).toBe(true);
			expect(existsSync(dir)).toBe(false);
		});

		test("a sibling machine whose name extends this one's is not a match", () => {
			const other = spawnIdle(diskArg(getMachineDir("lab-other")));
			const dir = orphanWithPid("lab", other.pid);
			expect(liveQemuFor(dir)).toBeUndefined();
			expect(QuickCHR.removeOrphan("lab")).toBe(true);
		});

		test("a data dir reached through a symlink still matches, either way round", () => {
			const real = process.env.QUICKCHR_DATA_DIR as string;
			const alias = join(root, "alias");
			symlinkSync(real, alias, "dir");

			// Launched through the real path, removed through the alias.
			const viaReal = spawnIdle(diskArg(join(real, "machines", "one")));
			orphanWithPid("one", viaReal.pid);
			process.env.QUICKCHR_DATA_DIR = alias;
			expect(errorOf(() => QuickCHR.removeOrphan("one")).code).toBe("MACHINE_RUNNING");

			// Launched through the alias, removed through the real path.
			const viaAlias = spawnIdle(diskArg(join(alias, "machines", "two")));
			process.env.QUICKCHR_DATA_DIR = real;
			orphanWithPid("two", viaAlias.pid);
			expect(errorOf(() => QuickCHR.removeOrphan("two")).code).toBe("MACHINE_RUNNING");
			expect(existsSync(join(real, "machines", "one"))).toBe(true);
			expect(existsSync(join(real, "machines", "two"))).toBe(true);
		});

		test("a machines/<name>/ path that does not resolve here refuses, without a kill hint", () => {
			const elsewhere = spawnIdle(diskArg(join(root, "elsewhere", "machines", "same-name")));
			const dir = orphanWithPid("same-name", elsewhere.pid);
			expect(liveQemuFor(dir)).toEqual({ pid: elsewhere.pid, verified: false });

			const error = errorOf(() => QuickCHR.removeOrphan("same-name"));
			expect(error.code).toBe("MACHINE_RUNNING");
			expect(error.installHint).not.toContain("kill");
			expect(error.installHint).toContain("qemu.pid");
			expect(existsSync(dir)).toBe(true);
		});
	});
});

describe("qemu.pid lifecycle (#294)", () => {
	test("spawnQemu records the pid before its early-exit check", async () => {
		const dir = join(root, "spawned");
		const pending = spawnQemu([process.execPath, "-e", "await Bun.sleep(60_000)"], dir, true);
		let early: string | undefined;
		let pid = 0;
		try {
			await Bun.sleep(300);
			// The check sleeps 1.5 s; a launcher killed now must still leave a record.
			early = readFileSync(join(dir, "qemu.pid"), "utf8");
		} finally {
			// Register the child even when the early read throws (the regression this
			// test catches), so afterEach kills it instead of leaving it for 60 s.
			({ pid } = await pending);
			pids.push(pid);
		}
		expect(early).toBe(String(pid));
	});

	test("clearStalePidfile removes a dead pid's file and keeps a live one", async () => {
		const dir = join(root, "stale");
		mkdirSync(dir, { recursive: true });
		const child = spawnIdle();
		writeFileSync(join(dir, "qemu.pid"), String(child.pid));
		clearStalePidfile(dir);
		expect(existsSync(join(dir, "qemu.pid"))).toBe(true);

		child.kill();
		await child.exited;
		clearStalePidfile(dir);
		expect(existsSync(join(dir, "qemu.pid"))).toBe(false);
	});
});
