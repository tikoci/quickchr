/**
 * ci-host-snapshot — host state at a moment CI cares about (#110).
 *
 * Extracted from `ci-file-watchdog.ts` (B4) when `ci-leg-checkpoint.ts` (B5)
 * needed the same two readings. One home, imported by both, for the same reason
 * `COLD_DOWNLOAD_FLOOR_BYTES_PER_S` got one in B13: a second copy drifts, and
 * these numbers are compared *across* the two instruments — a watchdog report
 * and the checkpoint that preceded it must be describing the same quantity in
 * the same units, or the comparison is noise.
 *
 * Everything here is best-effort by design. A missing reading must cost the
 * caller a field, never the rest of its report — these run on the failure path,
 * which is exactly when a tool is most likely to be unavailable.
 */
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { cpus, freemem, loadavg, totalmem, uptime } from "node:os";

/**
 * Count live QEMU processes.
 *
 * The cleanup verdict rests on this, so an unavailable tool reads as
 * `undefined` ("unknown"), never as `0` ("none left"). A false clean bill of
 * health is worse than no check.
 */
export async function qemuProcessCount(): Promise<number | undefined> {
	// No image-name filter on Windows: `/FI` takes a single image, and the reap
	// kills two. Filtering on x86_64 alone would report a verified cleanup with a
	// live aarch64 emulator. Scan the full list and let the substring match cover
	// both — which also covers tasklist's "INFO: No tasks are running…" line
	// without a special case.
	const cmd = process.platform === "win32" ? ["tasklist", "/NH"] : ["pgrep", "-f", "qemu-system-(x86_64|aarch64)"];
	try {
		const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
		const text = await new Response(proc.stdout).text();
		await proc.exited;
		const lines = text
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean);
		if (process.platform === "win32") {
			return lines.filter((l) => l.toLowerCase().includes("qemu-system")).length;
		}
		// pgrep exits 1 with no output when nothing matches — that is a real zero.
		return lines.length;
	} catch {
		return undefined;
	}
}

/**
 * Nearest existing ancestor of `dir`.
 *
 * `df` and `Get-PSDrive` both fail on a path that does not exist yet, and the
 * quickchr data dir does not exist until the first machine is created — which on
 * a cold leg is minutes in. Reporting `undefined` there would put a hole in the
 * series that reads like a failed measurement rather than "same volume, nothing
 * written to it yet".
 */
function nearestExisting(dir: string): string {
	let p = dir;
	for (let i = 0; i < 16 && !existsSync(p); i += 1) {
		const up = dirname(p);
		if (up === p) return ".";
		p = up;
	}
	return existsSync(p) ? p : ".";
}

