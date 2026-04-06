/**
 * Platform detection — OS, arch, package manager, QEMU paths, firmware, acceleration.
 */

import { existsSync } from "node:fs";
import type { EfiFirmwarePaths, PackageManager, PlatformInfo, } from "./types.ts";
import { QuickCHRError as QError } from "./types.ts";

/** UEFI firmware search paths by platform. */
const EFI_CODE_PATHS = [
	// macOS Homebrew (Apple Silicon)
	"/opt/homebrew/share/qemu/edk2-aarch64-code.fd",
	// macOS Homebrew (Intel)
	"/usr/local/share/qemu/edk2-aarch64-code.fd",
	// Ubuntu/Debian
	"/usr/share/AAVMF/AAVMF_CODE.fd",
	// RHEL/Fedora
	"/usr/share/edk2/aarch64/QEMU_EFI.fd",
	// Arch
	"/usr/share/edk2-armvirt/aarch64/QEMU_EFI.fd",
	// Generic
	"/usr/share/qemu-efi-aarch64/QEMU_EFI.fd",
];

const EFI_VARS_PATHS = [
	"/opt/homebrew/share/qemu/edk2-arm-vars.fd",
	"/usr/local/share/qemu/edk2-arm-vars.fd",
	"/usr/share/AAVMF/AAVMF_VARS.fd",
	"/usr/share/edk2/aarch64/QEMU_VARS.fd",
	"/usr/share/edk2-armvirt/aarch64/vars-template-pflash.raw",
	"/usr/share/qemu-efi-aarch64/QEMU_VARS.fd",
];

/** Detect the system package manager. */
export function detectPackageManager(): PackageManager {
	const os = process.platform;
	if (os === "darwin") return "brew";
	if (os === "win32") return "winget";
	if (os === "linux") {
		// Check for common package managers
		if (commandExists("apt")) return "apt";
		if (commandExists("dnf")) return "dnf";
		if (commandExists("pacman")) return "pacman";
	}
	return "unknown";
}

/** Check if a command exists on PATH. */
function commandExists(cmd: string): boolean {
	try {
		const result = Bun.spawnSync(["which", cmd], { stdout: "pipe", stderr: "pipe" });
		return result.exitCode === 0;
	} catch {
		return false;
	}
}

/** Resolve the QEMU binary path for a given guest architecture. */
export function findQemuBinary(guestArch: "x86" | "arm64"): string | undefined {
	const bin = guestArch === "x86" ? "qemu-system-x86_64" : "qemu-system-aarch64";

	// Check PATH
	const result = Bun.spawnSync(["which", bin], { stdout: "pipe", stderr: "pipe" });
	if (result.exitCode === 0) {
		return new TextDecoder().decode(result.stdout).trim();
	}

	// Windows: check common install location
	if (process.platform === "win32") {
		const winPath = `C:\\Program Files\\qemu\\${bin}.exe`;
		if (existsSync(winPath)) return winPath;
	}

	return undefined;
}

/** Find UEFI firmware files for aarch64. */
export function findEfiFirmware(): EfiFirmwarePaths | undefined {
	const code = EFI_CODE_PATHS.find((p) => existsSync(p));
	const vars = EFI_VARS_PATHS.find((p) => existsSync(p));
	if (code && vars) return { code, vars };
	return undefined;
}

