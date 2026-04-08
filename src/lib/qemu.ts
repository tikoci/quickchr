/**
 * QEMU argument builder and process lifecycle management.
 *
 * Builds QEMU command-line arguments for x86_64 and aarch64 CHR,
 * manages process spawn/stop, and handles PID tracking.
 */

import { existsSync, writeFileSync, readFileSync, copyFileSync, statSync, openSync, closeSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Arch, MachineState, NetworkMode, PortMapping } from "./types.ts";
import { QuickCHRError } from "./types.ts";
import { detectAccel, requireQemu, requireFirmware } from "./platform.ts";
import { buildHostfwdString } from "./network.ts";
import { ensureDir } from "./state.ts";

export interface QemuLaunchConfig {
	arch: Arch;
	machineDir: string;
	diskPath: string;
	mem: number;
	cpu: number;
	ports: Record<string, PortMapping>;
	network: NetworkMode;
	background: boolean;
}

/** Build the full QEMU command-line arguments array. */
export async function buildQemuArgs(config: QemuLaunchConfig): Promise<string[]> {
	const { arch, machineDir, diskPath, mem, cpu, ports, network, background } = config;

	const qemuBin = requireQemu(arch);
	const accel = await detectAccel(arch);
	const args: string[] = [qemuBin];

	// Machine type
	if (arch === "x86") {
		args.push("-M", "pc");
	} else {
		args.push("-M", "virt");
	}

	// CPU and memory
	args.push("-m", String(mem), "-smp", String(cpu));

	// Acceleration
	if (accel === "tcg") {
		args.push("-accel", "tcg,tb-size=256");
	} else {
		args.push("-accel", accel);
	}

	// CPU model (arm64 only — HVF needs -cpu host)
	if (arch === "arm64") {
		if (accel === "hvf") {
			args.push("-cpu", "host");
		} else {
			args.push("-cpu", "cortex-a710");
		}
	}

	// UEFI firmware (arm64 only)
	if (arch === "arm64") {
		const fw = requireFirmware();
		const varsPath = join(machineDir, "efi-vars.fd");

		// Copy and size-match the vars file if not already done
		if (!existsSync(varsPath)) {
			prepareEfiVars(fw.code, fw.vars, varsPath);
		}

		args.push(
			"-drive", `if=pflash,format=raw,readonly=on,unit=0,file=${fw.code}`,
			"-drive", `if=pflash,format=raw,unit=1,file=${varsPath}`,
		);
	}

	// Disk drive
	if (arch === "arm64") {
		// ARM64: MUST use explicit virtio-blk-pci (not if=virtio which maps to MMIO)
		args.push(
			"-drive", `file=${diskPath},format=raw,if=none,id=drive0`,
			"-device", "virtio-blk-pci,drive=drive0",
		);
	} else {
		// x86: if=virtio is fine (maps to PCI on q35/pc)
		args.push("-drive", `file=${diskPath},format=raw,if=virtio`);
	}

	// Networking
	buildNetworkArgs(args, ports, network);

	// Display
	args.push("-display", "none");

	// Serial, monitor, QGA channels
	buildChannelArgs(args, arch, machineDir, background);

	return args;
}

/** Build networking arguments. */
function buildNetworkArgs(
	args: string[],
	ports: Record<string, PortMapping>,
	network: NetworkMode,
): void {
	if (network === "vmnet-shared") {
		args.push(
			"-netdev", "vmnet-shared,id=net0",
			"-device", "virtio-net-pci,netdev=net0",
		);
	} else if (typeof network === "object" && network.type === "vmnet-bridge") {
		args.push(
			"-netdev", `vmnet-bridged,id=net0,ifname=${network.iface}`,
			"-device", "virtio-net-pci,netdev=net0",
			// Also add a shared interface for management access
			"-netdev", "vmnet-shared,id=net1",
			"-device", "virtio-net-pci,netdev=net1",
		);
	} else {
		// User-mode networking with port forwarding
		const hostfwd = buildHostfwdString(ports);
		args.push(
			"-netdev", `user,id=net0${hostfwd ? "," + hostfwd : ""}`,
			"-device", "virtio-net-pci,netdev=net0",
		);
	}
}

/** Build serial/monitor/QGA channel arguments. */
function buildChannelArgs(
	args: string[],
	arch: Arch,
	machineDir: string,
	background: boolean,
): void {
	const monitorSock = join(machineDir, "monitor.sock");
	const serialSock = join(machineDir, "serial.sock");
	const qgaSock = join(machineDir, "qga.sock");

	if (background) {
		// Background: all channels on Unix sockets
		args.push(
			"-chardev", `socket,id=monitor0,path=${monitorSock},server=on,wait=off`,
			"-mon", "chardev=monitor0,mode=readline",
			"-chardev", `socket,id=serial0,path=${serialSock},server=on,wait=off`,
			"-serial", "chardev:serial0",
		);
	} else {
		// Foreground: serial on stdio with mux (Ctrl-A C for monitor).
		// Also bind a socket monitor so monitorCommand() works while in fg mode.
		args.push(
			"-chardev", "stdio,id=serial0,mux=on,signal=off",
			"-mon", "chardev=serial0,mode=readline",
			"-serial", "chardev:serial0",
			"-chardev", `socket,id=monitor0,path=${monitorSock},server=on,wait=off`,
			"-mon", "chardev=monitor0,mode=readline",
		);
	}

	// QGA — x86 only (arm64 has a bug where the userspace daemon doesn't start)
	if (arch === "x86") {
		args.push(
			"-device", "virtio-serial-pci,id=virtio-serial-qga",
			"-chardev", `socket,id=qga0,path=${qgaSock},server=on,wait=off`,
			"-device", "virtserialport,chardev=qga0,name=org.qemu.guest_agent.0,id=qga-port0",
		);
	}
}

