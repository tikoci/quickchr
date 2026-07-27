/**
 * Platform detection — OS, arch, package manager, QEMU paths, firmware, acceleration.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import type { AccelMode, EfiFirmwarePaths, HostInterface, PackageManager, PlatformInfo, SocketVmnetInfo } from "./types.ts";
import { QuickCHRError as QError, parseAccelMode } from "./types.ts";
// settings-file.ts, not settings.ts: the latter's graph (cache → state → network
// → platform) is a cycle that would load eagerly on every CLI start.
import { loadSettingsFileDefaults } from "./settings-file.ts";

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
	// Windows (winget QEMU)
	`${process.env.PROGRAMFILES || "C:\\Program Files"}\\qemu\\share\\edk2-aarch64-code.fd`,
];

const EFI_VARS_PATHS = [
	"/opt/homebrew/share/qemu/edk2-arm-vars.fd",
	"/usr/local/share/qemu/edk2-arm-vars.fd",
	"/usr/share/AAVMF/AAVMF_VARS.fd",
	"/usr/share/edk2/aarch64/QEMU_VARS.fd",
	"/usr/share/edk2-armvirt/aarch64/vars-template-pflash.raw",
	"/usr/share/qemu-efi-aarch64/QEMU_VARS.fd",
	// Windows (winget QEMU)
	`${process.env.PROGRAMFILES || "C:\\Program Files"}\\qemu\\share\\edk2-arm-vars.fd`,
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

/** Whether guestArch differs from the physical host CPU architecture.
 *  Cross-arch TCG is significantly slower and needs more memory/timeout. */
export function isCrossArchEmulation(guestArch: "x86" | "arm64"): boolean {
	const hostIsArm64 = isAppleSiliconHost() || (process.platform !== "darwin" && process.arch === "arm64");
	return (guestArch === "arm64") !== hostIsArm64;
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
	// KVM/HVF on CI runners is often nested-KVM (VM-inside-VM) which can be
	// variably slower than bare-metal.  Use 1.5× to handle worst-case runner load.
	if (accel === "kvm" || accel === "hvf") return 1.5;
	// TCG: cross-arch is 15× slower (x86-on-arm64 especially), same-arch is 4×.
	return crossArch ? 15.0 : 4.0;
}

/**
 * Whether the physical host is Apple Silicon, including when quickchr itself
 * runs as an x64 process under Rosetta.
 *
 * Apple Silicon implements **no AArch32 at any exception level**: its
 * `ID_AA64PFR0_EL1` reports AArch64-only for EL0 and EL1, and HVF passes that
 * hardware register straight through to the guest (the `-cpu` model is inert
 * under HVF).  Current arm64 CHR images ship an AArch64 kernel over a *32-bit
 * ARM* userspace — the appended initramfs `/init` is `ELF 32-bit LSB ARM
 * EABI5`, and the system package holds 101 further ARM32 executables — so the
 * guest kernel never sets `ARM64_HAS_32BIT_EL0`, `execve("/init")` returns
 * -ENOEXEC, and Linux panics ~0.08 s in with "No working init found".
 * TCG's emulated CPU models do provide AArch32 EL0, so the same image boots.
 *
 * This is an image-artifact incompatibility, not an accelerator or CPU-model
 * bug: no QEMU flag and no macOS VMM can present a feature the silicon does not
 * implement.  See docs/m4-hvf-arm64-investigation.md and tikoci/quickchr#97.
 */
let appleSiliconHostMemo: boolean | undefined;

