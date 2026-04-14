/**
 * Disk management — qemu-img wrapper for boot disk resizing, extra disk creation,
 * and qcow2 snapshot operations.
 *
 * All extra disks are qcow2.  Boot disk stays raw unless the user selects qcow2
 * format (or requests resize, which implies qcow2).  qcow2 enables QEMU
 * snapshot/restore via `savevm`/`loadvm` monitor commands.
 *
 * Snapshot operations:
 *  - {@link parseSnapshotList} — parse QEMU monitor `info snapshots` text into {@link SnapshotInfo}[]
 *  - {@link listSnapshots} — get structured snapshot data from a qcow2 image via `qemu-img info`
 *  - {@link formatSnapshotTable} — render snapshot list as a human-readable ANSI table
 */

import { join } from "node:path";
import { existsSync, unlinkSync } from "node:fs";
import type { BootDiskFormat, SnapshotInfo } from "./types.ts";
import { QuickCHRError } from "./types.ts";
import { requireQemuImg } from "./platform.ts";

const DISK_SIZE_RE = /^\d+[KMGT]?$/i;

export interface DiskInfo {
	format: string;
	virtualSize: number;
	actualSize: number;
	filename: string;
}

/** True when a disk size string is valid for qemu-img (e.g. 512M, 1G, 2048). */
export function isValidDiskSize(size: string): boolean {
	return DISK_SIZE_RE.test(size.trim());
}

function normalizeDiskSize(size: string, label: string): string {
	const normalized = size.trim();
	if (!isValidDiskSize(normalized)) {
		throw new QuickCHRError(
			"INVALID_DISK_SIZE",
			`Invalid ${label}: ${JSON.stringify(size)}. Use values like 64M, 512M, 1G, or 2048.`,
		);
	}
	return normalized;
}

/** Normalize and validate disk-related options.
 *  If any disk feature is requested, also validates that qemu-img is present. */
export function normalizeDiskOptions(
	bootSize?: string,
	extraDisks?: string[],
 	bootDiskFormat?: BootDiskFormat,
): { bootSize?: string; extraDisks?: string[]; bootDiskFormat: BootDiskFormat } {
 	const format: BootDiskFormat = bootDiskFormat ?? (bootSize ? "qcow2" : "raw");

	if (format === "raw" && bootSize) {
		throw new QuickCHRError(
			"INVALID_DISK_SIZE",
			"Raw boot disks cannot be resized. Use bootDiskFormat=\"qcow2\" (or --boot-disk-format qcow2) to enable resizing.",
		);
	}

	if (format === "raw" && !bootSize && (!extraDisks || extraDisks.length === 0)) {
		return {
			bootSize: bootSize?.trim() || undefined,
			extraDisks,
			bootDiskFormat: format,
		};
	}

	requireQemuImg();

	return {
		bootSize: bootSize ? normalizeDiskSize(bootSize, "boot disk size") : undefined,
		extraDisks: extraDisks && extraDisks.length > 0
			? extraDisks.map((size, index) => normalizeDiskSize(size, `extra disk ${index + 1} size`))
			: undefined,
		bootDiskFormat: format,
	};
}

/** Create a blank qcow2 disk image. */
export async function createQcow2Disk(path: string, size: string): Promise<void> {
	const qemuImg = requireQemuImg();
	const proc = Bun.spawn([qemuImg, "create", "-f", "qcow2", path, size], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new QuickCHRError("PROCESS_FAILED", `qemu-img create failed: ${stderr.trim()}`);
	}
}

/** Convert a raw disk image to qcow2. */
export async function convertRawToQcow2(rawPath: string, qcow2Path: string): Promise<void> {
	const qemuImg = requireQemuImg();
	const proc = Bun.spawn([qemuImg, "convert", "-f", "raw", "-O", "qcow2", rawPath, qcow2Path], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new QuickCHRError("PROCESS_FAILED", `qemu-img convert failed: ${stderr.trim()}`);
	}
}

/** Resize a qcow2 disk image. */
export async function resizeQcow2(path: string, size: string): Promise<void> {
	const qemuImg = requireQemuImg();
	const proc = Bun.spawn([qemuImg, "resize", path, size], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new QuickCHRError("PROCESS_FAILED", `qemu-img resize failed: ${stderr.trim()}`);
	}
}

/** Get disk info via qemu-img info --output=json. */
export async function getDiskInfo(path: string): Promise<DiskInfo> {
	const qemuImg = requireQemuImg();
	const proc = Bun.spawn([qemuImg, "info", "--output=json", path], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new QuickCHRError("PROCESS_FAILED", `qemu-img info failed: ${stderr.trim()}`);
	}
	const stdout = await new Response(proc.stdout).text();
	const info = JSON.parse(stdout);
	return {
		format: info.format,
		virtualSize: info["virtual-size"],
		actualSize: info["actual-size"],
		filename: info.filename,
	};
}