/** Detect available QEMU acceleration for a guest architecture. */
export async function detectAccel(guestArch: "x86" | "arm64"): Promise<string> {
	const hostOs = process.platform;
	const hostArch = process.arch; // "x64" | "arm64"

	if (hostOs === "linux") {
		// KVM requires matching host/guest architecture.
		const archMatch =
			(guestArch === "x86" && hostArch === "x64") ||
			(guestArch === "arm64" && hostArch === "arm64");
		if (archMatch) {
			try {
				const stat = Bun.spawnSync(["test", "-w", "/dev/kvm"], { stdout: "pipe", stderr: "pipe" });
				if (stat.exitCode === 0) return "kvm";
			} catch { /* fall through */ }
		}
	}

	if (hostOs === "darwin") {
		// Apple Hypervisor Framework (HVF) is a system capability, not a per-process one.
		// It is available if kern.hv_support=1, regardless of whether the bun process
		// itself is arm64 native or running via Rosetta (process.arch="x64").
		try {
			const hvResult = Bun.spawnSync(["sysctl", "-n", "kern.hv_support"], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const hv = new TextDecoder().decode(hvResult.stdout).trim();
			if (hv === "1") {
				if (guestArch === "x86") return "hvf";
				// arm64 guest HVF is only available on Apple Silicon.
				// Check hw.optional.arm64 — present and set to 1 on M-series, absent on Intel.
				const armResult = Bun.spawnSync(["sysctl", "-n", "hw.optional.arm64"], {
					stdout: "pipe",
					stderr: "pipe",
				});
				const isAppleSilicon = new TextDecoder().decode(armResult.stdout).trim() === "1";
				if (isAppleSilicon) return "hvf";
			}
		} catch { /* fall through */ }
	}

	return "tcg";
}

/** Detect all available accelerators for both architectures. */
async function detectAllAccel(): Promise<string[]> {
	const accels = new Set<string>();
	for (const arch of ["x86", "arm64"] as const) {
		const accel = await detectAccel(arch);
		accels.add(accel);
	}
	return [...accels];
}

/** Get install command for QEMU on the current platform. */
export function getQemuInstallHint(pkgMgr?: PackageManager): string {
	const mgr = pkgMgr ?? detectPackageManager();
	switch (mgr) {
		case "brew":
			return "brew install qemu";
		case "apt":
			return "sudo apt install qemu-system-x86 qemu-system-arm qemu-efi-aarch64";
		case "dnf":
			return "sudo dnf install qemu-kvm qemu-system-aarch64 edk2-aarch64";
		case "pacman":
			return "sudo pacman -S qemu-full";
		case "winget":
			return "winget install QEMU.QEMU";
		default:
			return "Install QEMU (qemu-system-x86_64 and/or qemu-system-aarch64)";
	}
}

/** Get QEMU version string. */
export function getQemuVersion(binaryPath: string): string | undefined {
	try {
		const result = Bun.spawnSync([binaryPath, "--version"], { stdout: "pipe", stderr: "pipe" });
		if (result.exitCode === 0) {
			const output = new TextDecoder().decode(result.stdout);
			const match = output.match(/version\s+([\d.]+)/);
			return match?.[1];
		}
	} catch { /* not available */ }
	return undefined;
}

/** Gather full platform information. */
export async function detectPlatform(): Promise<PlatformInfo> {
	const os = process.platform as "darwin" | "linux" | "win32";
	const hostArch = process.arch as "x64" | "arm64";
	const packageManager = detectPackageManager();

	const qemuBinX86 = findQemuBinary("x86");
	const qemuBinArm64 = findQemuBinary("arm64");
	const efiFirmware = findEfiFirmware();
	const accelAvailable = await detectAllAccel();

	return {
		os,
		hostArch,
		packageManager,
		qemuBinX86,
		qemuBinArm64,
		efiFirmware,
		accelAvailable,
	};
}

/** Validate that the required QEMU binary is available for the given architecture. */
export function requireQemu(arch: "x86" | "arm64"): string {
	const bin = findQemuBinary(arch);
	if (!bin) {
		throw new QError(
			"MISSING_QEMU",
			`qemu-system-${arch === "x86" ? "x86_64" : "aarch64"} not found`,
			getQemuInstallHint(),
		);
	}
	return bin;
}

/** Validate that UEFI firmware is available (required for arm64). */
export function requireFirmware(): EfiFirmwarePaths {
	const fw = findEfiFirmware();
	if (!fw) {
		throw new QError(
			"MISSING_FIRMWARE",
			"UEFI firmware for aarch64 not found",
			getQemuInstallHint(),
		);
	}
	return fw;
}
