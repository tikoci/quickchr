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

/** Free disk on the working filesystem, in MiB. `undefined` when unreadable. */
async function freeDiskMiB(): Promise<number | undefined> {
	try {
		if (process.platform === "win32") {
			// `wmic` is gone on current windows-latest images; PowerShell is not.
			const proc = Bun.spawn(
				["powershell", "-NoProfile", "-Command", "(Get-PSDrive -Name (Get-Location).Drive.Name).Free"],
				{ stdout: "pipe", stderr: "ignore" },
			);
			const text = await new Response(proc.stdout).text();
			await proc.exited;
			const bytes = Number(text.trim());
			return Number.isFinite(bytes) ? Math.round(bytes / 1048576) : undefined;
		}
		const proc = Bun.spawn(["df", "-k", "."], { stdout: "pipe", stderr: "ignore" });
		const text = await new Response(proc.stdout).text();
		await proc.exited;
		// Second line, fourth column: 1K-blocks available.
		const avail = Number(text.trim().split("\n")[1]?.split(/\s+/)[3]);
		return Number.isFinite(avail) ? Math.round(avail / 1024) : undefined;
	} catch {
		return undefined;
	}
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
}

/**
 * Host state right now — #77's list: free memory, load, disk, QEMU count.
 *
 * `withQemuCount` is opt-in because the count costs a process spawn, and the
 * watchdog takes its own counts either side of the reap rather than folding one
 * into the snapshot.
 */
export async function hostSnapshot(withQemuCount = false): Promise<HostSnapshot> {
	const snapshot: HostSnapshot = {
		platform: process.platform,
		cpuCount: cpus().length,
		totalMemMiB: Math.round(totalmem() / 1048576),
		freeMemMiB: Math.round(freemem() / 1048576),
		freeDiskMiB: await freeDiskMiB(),
		loadAvg: loadavg(),
		hostUptimeS: Math.round(uptime()),
	};
	if (withQemuCount) snapshot.qemuCount = await qemuProcessCount();
	return snapshot;
}