/** Free disk in MiB on the filesystem holding `dir`. `undefined` when unreadable. */
async function freeDiskMiB(target = "."): Promise<number | undefined> {
	const dir = nearestExisting(target);
	try {
		if (process.platform === "win32") {
			// `wmic` is gone on current windows-latest images; PowerShell is not.
			const proc = Bun.spawn(
				[
					"powershell",
					"-NoProfile",
					"-Command",
					`(Get-PSDrive -Name (Get-Item -LiteralPath '${dir.replace(/'/g, "''")}').PSDrive.Name).Free`,
				],
				{ stdout: "pipe", stderr: "ignore" },
			);
			const text = await new Response(proc.stdout).text();
			await proc.exited;
			// A failed PowerShell expression writes its error to stderr and leaves
			// stdout EMPTY — and `Number("")` is 0, which `Number.isFinite` accepts.
			// Without the emptiness check this reports "0 MiB free" for a reading it
			// never took: a fabricated disk-exhaustion signal, on the platform where
			// the workspace and quickchr volumes actually differ, feeding the one
			// hypothesis this snapshot exists to test. Absent must stay absent.
			const raw = text.trim();
			if (!raw) return undefined;
			const bytes = Number(raw);
			return Number.isFinite(bytes) ? Math.round(bytes / 1048576) : undefined;
		}
		const proc = Bun.spawn(["df", "-k", dir], { stdout: "pipe", stderr: "ignore" });
		const text = await new Response(proc.stdout).text();
		await proc.exited;
		// Second line, fourth column: 1K-blocks available.
		const avail = Number(text.trim().split("\n")[1]?.split(/\s+/)[3]);
		return Number.isFinite(avail) ? Math.round(avail / 1024) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * macOS memory pressure and swap — the two readings `os.freemem()` cannot give.
 *
 * #77's per-checkpoint list said "free memory / memory pressure" and only the
 * first half was ever built. On macOS that half is close to meaningless on its
 * own: `freemem()` counts only genuinely free pages, so a host with gigabytes of
 * purgeable cache reports a number that looks like exhaustion and is not, while
 * a host that is actually swapping to death reports the same number. #76's leg
 * dies host-level with the guest holding ~2 GiB on a 14 GiB runner, so "is it
 * running out of memory" is a live hypothesis that free-pages alone cannot
 * answer either way.
 *
 * `memory_pressure -Q` gives the kernel's own system-wide free percentage and
 * `vm.swapusage` gives swap actually in use. Both are one cheap spawn, both are
 * best-effort, and both are absent on other platforms — a missing field here
 * means "not measured", never "zero".
 */
async function macMemoryDetail(): Promise<{ memFreePct?: number; swapUsedMiB?: number }> {
	if (process.platform !== "darwin") return {};
	const out: { memFreePct?: number; swapUsedMiB?: number } = {};
	try {
		const proc = Bun.spawn(["memory_pressure", "-Q"], { stdout: "pipe", stderr: "ignore" });
		const text = await new Response(proc.stdout).text();
		await proc.exited;
		const pct = Number(/free percentage:\s*(\d+)/.exec(text)?.[1]);
		if (Number.isFinite(pct)) out.memFreePct = pct;
	} catch {
		// leave undefined
	}
	try {
		const proc = Bun.spawn(["sysctl", "-n", "vm.swapusage"], { stdout: "pipe", stderr: "ignore" });
		const text = await new Response(proc.stdout).text();
		await proc.exited;
		// `total = 3072.00M  used = 1596.25M  free = 1475.75M  (encrypted)`
		const used = /used\s*=\s*([\d.]+)(G|M|K)/.exec(text);
		if (used?.[1]) {
			const scale = used[2] === "G" ? 1024 : used[2] === "K" ? 1 / 1024 : 1;
			out.swapUsedMiB = Math.round(Number(used[1]) * scale);
		}
	} catch {
		// leave undefined
	}
	return out;
}

export interface HostSnapshot {
	platform: string;
	cpuCount: number;
	totalMemMiB: number;
	freeMemMiB: number;
	freeDiskMiB?: number;
	loadAvg: number[];
	/**
	 * HOST uptime, from `os.uptime()`.
	 *
	 * B4's watchdog reported `uptimeS` from `process.uptime()` — the *watchdog
	 * process's* life, which duplicated its own `elapsed_s` and would read ~0 in
	 * every checkpoint here. Renamed rather than reused so nothing reads a
	 * checkpoint's number as if it meant the watchdog's.
	 */
	hostUptimeS: number;
	qemuCount?: number;
	/**
	 * Free disk on the volume holding quickchr's data dir, in MiB.
	 *
	 * Separate from `freeDiskMiB` (the workspace) because they are not the same
	 * volume everywhere: on Windows the workspace is on `D:` while quickchr state
	 * is on `C:`, and it is the *quickchr* volume that fills with images, machine
	 * disks and snapshots. On macOS and Linux runners they usually coincide, and
	 * reporting both makes that a measurement rather than an assumption.
	 */
	freeDataDiskMiB?: number;
	/** macOS only — kernel's system-wide free percentage (`memory_pressure -Q`). */
	memFreePct?: number;
	/** macOS only — swap in use, MiB (`vm.swapusage`). */
	swapUsedMiB?: number;
}

/**
 * Host state right now — #77's list: free memory, load, disk, QEMU count.
 *
 * `withQemuCount` is opt-in because the count costs a process spawn, and the
 * watchdog takes its own counts either side of the reap rather than folding one
 * into the snapshot.
 *
 * `dataDir` is likewise opt-in: resolving it costs a second `df`, which the
 * boundary-marking callers do not need but the in-file heartbeat (B8d) does.
 */
export async function hostSnapshot(withQemuCount = false, dataDir?: string): Promise<HostSnapshot> {
	const snapshot: HostSnapshot = {
		platform: process.platform,
		cpuCount: cpus().length,
		totalMemMiB: Math.round(totalmem() / 1048576),
		freeMemMiB: Math.round(freemem() / 1048576),
		freeDiskMiB: await freeDiskMiB(),
		loadAvg: loadavg(),
		hostUptimeS: Math.round(uptime()),
		...(await macMemoryDetail()),
	};
	if (withQemuCount) snapshot.qemuCount = await qemuProcessCount();
	if (dataDir) snapshot.freeDataDiskMiB = await freeDiskMiB(dataDir);
	return snapshot;
}
