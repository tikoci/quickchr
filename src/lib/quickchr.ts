/**
 * QuickCHR — main API class tying together all modules.
 */

import type {
	Arch,
	Channel,
	ChrInstance,
	DoctorResult,
	MachineState,
	StartOptions,
} from "./types.ts";
import { QuickCHRError, ARCHES } from "./types.ts";
import { detectPlatform, requireQemu, requireFirmware, getQemuVersion, getQemuInstallHint, } from "./platform.ts";
import { resolveVersion, isValidVersion, generateMachineName } from "./versions.ts";
import { buildPortMappings, findAvailablePortBlock, } from "./network.ts";
import {
	getUsedPortBases,
	saveMachine,
	loadMachine,
	removeMachine as removeState,
	getMachineDir,
	listMachineNames,
	refreshAllStatuses,
	isMachineRunning,
	ensureDir,
	getCacheDir,
	getDataDir,
} from "./state.ts";
import { ensureCachedImage, copyImageToMachine, listCachedImages } from "./images.ts";
import { buildQemuArgs, spawnQemu, stopQemu, waitForBoot, type QemuLaunchConfig } from "./qemu.ts";
import { monitorCommand, serialStreams, qgaCommand } from "./channels.ts";
import { installPackages } from "./packages.ts";
import { provision } from "./provision.ts";
import { toChrPorts } from "./network.ts";
import { existsSync, rmSync, copyFileSync } from "node:fs";
import { join } from "node:path";

/** Create a ChrInstance handle from persisted MachineState. */
function createInstance(state: MachineState): ChrInstance {
	const ports = toChrPorts(state.ports);
	const restUrl = `http://127.0.0.1:${ports.http}`;

	return {
		name: state.name,
		state,
		ports,
		restUrl,
		sshPort: ports.ssh,

		async waitForBoot(timeoutMs?: number): Promise<boolean> {
			return waitForBoot(ports.http, timeoutMs);
		},

		async stop(): Promise<void> {
			if (state.pid) {
				await stopQemu(state.pid);
			}
			// Update persisted state
			const current = loadMachine(state.name);
			if (current) {
				current.status = "stopped";
				current.pid = undefined;
				saveMachine(current);
			}
			state.status = "stopped";
			state.pid = undefined;
		},

		async remove(): Promise<void> {
			if (state.pid && isMachineRunning(state)) {
				await stopQemu(state.pid);
			}
			removeState(state.name);
		},

		async clean(): Promise<void> {
			if (state.pid && isMachineRunning(state)) {
				await stopQemu(state.pid);
			}
			// Re-copy fresh image from cache
			const imgPath = join(getCacheDir(), `chr-${state.version}${state.arch === "arm64" ? "-arm64" : ""}.img`);
			if (!existsSync(imgPath)) {
				throw new QuickCHRError("MACHINE_NOT_FOUND", `Cached image not found: ${imgPath}`);
			}
			const destPath = join(state.machineDir, "disk.img");
			copyFileSync(imgPath, destPath);

			// Remove EFI vars to force re-creation
			const efiVars = join(state.machineDir, "efi-vars.fd");
			if (existsSync(efiVars)) rmSync(efiVars);

			// Update state
			const current = loadMachine(state.name);
			if (current) {
				current.status = "stopped";
				current.pid = undefined;
				saveMachine(current);
			}
			state.status = "stopped";
			state.pid = undefined;
		},

		async monitor(command: string): Promise<string> {
			return monitorCommand(state.machineDir, command);
		},

		serial(): { readable: ReadableStream; writable: WritableStream } {
			return serialStreams(state.machineDir);
		},

		async qga(command: string, args?: object): Promise<unknown> {
			return qgaCommand(state.machineDir, state.arch, command, args);
		},

		async rest(path: string, opts?: RequestInit): Promise<unknown> {
			const url = `${restUrl}/rest${path.startsWith("/") ? path : "/" + path}`;
			const headers = new Headers(opts?.headers);
			if (!headers.has("Authorization")) {
				headers.set("Authorization", `Basic ${btoa("admin:")}`);
			}
			if (!headers.has("Content-Type") && opts?.body) {
				headers.set("Content-Type", "application/json");
			}

			const response = await fetch(url, { ...opts, headers });
			if (!response.ok) {
				const body = await response.text();
				throw new Error(`REST ${response.status}: ${body}`);
			}

			const ct = response.headers.get("content-type") || "";
			if (ct.includes("application/json")) {
				return response.json();
			}
			return response.text();
		},
	};
}

/** Resolve the host architecture to a CHR architecture. */
function hostArchToChr(): Arch {
	const arch = process.arch;
	if (arch === "arm64") return "arm64";
	return "x86";
}

