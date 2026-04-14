/**
 * Disk management — qemu-img wrapper for boot disk resizing and extra disk creation.
 *
 * All extra disks are qcow2.  Boot disk stays raw unless resized, at which point
 * it is converted to qcow2.  This module deliberately uses qcow2 to anticipate
 * future snapshot/restore support without implementing it now.
 */

import { join } from "node:path";
import { existsSync, unlinkSync } from "node:fs";
import type { BootDiskFormat } from "./types.ts";
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
