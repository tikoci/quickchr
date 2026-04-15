/**
 * QEMU argument builder and process lifecycle management.
 *
 * Builds QEMU command-line arguments for x86_64 and aarch64 CHR,
 * manages process spawn/stop, and handles PID tracking.
 */

import { existsSync, writeFileSync, readFileSync, copyFileSync, statSync, openSync, closeSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Arch, BootDiskFormat, MachineState, NetworkMode, NetworkConfig, PortMapping } from "./types.ts";
import { QuickCHRError } from "./types.ts";
import { detectAccel, requireQemu, requireFirmware } from "./platform.ts";
import { buildHostfwdString } from "./network.ts";
import { ensureDir } from "./state.ts";

export interface QemuLaunchConfig {
	arch: Arch;
	machineDir: string;
	bootDisk: { path: string; format: BootDiskFormat };
	extraDisks?: { path: string; format: "qcow2" }[];
	mem: number;
	cpu: number;
	ports: Record<string, PortMapping>;
	/** @deprecated Use `networks` instead. */
	network?: NetworkMode;
	/** Network interfaces with resolved QEMU args. */
	networks: NetworkConfig[];
	background: boolean;
}

/** Build the full QEMU command-line arguments array. */
export async function buildQemuArgs(config: QemuLaunchConfig): Promise<string[]> {
	const { arch, machineDir, bootDisk, extraDisks, mem, cpu, ports, networks, background } = config;

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

	// CPU model overrides for HVF-backed guests.
	if (arch === "x86") {
		if (accel === "hvf") {
			args.push("-cpu", "host");
		}
	} else {
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

	// Boot disk drive
	if (arch === "arm64") {
		// ARM64: MUST use explicit virtio-blk-pci (not if=virtio which maps to MMIO)
		args.push(
			"-drive", `file=${bootDisk.path},format=${bootDisk.format},if=none,id=drive0`,
			"-device", "virtio-blk-pci,drive=drive0",
		);
	} else {
		// x86: if=virtio is fine (maps to PCI on q35/pc)
		args.push("-drive", `file=${bootDisk.path},format=${bootDisk.format},if=virtio`);
	}

	// Extra disks
	if (extraDisks && extraDisks.length > 0) {
		for (let i = 0; i < extraDisks.length; i++) {
			const disk = extraDisks[i] as { path: string; format: "qcow2" };
			const driveId = `drive${i + 1}`;
			if (arch === "arm64") {
				args.push(
					"-drive", `file=${disk.path},format=${disk.format},if=none,id=${driveId}`,
					"-device", `virtio-blk-pci,drive=${driveId}`,
				);
			} else {
				args.push("-drive", `file=${disk.path},format=${disk.format},if=virtio`);
			}
		}
	}

	// Networking
	buildNetworkArgs(args, ports, networks);

	// Display
	args.push("-display", "none");

	// Serial, monitor, QGA channels
	buildChannelArgs(args, arch, machineDir, background);

	return args;
}

/** Build networking arguments from NetworkConfig array. */
function buildNetworkArgs(
	args: string[],
	ports: Record<string, PortMapping>,
	networks: NetworkConfig[],
): void {
	for (const net of networks) {
		// If resolution produced QEMU args, use those directly
		if (net.resolved?.qemuNetdevArgs) {
			args.push(...net.resolved.qemuNetdevArgs);
			continue;
		}

		// Fallback: build args from specifier (legacy path and simple cases)
		const spec = net.specifier;
		const id = net.id;

		if (spec === "vmnet-shared") {
			args.push(
				"-netdev", `vmnet-shared,id=${id}`,
				"-device", `virtio-net-pci,netdev=${id}`,
			);
		} else if (typeof spec === "object" && spec.type === "vmnet-bridged") {
			args.push(
				"-netdev", `vmnet-bridged,id=${id},ifname=${spec.iface}`,
				"-device", `virtio-net-pci,netdev=${id}`,
			);
		} else if (typeof spec === "object" && spec.type === "socket-listen") {
			args.push(
				"-netdev", `socket,id=${id},listen=:${spec.port}`,
				"-device", `virtio-net-pci,netdev=${id}`,
			);
		} else if (typeof spec === "object" && spec.type === "socket-connect") {
			args.push(
				"-netdev", `socket,id=${id},connect=127.0.0.1:${spec.port}`,
				"-device", `virtio-net-pci,netdev=${id}`,
			);
		} else if (typeof spec === "object" && spec.type === "socket-mcast") {
			args.push(
				"-netdev", `socket,id=${id},mcast=${spec.group}:${spec.port}`,
				"-device", `virtio-net-pci,netdev=${id}`,
			);
		} else if (typeof spec === "object" && spec.type === "tap") {
			args.push(
				"-netdev", `tap,id=${id},ifname=${spec.ifname},script=no,downscript=no`,
				"-device", `virtio-net-pci,netdev=${id}`,
			);
		} else {
			// Default: user-mode networking with port forwarding (only on the first user NIC)
			const hostfwd = buildHostfwdString(ports);
			args.push(
				"-netdev", `user,id=${id}${hostfwd ? "," + hostfwd : ""}`,
				"-device", `virtio-net-pci,netdev=${id}`,
			);
		}
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

	// QGA channel — x86 only. RouterOS QGA requires KVM; arm64 CHR does not implement QGA.
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

/** Extract socket_vmnet wrapper from resolved networks (at most one allowed). */
export function extractWrapper(
	networks: NetworkConfig[],
): { command: string; args: string[] } | undefined {
	const wrappers: string[][] = [];
	for (const n of networks) {
		if (n.resolved?.wrapper) {
			wrappers.push(n.resolved.wrapper);
		}
	}
	if (wrappers.length > 1) {
		throw new QuickCHRError(
			"INVALID_NETWORK",
			"Multiple networks require socket_vmnet wrapper — only one is supported per VM",
		);
	}
	const w = wrappers[0];
	if (!w || w.length === 0) return undefined;
	const [command, ...wrapperArgs] = w;
	if (!command) return undefined;
	return { command, args: wrapperArgs };
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
	wrapper?: { command: string; args: string[] },
): Promise<{ pid: number; process?: ReturnType<typeof Bun.spawn> }> {
	ensureDir(machineDir);

	const logPath = join(machineDir, "qemu.log");
	const pidPath = join(machineDir, "qemu.pid");

	const [bin, ...args] = qemuArgs;

	if (!bin) throw new QuickCHRError("SPAWN_FAILED", "Empty QEMU args");

	let spawnCmd: string[];
	if (wrapper) {
		// socket_vmnet wrapper path logged at debug level — full paths belong in `doctor`
		if (process.env.QUICKCHR_DEBUG === "1") {
			process.stderr.write(`[quickchr] Using socket_vmnet wrapper: ${wrapper.command} ${wrapper.args.join(" ")}\n`);
		}
		spawnCmd = [wrapper.command, ...wrapper.args, bin, ...args];
	} else {
		spawnCmd = [bin, ...args];
	}

	if (background) {
		// Open log file as an fd — more reliable than BunFile for subprocess stdio.
		// After spawn, close parent's copy; child process inherits its own copy.
		const logFd = openSync(logPath, "a");
		const proc = Bun.spawn(spawnCmd, {
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
	const proc = Bun.spawn(spawnCmd, {
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

/**
 * Wait for the RouterOS REST layer to be fully stable.
 *
 * RouterOS startup is staged from our perspective:
 *   1. Connection refused — QEMU still booting
 *   2. ECONNRESET — HTTP server started but REST subsystem not yet accepting
 *   3. 401 from /rest — auth middleware is up; REST handler may still be initializing
 *   4. 200 but wrong body — startup race: REST initializes before routing tables settle; /system/resource may return an array (e.g. /user list) for a brief window
 *   5. 200 with correct body — REST is fully operational
 *
 * With proper credentials this function reaches stage 5 before returning. With
 * unauthenticated or admin-disabled instances (where we get 401) it accepts
 * stage 3 — auth rejection proves the REST layer responded, which is sufficient
 * for callers that do not need body validation.
 *
 * Requires 2 consecutive successful probes to prevent false-positives during
 * the brief window where RouterOS intermittently resets new connections
 * immediately after coming up.
 *
 * @param httpPort  HTTP port of the CHR instance.
 * @param timeoutMs Overall deadline (default 120 s).
 * @param auth      HTTP Basic Authorization header to use for probes.
 *                  Defaults to `admin:` (empty password) which works on fresh
 *                  CHR images; pass instance credentials for post-reboot probes
 *                  on provisioned machines so body validation can be performed.
 */
export async function waitForBoot(
	httpPort: number,
	timeoutMs: number = 120_000,
	auth: string = `Basic ${btoa("admin:")}`,
): Promise<boolean> {
	const url = `http://127.0.0.1:${httpPort}/rest/system/resource`;
	const deadline = Date.now() + timeoutMs;
	let consecutiveReady = 0;

	while (Date.now() < deadline) {
		try {
			const r = await fetch(url, {
				headers: { Authorization: auth },
				signal: AbortSignal.timeout(3000),
			});

			if (r.status === 401 || r.status === 403) {
				// Auth rejected — the REST layer is up and responded, even though
				// we cannot validate the body. Count as ready.
				consecutiveReady++;
			} else if (r.ok) {
				// RouterOS REST may return wrong data (array body) briefly after boot —
				// a startup race, not related to the admin expired flag. Only accept
				// the response once the body is the expected singleton object.
				const body = await r.json().catch(() => null) as unknown;
				if (body && typeof body === "object" && !Array.isArray(body) && "board-name" in (body as object)) {
					consecutiveReady++;
				} else {
					consecutiveReady = 0; // wrong body — REST not fully initialized yet
				}
			} else {
				consecutiveReady = 0;
			}

			if (consecutiveReady >= 2) return true;
		} catch {
			// ECONNRESET, connection refused, parse error — not ready yet
			consecutiveReady = 0;
		}
		await Bun.sleep(2000);
	}

	return false;
}