// biome-ignore lint/complexity/noStaticOnlyClass: QuickCHR is the public API — class provides a clear namespace for consumers
export class QuickCHR {
	/** Start a new or existing CHR instance. */
	static async start(opts: StartOptions = {}): Promise<ChrInstance> {
		// Resolve version
		let version: string;
		if (opts.version) {
			if (!isValidVersion(opts.version)) {
				throw new QuickCHRError("INVALID_VERSION", `Invalid version: ${opts.version}`);
			}
			version = opts.version;
		} else {
			const channel = opts.channel ?? "stable";
			version = await resolveVersion(channel);
		}

		// Resolve architecture
		const arch: Arch = opts.arch ?? hostArchToChr();

		// Check prerequisites
		requireQemu(arch);
		if (arch === "arm64") {
			requireFirmware();
		}

		// Resolve name
		const existingNames = listMachineNames();
		const name = opts.name ?? generateMachineName(version, arch, existingNames);

		// Check if machine already exists
		const existing = loadMachine(name);
		if (existing) {
			if (isMachineRunning(existing)) {
				return createInstance(existing);
			}
			// Exists but stopped — restart it
			return QuickCHR._launchExisting(existing, opts.background ?? true);
		}

		// Allocate port block
		const usedBases = getUsedPortBases();
		const portBase = opts.portBase
			? opts.portBase
			: await findAvailablePortBlock(
				usedBases,
				opts.excludePorts,
				opts.extraPorts,
			);

		const ports = buildPortMappings(
			portBase,
			opts.excludePorts,
			opts.extraPorts,
		);

		// Dry run — return instance handle without actually spawning
		if (opts.dryRun) {
			const machineDir = getMachineDir(name);
			const state: MachineState = {
				name,
				version,
				arch,
				cpu: opts.cpu ?? 1,
				mem: opts.mem ?? 512,
				network: opts.network ?? "user",
				ports,
				packages: opts.packages ?? [],
				user: opts.user,
				disableAdmin: opts.disableAdmin,
				portBase,
				excludePorts: opts.excludePorts ?? [],
				extraPorts: opts.extraPorts ?? [],
				createdAt: new Date().toISOString(),
				status: "stopped",
				machineDir,
			};
			return createInstance(state);
		}

		// Download and prepare image
		const cachedImg = await ensureCachedImage(version, arch);
		const machineDir = getMachineDir(name);
		ensureDir(machineDir);
		const diskPath = copyImageToMachine(cachedImg, machineDir);

		// Build machine config
		const background = opts.background ?? true;
		const state: MachineState = {
			name,
			version,
			arch,
			cpu: opts.cpu ?? 1,
			mem: opts.mem ?? 512,
			network: opts.network ?? "user",
			ports,
			packages: opts.packages ?? [],
			user: opts.user,
			disableAdmin: opts.disableAdmin,
			portBase,
			excludePorts: opts.excludePorts ?? [],
			extraPorts: opts.extraPorts ?? [],
			createdAt: new Date().toISOString(),
			status: "running",
			machineDir,
		};

		// Build QEMU args and spawn
		const launchConfig: QemuLaunchConfig = {
			arch,
			machineDir,
			diskPath,
			mem: state.mem,
			cpu: state.cpu,
			ports: state.ports,
			network: state.network,
			background,
		};

		const qemuArgs = await buildQemuArgs(launchConfig);
		const { pid } = await spawnQemu(qemuArgs, machineDir, background);

		// Foreground: spawnQemu blocks until QEMU exits
		if (!background) {
			state.status = "stopped";
			state.lastStartedAt = new Date().toISOString();
			saveMachine(state);
			return createInstance(state);
		}

		state.pid = pid;
		state.lastStartedAt = new Date().toISOString();

		saveMachine(state);

		const instance = createInstance(state);

		// Post-boot provisioning (background only).
		// x86 TCG emulation is slow — use a generous timeout (5 min).
		const bootTimeout = arch === "arm64" ? 120_000 : 300_000;
		const booted = await instance.waitForBoot(bootTimeout);

		if (!booted) {
			if ((opts.packages && opts.packages.length > 0) || opts.user || opts.disableAdmin) {
				console.warn(`[quickchr] Warning: CHR did not respond within ${bootTimeout / 1000}s — skipping provisioning. Run 'quickchr status ${name}' to check once it's up.`);
			}
			return instance;
		}

		// Give SSH a moment to start after HTTP comes up
		await Bun.sleep(2000);

		// Install extra packages if requested
		if (opts.packages && opts.packages.length > 0) {
			const chrPorts = toChrPorts(ports);
			await installPackages(opts.packages, version, arch, chrPorts.ssh, chrPorts.http);
			// Wait for reboot to activate packages
			await Bun.sleep(5000);
			await instance.waitForBoot(bootTimeout);
			await Bun.sleep(2000);
		}

		// User provisioning
		if (opts.user || opts.disableAdmin) {
			const httpPort = toChrPorts(ports).http;
			await provision(httpPort, opts.user, opts.disableAdmin);
		}

		return instance;
	}