export function isAppleSiliconHost(): boolean {
	if (process.platform !== "darwin") return false;
	if (process.arch === "arm64") return true;
	if (process.arch !== "x64") return false;
	if (appleSiliconHostMemo !== undefined) return appleSiliconHostMemo;
	try {
		const result = Bun.spawnSync(["sysctl", "-n", "sysctl.proc_translated"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		appleSiliconHostMemo =
			result.exitCode === 0 &&
			new TextDecoder().decode(result.stdout).trim() === "1";
	} catch {
		appleSiliconHostMemo = false;
	}
	return appleSiliconHostMemo;
}

/** @internal Test-only: clear the memoized Rosetta probe between mocked runs. */
export function resetAppleSiliconHostCache(): void {
	appleSiliconHostMemo = undefined;
}

/**
 * Process-level accelerator override, set by `--accel` (CLI) or by a library
 * caller.  Highest tier of the documented precedence chain
 * (flag > QUICKCHR_ACCEL env > quickchr.env > built-in "auto"); `undefined`
 * means "not set, fall through to the settings tiers".
 */
let accelOverride: AccelMode | undefined;

/** Force the accelerator for the rest of this process, or clear with undefined. */
export function setAccelOverride(mode: AccelMode | undefined): void {
	accelOverride = mode;
}

/**
 * Resolve the accelerator override: process override > QUICKCHR_ACCEL env >
 * quickchr.env > "auto".  Mirrors settings.ts's `accel` key resolution (same
 * tiers, same validator) but reads the file tier directly to stay out of that
 * module's import cycle.  Throws INVALID_SETTING_VALUE on an unrecognized mode.
 */
export function resolveAccelOverride(): AccelMode {
	return resolveAccelOverrideWithSource().mode;
}

/** Which tier supplied the accelerator, for messages that must say *why*. */
export type AccelOverrideSource = "flag" | "env" | "file" | "default";

/**
 * As resolveAccelOverride(), but also reports the tier the value came from.
 * With three override tiers, "TCG because ~/.config/quickchr/quickchr.env says
 * so" and "TCG because you passed --accel" are very different support answers,
 * so the launch note names the source rather than guessing at it.
 */
export function resolveAccelOverrideWithSource(): { mode: AccelMode; source: AccelOverrideSource } {
	if (accelOverride !== undefined) return { mode: accelOverride, source: "flag" };
	const envRaw = process.env.QUICKCHR_ACCEL;
	if (envRaw !== undefined) return { mode: parseAccelMode(envRaw), source: "env" };
	const fileRaw = loadSettingsFileDefaults().QUICKCHR_ACCEL;
	if (fileRaw !== undefined) return { mode: parseAccelMode(fileRaw), source: "file" };
	return { mode: "auto", source: "default" };
}

/** Human-readable name of the override tier, for the launch note. */
function accelSourceLabel(source: AccelOverrideSource): string {
	if (source === "flag") return "--accel";
	if (source === "env") return "QUICKCHR_ACCEL";
	return "the 'accel' setting in quickchr.env";
}

/**
 * One-line note about how the accelerator was chosen, or null when there is
 * nothing worth saying.  Surfaced at launch so a user on slow emulation — or
 * one who forced a mode that is known not to boot — understands why.
 */
export function accelNote(guestArch: "x86" | "arm64", accel: string): string | null {
	const { mode: forced, source } = resolveAccelOverrideWithSource();
	if (forced !== "auto") {
		const base = `Accelerator configured as "${forced}" via ${accelSourceLabel(source)} — auto-detection bypassed.`;
		if (guestArch === "arm64" && forced === "hvf" && isAppleSiliconHost()) {
			return `${base} Note: arm64 CHR images still ship a 32-bit ARM userspace, which Apple Silicon cannot execute under HVF — expect "No working init found" unless MikroTik has shipped an AArch64-only image (tikoci/quickchr#97).`;
		}
		return base;
	}
	if (guestArch !== "arm64" || accel !== "tcg" || !isAppleSiliconHost()) return null;
	return (
		"arm64 CHR is running under TCG on Apple Silicon: the image's appended " +
		"initramfs /init and most of its system package are 32-bit ARM, and Apple " +
		"CPUs implement no AArch32 at any exception level, so an HVF guest panics " +
		'with "No working init found". TCG is slower but boots. Override with ' +
		"--accel hvf once MikroTik ships an AArch64-only arm64 image (tikoci/quickchr#97)."
	);
}

/** Detect available QEMU acceleration for a guest architecture. */
export async function detectAccel(guestArch: "x86" | "arm64"): Promise<string> {
	const forced = resolveAccelOverride();
	if (forced !== "auto") return forced;

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
		// Apple Hypervisor Framework only runs guests matching the physical host
		// architecture. Rosetta can translate the quickchr process, but it cannot
		// make x86 HVF guests run on Apple Silicon.
		const appleSilicon = isAppleSiliconHost();
		try {
			const hvResult = Bun.spawnSync(["sysctl", "-n", "kern.hv_support"], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const hv = new TextDecoder().decode(hvResult.stdout).trim();
			if (hv === "1") {
				if (guestArch === "x86" && !appleSilicon) return "hvf";
				// arm64 guest: falls through to TCG on every macOS host.
				//
				// On Intel Macs process.arch is "x64" and arm64 HVF is impossible.
				// On Apple Silicon HVF *is* available but must not be used: no Apple
				// CPU implements AArch32 at any exception level, and current arm64 CHR
				// images require a 32-bit ARM userspace, so an HVF guest panics at init
				// (see isAppleSiliconHost()).  arm64 TCG still boots, but is slower.
				//
				// Restore signal (#97) is the *guest artifact*, not the host or QEMU
				// version: a future arm64 CHR whose appended /init and system-package
				// executables are all AArch64, verified by a real HVF boot.  Until then
				// `--accel hvf` / QUICKCHR_ACCEL=hvf is the escape hatch for testing.
				//
				// x86 guests also fall through on Apple Silicon because HVF cannot
				// virtualize across architectures; their escape hatch is the same.
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
			return "winget install SoftwareFreedomConservancy.QEMU";
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