/**
 * Prepare the boot disk for a machine.
 * If bootSize is specified, converts the raw disk.img to boot.qcow2 and resizes it.
 * Otherwise returns the raw disk.img as-is.
 */
export async function prepareBootDisk(
	machineDir: string,
	bootSize?: string,
	bootDiskFormat?: BootDiskFormat,
): Promise<{ path: string; format: BootDiskFormat }> {
	const format: BootDiskFormat = bootDiskFormat ?? (bootSize ? "qcow2" : "raw");
	const rawPath = join(machineDir, "disk.img");

	if (format === "raw") {
		return { path: rawPath, format: "raw" };
	}

	const qcow2Path = join(machineDir, "boot.qcow2");
	if (!existsSync(qcow2Path)) {
		await convertRawToQcow2(rawPath, qcow2Path);
	}
	if (bootSize) {
		await resizeQcow2(qcow2Path, bootSize);
	}
	return { path: qcow2Path, format: "qcow2" };
}

/**
 * Create extra blank qcow2 disks in the machine directory.
 * Named disk1.qcow2, disk2.qcow2, etc.
 */
export async function prepareExtraDisks(
	machineDir: string,
	sizes: string[],
): Promise<{ path: string; format: "qcow2" }[]> {
	const results: { path: string; format: "qcow2" }[] = [];
	for (let i = 0; i < sizes.length; i++) {
		const diskPath = join(machineDir, `disk${i + 1}.qcow2`);
		await createQcow2Disk(diskPath, sizes[i] as string);
		results.push({ path: diskPath, format: "qcow2" });
	}
	return results;
}

/** Ensure disk artifacts referenced by machine state exist on disk.
 *  Used both for new-machine creation and to heal older add()-created states
 *  that predate eager disk materialization. */
export async function ensureConfiguredDisks(
	machineDir: string,
	bootSize?: string,
	extraDiskSizes?: string[],
	bootDiskFormat?: BootDiskFormat,
): Promise<{
	bootDisk: { path: string; format: BootDiskFormat };
	extraDisks?: { path: string; format: "qcow2" }[];
}> {
	const format: BootDiskFormat = bootDiskFormat ?? (bootSize ? "qcow2" : "raw");
	const bootDisk = format === "raw"
		? { path: join(machineDir, "disk.img"), format: "raw" as const }
		: (existsSync(join(machineDir, "boot.qcow2"))
			? { path: join(machineDir, "boot.qcow2"), format: "qcow2" as const }
			: await prepareBootDisk(machineDir, bootSize, "qcow2"));

	let extraDisks: { path: string; format: "qcow2" }[] | undefined;
	if (extraDiskSizes && extraDiskSizes.length > 0) {
		extraDisks = [];
		for (let i = 0; i < extraDiskSizes.length; i++) {
			const diskPath = join(machineDir, `disk${i + 1}.qcow2`);
			if (!existsSync(diskPath)) {
				await createQcow2Disk(diskPath, extraDiskSizes[i] as string);
			}
			extraDisks.push({ path: diskPath, format: "qcow2" });
		}
	}

	return { bootDisk, extraDisks };
}

/**
 * Remove extra disk files from a machine directory.
 * Cleans up disk1.qcow2, disk2.qcow2, etc. and boot.qcow2 if present.
 */
export function cleanDiskFiles(machineDir: string): void {
	// Remove boot.qcow2
	const bootQcow2 = join(machineDir, "boot.qcow2");
	if (existsSync(bootQcow2)) {
		try { unlinkSync(bootQcow2); } catch { /* ignore */ }
	}
	// Remove extra disks (disk1.qcow2, disk2.qcow2, ...)
	for (let i = 1; i <= 64; i++) {
		const diskPath = join(machineDir, `disk${i}.qcow2`);
		if (!existsSync(diskPath)) break;
		try { unlinkSync(diskPath); } catch { /* ignore */ }
	}
}

// --- Snapshot operations ---

/**
 * Parse QEMU monitor `info snapshots` text output into structured data.
 *
 * The monitor returns lines like:
 * ```
 * ID        TAG               VM SIZE                DATE        VM CLOCK     ICOUNT
 * --        test              113 MiB 2026-04-14 00:47:19  0000:01:17.163         --
 * ```
 *
 * @param monitorOutput - Raw text from `instance.monitor("info snapshots")`
 * @returns Parsed snapshot list (empty array if no snapshots exist)
 */