/** Copy and size-match EFI vars file to match code ROM size. */
function prepareEfiVars(codePath: string, varsTemplatePath: string, destPath: string): void {
	ensureDir(join(destPath, ".."));
	copyFileSync(varsTemplatePath, destPath);

	// pflash units must be identical size — pad/truncate vars to match code
	const codeSize = statSync(codePath).size;
	const varsSize = statSync(destPath).size;

	if (varsSize !== codeSize) {
		// Use dd to truncate/pad to exact size
		const result = Bun.spawnSync(
			["dd", "if=/dev/zero", `of=${destPath}`, "bs=1", `count=0`, `seek=${codeSize}`],
			{ stdout: "pipe", stderr: "pipe" },
		);
		if (result.exitCode !== 0) {
			throw new QuickCHRError(
				"PROCESS_FAILED",
				`Failed to size-match EFI vars: ${new TextDecoder().decode(result.stderr)}`,
			);
		}
	}
}

/** Parse QEMU log output and produce a human-friendly error message. */
export function buildQemuErrorMessage(log: string): string {
	if (log.includes("Permission denied")) {
		return `QEMU exited immediately (permission denied — check image file permissions):\n${log}`;
	}
	if (log.includes("pflash") || (log.includes("EFI") && log.includes("size"))) {
		return `QEMU exited immediately (EFI firmware size mismatch — try 'quickchr clean <name>' to reset):\n${log}`;
	}
	if (log.includes("Address already in use")) {
		return `QEMU exited immediately (port already in use — another process may be using the same ports):\n${log}`;
	}
	return `QEMU exited immediately:\n${log}`;
}

/** Spawn QEMU process. Returns the process or PID. */
export async function spawnQemu(
	qemuArgs: string[],
	machineDir: string,
	background: boolean,
): Promise<{ pid: number; process?: ReturnType<typeof Bun.spawn> }> {
	ensureDir(machineDir);

	const logPath = join(machineDir, "qemu.log");
	const pidPath = join(machineDir, "qemu.pid");

	const [bin, ...args] = qemuArgs;

	if (!bin) throw new QuickCHRError("SPAWN_FAILED", "Empty QEMU args");

	if (background) {
		// Open log file as an fd — more reliable than BunFile for subprocess stdio.
		// After spawn, close parent's copy; child process inherits its own copy.
		const logFd = openSync(logPath, "a");
		const proc = Bun.spawn([bin, ...args], {
			stdout: logFd,
			stderr: logFd,
			stdin: "ignore",
		});
		closeSync(logFd);

		// Give QEMU 1.5 s to fully initialise — if it exits immediately the
		// arguments were bad (e.g. port already in use). Detect this early so
		// the caller gets a clear error instead of a 120-second waitForBoot.
		await Bun.sleep(1500);
		try {
			process.kill(proc.pid, 0);
		} catch {
			let logTail = "(no log)";
			try {
				if (existsSync(logPath)) {
					logTail = readFileSync(logPath, "utf-8").slice(-800);
				}
			} catch { /* ignore */ }
			throw new QuickCHRError("SPAWN_FAILED", buildQemuErrorMessage(logTail));
		}

		// unref() lets the parent Bun process exit without waiting for QEMU.
		// QEMU becomes an orphan adopted by init/launchd and keeps running.
		proc.unref();

		writeFileSync(pidPath, String(proc.pid));
		return { pid: proc.pid };
	}

	// Foreground — stdin/stdout connected to terminal. Blocks until QEMU exits.
	const proc = Bun.spawn([bin, ...args], {
		stdout: "inherit",
		stderr: "inherit",
		stdin: "inherit",
	});

	const pid = proc.pid;
	writeFileSync(pidPath, String(pid));
	await proc.exited;
	try { unlinkSync(pidPath); } catch { /* ignore */ }
	return { pid };
}

/** Stop a QEMU process by PID. Tries SIGTERM first, then SIGKILL. */
export async function stopQemu(pid: number): Promise<boolean> {
	try {
		process.kill(pid, 0); // Check if alive
	} catch {
		return false; // Already dead
	}

	// Try graceful shutdown
	process.kill(pid, "SIGTERM");

	// Wait up to 5s for graceful exit
	for (let i = 0; i < 50; i++) {
		await Bun.sleep(100);
		try {
			process.kill(pid, 0);
		} catch {
			return true; // Exited
		}
	}

	// Force kill
	try {
		process.kill(pid, "SIGKILL");
	} catch { /* already dead */ }

	return true;
}

/** Stop a machine by name. */
export async function stopMachineByName(_name: string, state: MachineState): Promise<boolean> {
	if (!state.pid) return false;
	const stopped = await stopQemu(state.pid);

	// Clean up socket files
	const machineDir = state.machineDir;
	for (const sock of ["monitor.sock", "serial.sock", "qga.sock"]) {
		const path = join(machineDir, sock);
		try {
			if (existsSync(path)) {
				const { unlinkSync } = await import("node:fs");
				unlinkSync(path);
			}
		} catch { /* ignore */ }
	}

	return stopped;
}

/** Wait for RouterOS to boot by polling HTTP health check.
 * Accepts any HTTP response as "booted" — 401/403 (auth required) means
 * the server is up; connection errors mean it is still starting. */
export async function waitForBoot(
	httpPort: number,
	timeoutMs: number = 120_000,
): Promise<boolean> {
	const url = `http://127.0.0.1:${httpPort}/`;
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		try {
			const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
			// Any HTTP response (including 401 Unauthorized, 403 Forbidden) means
			// RouterOS is up. Connection refused / timeout means still booting.
			if (r.status > 0) return true;
		} catch { /* not ready yet */ }
		await Bun.sleep(2000);
	}

	return false;
}
