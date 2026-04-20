/**
 * Platform detection — OS, arch, package manager, QEMU paths, firmware, acceleration.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import type { EfiFirmwarePaths, HostInterface, PackageManager, PlatformInfo, SocketVmnetInfo } from "./types.ts";
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

/** Find a command on PATH. Uses `where.exe` on Windows and `which` elsewhere. */
export function findCommandOnPath(cmd: string): string | undefined {
	try {
		const probe = process.platform === "win32" ? ["where.exe", cmd] : ["which", cmd];
		const result = Bun.spawnSync(probe, { stdout: "pipe", stderr: "pipe" });
		if (result.exitCode !== 0) return undefined;
		const output = new TextDecoder().decode(result.stdout).trim();
		const firstLine = output.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
		return firstLine || undefined;
	} catch {
		return undefined;
	}
}

/** Check if a command exists on PATH. */
function commandExists(cmd: string): boolean {
	return findCommandOnPath(cmd) !== undefined;
}

/** Resolve the QEMU binary path for a given guest architecture. */
export function findQemuBinary(guestArch: "x86" | "arm64"): string | undefined {
	const bin = guestArch === "x86" ? "qemu-system-x86_64" : "qemu-system-aarch64";

	// Check PATH
	const pathBin = findCommandOnPath(bin);
	if (pathBin) return pathBin;

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

/**
 * Returns a warning string when QGA is attempted on a non-KVM platform, or null on Linux.
 *
 * RouterOS CHR only starts its guest agent daemon under KVM hypervisors. Under macOS (HVF)
 * or Windows, the QGA port is presented correctly by QEMU but the guest never opens it.
 * Linux with /dev/kvm is the confirmed working environment. If MikroTik changes this
 * behaviour in a future build, remove this warning.
 */
export function qgaKvmWarning(): string | null {
	if (process.platform === "linux") return null;
	const plat = process.platform === "darwin" ? "macOS (HVF)" : "Windows";
	return (
		`QGA requires KVM — RouterOS guest agent only starts under KVM hypervisors. ` +
		`On ${plat} it will likely time out. ` +
		`Attempting anyway — remove this warning if a future RouterOS build changes behaviour.`
	);
}

/** Whether guestArch requires cross-architecture emulation (TCG) on this host.
 *  Cross-arch emulation is significantly slower and needs more memory/timeout.
 *  arm64 guest on x86_64 host → TCG (slow).
 *  x86 guest on any host → HVF or KVM when available (fast). */
export function isCrossArchEmulation(guestArch: "x86" | "arm64"): boolean {
	// x86 CHR is always runnable under HVF/KVM or TCG — never "slow" cross-arch.
	// arm64 CHR on an arm64 host uses HVF/KVM; on an x86_64 host it falls back to TCG.
	return guestArch === "arm64" && process.arch !== "arm64";
}

/**
 * Timeout scaling factor for QEMU acceleration mode.
 *
 * KVM and HVF are near-native; TCG is software emulation and may be 4–15×
 * slower depending on whether the emulated guest architecture matches the host.
 *
 * @param accel  Output of detectAccel() for the guest arch.
 * @param crossArch  True when host and guest architectures differ.
 */
export function accelTimeoutFactor(accel: string, crossArch: boolean): number {
	if (accel === "kvm" || accel === "hvf") return 1.0;
	// TCG: cross-arch is 15× slower (x86-on-arm64 especially), same-arch is 4×.
	return crossArch ? 15.0 : 4.0;
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
				// arm64 guest HVF requires a native arm64 host process.
				// Use process.arch — on Intel Macs this is "x64" so arm64 guests get TCG,
				// which is correct (Intel can't run arm64 HVF). On Apple Silicon, native
				// bun reports "arm64" and gets HVF. Rosetta bun reports "x64" and gets TCG
				// (acceptable — arm64 TCG on Apple Silicon still boots in <5 min).
				if (process.arch === "arm64") return "hvf";
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
			return "sudo apt install qemu-system-x86 qemu-system-arm qemu-efi-aarch64 qemu-utils";
		case "dnf":
			return "sudo dnf install qemu-kvm qemu-system-aarch64 edk2-aarch64 qemu-img";
		case "pacman":
			return "sudo pacman -S qemu-full";
		case "winget":
			return "winget install QEMU.QEMU";
		default:
			return "Install QEMU (including qemu-system-* and qemu-img)";
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

/** Socket search directories for socket_vmnet daemons. */
const SOCKET_VMNET_SOCKET_DIRS = [
	"/usr/local/var/run",
	"/opt/homebrew/var/run",
	"/var/run",
];

/** Candidate paths for socket_vmnet_client binary. */
const SOCKET_VMNET_CLIENT_PATHS = [
	"/opt/homebrew/opt/socket_vmnet/bin/socket_vmnet_client",
	"/usr/local/opt/socket_vmnet/bin/socket_vmnet_client",
];

function isSocket(path: string): boolean {
	try {
		return statSync(path).isSocket();
	} catch {
		return false;
	}
}

/** Check if a socket_vmnet daemon socket is accessible (file exists and is a socket). */
export function isSocketVmnetDaemonRunning(socketPath: string): boolean {
	if (!existsSync(socketPath) || !isSocket(socketPath)) return false;
	// Socket file persists on disk after the daemon stops. Verify the process is alive.
	const result = Bun.spawnSync(["pgrep", "socket_vmnet"], { stdout: "pipe", stderr: "pipe" });
	return result.exitCode === 0;
}

/** Detect socket_vmnet installation and running daemons (macOS only). */
export function detectSocketVmnet(): SocketVmnetInfo | undefined {
	if (process.platform !== "darwin") return undefined;

	const client =
		SOCKET_VMNET_CLIENT_PATHS.find((p) => existsSync(p)) ??
		findCommandOnPath("socket_vmnet_client");
	if (!client) return undefined;

	let sharedSocket: string | undefined;
	const bridgedSockets: Record<string, string> = {};

	for (const dir of SOCKET_VMNET_SOCKET_DIRS) {
		if (!existsSync(dir)) continue;

		const sharedPath = `${dir}/socket_vmnet`;
		if (!sharedSocket && isSocket(sharedPath)) {
			sharedSocket = sharedPath;
		}

		try {
			for (const entry of readdirSync(dir)) {
				const match = entry.match(/^socket_vmnet\.bridged\.(.+)$/);
				if (!match) continue;
				const fullPath = `${dir}/${entry}`;
				if (isSocket(fullPath) && match[1]) {
					const iface = match[1];
					if (!(iface in bridgedSockets)) {
						bridgedSockets[iface] = fullPath;
					}
				}
			}
		} catch {
			// directory not readable
		}
	}

	return { client, sharedSocket, bridgedSockets };
}

/** Gather full platform information. */
export async function detectPlatform(): Promise<PlatformInfo> {
	const os = process.platform as "darwin" | "linux" | "win32";
	const hostArch = process.arch as "x64" | "arm64";
	const packageManager = detectPackageManager();

	const qemuBinX86 = findQemuBinary("x86");
	const qemuBinArm64 = findQemuBinary("arm64");
	const qemuImg = findQemuImg();
	const efiFirmware = findEfiFirmware();
	const accelAvailable = await detectAllAccel();
	const socketVmnet = detectSocketVmnet();

	return {
		os,
		hostArch,
		packageManager,
		qemuBinX86,
		qemuBinArm64,
		qemuImg,
		efiFirmware,
		accelAvailable,
		socketVmnet,
	};
}

/** Resolve the qemu-img binary path. */
export function findQemuImg(): string | undefined {
	const pathBin = findCommandOnPath("qemu-img");
	if (pathBin) return pathBin;

	// Windows: check common install location
	if (process.platform === "win32") {
		const winPath = "C:\\Program Files\\qemu\\qemu-img.exe";
		if (existsSync(winPath)) return winPath;
	}

	return undefined;
}

/** Validate that qemu-img is available; throws MISSING_QEMU if not found. */
export function requireQemuImg(): string {
	const bin = findQemuImg();
	if (!bin) {
		throw new QError(
			"MISSING_QEMU",
			"qemu-img not found (required for disk operations)",
			getQemuInstallHint(),
		);
	}
	return bin;
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

const VIRTUAL_PORT_PATTERNS = [
	"bluetooth pan",
	"thunderbolt bridge",
	"vpn",
	"multipass",
];

/** Detect physical network interfaces on the host. macOS only (Linux/Windows return []). */
export function detectPhysicalInterfaces(): HostInterface[] {
	if (process.platform !== "darwin") return [];

	const result = Bun.spawnSync(["networksetup", "-listallhardwareports"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) return [];

	const output = new TextDecoder().decode(result.stdout);
	const blocks = output.split(/\n\n+/).filter(Boolean);
	const interfaces: HostInterface[] = [];
	let assignedWifi = false;
	let assignedEthernet = false;

	for (const block of blocks) {
		const portMatch = block.match(/^Hardware Port:\s*(.+)$/m);
		const deviceMatch = block.match(/^Device:\s*(\S+)$/m);
		const macMatch = block.match(/^Ethernet Address:\s*(\S+)$/m);

		if (!portMatch || !deviceMatch) continue;

		const name = (portMatch[1] ?? "").trim();
		const device = (deviceMatch[1] ?? "").trim();
		const mac = macMatch?.[1]?.trim();

		const nameLower = name.toLowerCase();
		if (VIRTUAL_PORT_PATTERNS.some((p) => nameLower.includes(p))) continue;

		let alias: "wifi" | "ethernet" | undefined;
		if (!assignedWifi && nameLower === "wi-fi") {
			alias = "wifi";
			assignedWifi = true;
		} else if (
			!assignedEthernet &&
			(nameLower === "ethernet" || nameLower === "usb ethernet")
		) {
			alias = "ethernet";
			assignedEthernet = true;
		}

		interfaces.push({ device, name, mac: mac !== "(null)" ? mac : undefined, alias });
	}

	return interfaces;
}

const KNOWN_ALIASES = new Set(["wifi", "ethernet", "auto"]);

/** Resolve a convenience alias ("wifi", "ethernet", "auto") to a device name. */
export function resolveInterfaceAlias(
	alias: string,
	interfaces?: HostInterface[],
): string {
	if (!KNOWN_ALIASES.has(alias)) return alias;

	const ifaces = interfaces ?? detectPhysicalInterfaces();

	if (alias === "auto") {
		const eth = ifaces.find((i) => i.alias === "ethernet");
		if (eth) return eth.device;
		const wifi = ifaces.find((i) => i.alias === "wifi");
		if (wifi) return wifi.device;
		throw new QError(
			"NETWORK_UNAVAILABLE",
			"No physical network interface found for 'auto' — no ethernet or wifi detected",
		);
	}

	const match = ifaces.find((i) => i.alias === alias);
	if (match) return match.device;

	throw new QError(
		"NETWORK_UNAVAILABLE",
		`No interface found for alias '${alias}' — run 'quickchr doctor' to see available interfaces`,
	);
}
