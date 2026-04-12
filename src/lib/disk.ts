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

export interface DiskInfo {
	format: string;
	virtualSize: number;
	actualSize: number;
	filename: string;
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
): Promise<{ path: string; format: BootDiskFormat }> {
	const rawPath = join(machineDir, "disk.img");

	if (!bootSize) {
		return { path: rawPath, format: "raw" };
	}

	const qcow2Path = join(machineDir, "boot.qcow2");
	await convertRawToQcow2(rawPath, qcow2Path);
	await resizeQcow2(qcow2Path, bootSize);
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