	/** Re-launch an existing stopped machine. */
	static async _launchExisting(
		state: MachineState,
		background: boolean,
	): Promise<ChrInstance> {
		const diskPath = join(state.machineDir, "disk.img");
		if (!existsSync(diskPath)) {
			throw new QuickCHRError("MACHINE_NOT_FOUND", `Disk image not found for "${state.name}"`);
		}

		const launchConfig: QemuLaunchConfig = {
			arch: state.arch,
			machineDir: state.machineDir,
			diskPath,
			mem: state.mem,
			cpu: state.cpu,
			ports: state.ports,
			network: state.network,
			background,
		};

		const qemuArgs = await buildQemuArgs(launchConfig);
		const { pid } = await spawnQemu(qemuArgs, state.machineDir, background);

		// Foreground: spawnQemu blocks until QEMU exits
		if (!background) {
			state.status = "stopped";
			state.lastStartedAt = new Date().toISOString();
			saveMachine(state);
			return createInstance(state);
		}

		state.pid = pid;
		state.status = "running";
		state.lastStartedAt = new Date().toISOString();
		saveMachine(state);

		return createInstance(state);
	}

	/** List all machines (refreshes PID status). */
	static list(): MachineState[] {
		return refreshAllStatuses();
	}

	/** Get an instance handle for an existing machine by name. */
	static get(name: string): ChrInstance | null {
		const state = loadMachine(name);
		if (!state) return null;

		// Refresh PID status
		if (state.status === "running" && !isMachineRunning(state)) {
			state.status = "stopped";
			state.pid = undefined;
			saveMachine(state);
		}

		return createInstance(state);
	}

	/** Run doctor checks for prerequisites. */
	static async doctor(): Promise<DoctorResult> {
		const checks: DoctorResult["checks"] = [];

		// Bun version
		checks.push({
			label: "Bun runtime",
			status: "ok",
			detail: `bun ${Bun.version}`,
		});

		// QEMU for each arch
		for (const arch of ARCHES) {
			const qemuName = arch === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86_64";
			try {
				requireQemu(arch);
				const ver = getQemuVersion(arch);
				checks.push({
					label: qemuName,
					status: "ok",
					detail: ver ?? "found (version unknown)",
				});
			} catch (_e) {
				const hint = getQemuInstallHint() ?? "Install QEMU";
				checks.push({
					label: qemuName,
					status: arch === hostArchToChr() ? "error" : "warn",
					detail: `not found — ${hint}`,
				});
			}
		}

		// UEFI firmware
		try {
			const fw = requireFirmware();
			checks.push({
				label: "UEFI firmware",
				status: "ok",
				detail: fw.code,
			});
		} catch {
			checks.push({
				label: "UEFI firmware",
				status: hostArchToChr() === "arm64" ? "error" : "warn",
				detail: "not found (needed for arm64 CHR)",
			});
		}

		// Acceleration
		try {
			const platform = await detectPlatform();
			if (platform.accelAvailable.length > 0) {
				checks.push({
					label: "Acceleration",
					status: "ok",
					detail: `${platform.accelAvailable.join(", ")} (host: ${platform.hostArch})`,
				});
			} else {
				checks.push({
					label: "Acceleration",
					status: "warn",
					detail: "TCG only (software emulation)",
				});
			}
		} catch {
			checks.push({
				label: "Acceleration",
				status: "warn",
				detail: "Could not detect",
			});
		}

		// Data directory
		const dataDir = getDataDir();
		checks.push({
			label: "Data directory",
			status: "ok",
			detail: dataDir,
		});

		// Cache
		try {
			const cached = listCachedImages();
			checks.push({
				label: "Cache",
				status: "ok",
				detail: `${cached.length} image${cached.length !== 1 ? "s" : ""} cached`,
			});
		} catch {
			checks.push({
				label: "Cache",
				status: "ok",
				detail: "empty",
			});
		}

		// Machines
		const machines = refreshAllStatuses();
		const running = machines.filter((m) => m.status === "running").length;
		checks.push({
			label: "Machines",
			status: "ok",
			detail: `${machines.length} instance${machines.length !== 1 ? "s" : ""} (${running} running)`,
		});

		// socat (optional, for serial console piping)
		const socatResult = Bun.spawnSync(["which", "socat"], { stdout: "pipe", stderr: "pipe" });
		if (socatResult.exitCode === 0) {
			checks.push({
				label: "socat",
				status: "ok",
				detail: new TextDecoder().decode(socatResult.stdout).trim(),
			});
		} else {
			checks.push({
				label: "socat",
				status: "warn",
				detail: "not found (optional, for serial console access)",
			});
		}

		// sshpass (needed for package upload to RouterOS — empty-password auth)
		const sshpassResult = Bun.spawnSync(["which", "sshpass"], { stdout: "pipe", stderr: "pipe" });
		if (sshpassResult.exitCode === 0) {
			checks.push({
				label: "sshpass",
				status: "ok",
				detail: new TextDecoder().decode(sshpassResult.stdout).trim(),
			});
		} else {
			checks.push({
				label: "sshpass",
				status: "warn",
				detail: "not found — required for extra package upload (brew install sshpass / apt install sshpass)",
			});
		}

		return {
			checks,
			ok: checks.every((c) => c.status !== "error"),
		};
	}

	/** Resolve a channel to a version string. */
	static async resolveVersion(channel: Channel): Promise<string> {
		return resolveVersion(channel);
	}
}