export function parseSnapshotList(monitorOutput: string): SnapshotInfo[] {
	const lines = monitorOutput.split("\n");
	const snapshots: SnapshotInfo[] = [];

	for (const line of lines) {
		// Match snapshot data lines: ID, TAG, VM SIZE, DATE (YYYY-MM-DD HH:MM:SS), VM CLOCK, ICOUNT
		// Example: "--      test              113 MiB 2026-04-14 00:47:19  0000:01:17.163         --"
		// Example: "1       snap1             113 MiB 2026-04-14 00:47:19  0000:01:17.163         --"
		const match = line.match(
			/^\s*(\S+)\s+(\S+)\s+(\d+(?:\.\d+)?\s*(?:[KMGT]i?B|bytes?))\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+(\d{4}:\d{2}:\d{2}\.\d+)\s+(\S+)/i,
		);
		if (!match) continue;

		const [, id, name, vmSizeStr, dateStr, vmClock, icountStr] = match;
		if (!id || !name || !vmSizeStr || !dateStr || !vmClock) continue;

		snapshots.push({
			id: id === "--" ? "0" : id,
			name: name,
			vmStateSize: parseVmSize(vmSizeStr),
			date: dateStr.replace(" ", "T") + "Z",
			vmClock: vmClock,
			icount: icountStr === "--" ? undefined : Number(icountStr),
		});
	}

	return snapshots;
}

/** Parse a human-readable VM size string ("113 MiB", "2.1 GiB") to bytes. */
function parseVmSize(sizeStr: string): number {
	const match = sizeStr.match(/^([\d.]+)\s*([KMGT]i?B|bytes?)?$/i);
	if (!match) return 0;
	const value = Number.parseFloat(match[1] ?? "0");
	const unit = (match[2] ?? "").toLowerCase();
	const multipliers: Record<string, number> = {
		"": 1, "b": 1, "byte": 1, "bytes": 1,
		"kib": 1024, "kb": 1000,
		"mib": 1024 * 1024, "mb": 1000 * 1000,
		"gib": 1024 ** 3, "gb": 1000 ** 3,
		"tib": 1024 ** 4, "tb": 1000 ** 4,
	};
	return Math.round(value * (multipliers[unit] ?? 1));
}

/**
 * List snapshots stored in a qcow2 disk image using `qemu-img info`.
 *
 * Works on both running and stopped machines (reads the qcow2 metadata directly).
 * Returns an empty array for raw disks or images with no snapshots.
 *
 * @param diskPath - Path to the qcow2 disk image file
 * @returns Structured snapshot list with size information
 */
export async function listSnapshots(diskPath: string): Promise<SnapshotInfo[]> {
	const qemuImg = requireQemuImg();
	const proc = Bun.spawn([qemuImg, "info", "--output=json", "-U", diskPath], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		return [];
	}
	const stdout = await new Response(proc.stdout).text();
	try {
		const info = JSON.parse(stdout) as {
			snapshots?: Array<{
				id: string;
				name: string;
				"vm-state-size": number;
				"date-sec": number;
				"date-nsec": number;
				"vm-clock-sec": number;
				"vm-clock-nsec": number;
				"icount"?: number;
			}>;
		};
		if (!info.snapshots || info.snapshots.length === 0) return [];

		return info.snapshots.map((s) => {
			const date = new Date(s["date-sec"] * 1000);
			const clockSec = s["vm-clock-sec"];
			const hours = Math.floor(clockSec / 3600);
			const mins = Math.floor((clockSec % 3600) / 60);
			const secs = clockSec % 60;
			const ms = Math.floor(s["vm-clock-nsec"] / 1_000_000);

			return {
				id: s.id,
				name: s.name,
				vmStateSize: s["vm-state-size"],
				date: date.toISOString(),
				vmClock: `${String(hours).padStart(4, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(ms).padStart(3, "0")}`,
				icount: s.icount,
			};
		});
	} catch {
		return [];
	}
}

/** Format bytes as a compact human-readable size (e.g. "113 MiB", "2.1 GiB"). */
export function formatDiskSize(bytes: number): string {
	if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
	if (bytes >= 1024 ** 2) return `${(bytes / (1024 * 1024)).toFixed(0)} MiB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
	return `${bytes} B`;
}

/**
 * Format a snapshot list as a human-readable table string.
 *
 * Produces a compact table suitable for terminal display:
 * ```
 *   #  NAME           SIZE      DATE                 VM CLOCK
 *   1  baseline       113 MiB   2026-04-14 00:47     0001:17:00
 *   2  after-config   118 MiB   2026-04-14 01:02     0001:32:15
 * ```
 *
 * @param snapshots - Parsed snapshot list from {@link parseSnapshotList} or {@link listSnapshots}
 * @returns Formatted table string (no trailing newline), or "No snapshots." if empty
 */
export function formatSnapshotTable(snapshots: SnapshotInfo[]): string {
	if (snapshots.length === 0) return "No snapshots.";

	const headers = ["#", "NAME", "SIZE", "DATE", "VM CLOCK"];
	const rows = snapshots.map((s) => [
		s.id,
		s.name,
		formatDiskSize(s.vmStateSize),
		s.date.replace("T", " ").replace(/:\d{2}(?:\.\d+)?Z$/, "").replace("Z", ""),
		s.vmClock,
	]);

	const widths = headers.map((h, i) =>
		Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
	);

	const headerLine = headers.map((h, i) => h.padEnd(widths[i] ?? 0)).join("  ");
	const dataLines = rows.map((row) =>
		row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  "),
	);

	return [headerLine, ...dataLines].join("\n");
}
