/**
 * QuickCHR — main API class tying together all modules.
 */

import type {
	Arch,
	Channel,
	ChrInstance,
	ChrLoadSample,
	DeviceModeOptions,
	DoctorResult,
	ExecOptions,
	ExecResult,
	LicenseInput,
	LicenseLevel,
	MachineState,
	QgaCommand,
	SnapshotInfo,
	StartOptions,
} from "./types.ts";
import { QuickCHRError, ARCHES, CHANNELS } from "./types.ts";
import { detectPlatform, requireQemu, requireFirmware, getQemuVersion, getQemuInstallHint, isCrossArchEmulation, accelTimeoutFactor, detectAccel, findQemuImg, qgaKvmWarning, detectSocketVmnet, isSocketVmnetDaemonRunning, findCommandOnPath } from "./platform.ts";
import {
	resolveVersion,
	isValidVersion,
	generateMachineName,
	assertProvisioningSupportedVersion,
	PROVISIONING_FEATURE_LABEL,
} from "./versions.ts";
import { buildPortMappings, findAvailablePortBlock, resolveStartNetworks, resolveAllNetworks, buildHostfwdString, hasUserModeNetwork, validateExplicitExtraPorts } from "./network.ts";
import {
	getUsedPortBases,
	saveMachine,
	loadMachine,
	loadAllMachines,
	removeMachine as removeState,
	getMachineDir,
	getMachinesDir,
	listMachineNames,
	refreshAllStatuses,
	isMachineRunning,
	ensureDir,
	getCacheDir,
	getDataDir,
} from "./state.ts";
import { ensureCachedImage, copyImageToMachine, listCachedImages } from "./images.ts";
import { autoPruneIfOverCap } from "./cache.ts";
import { buildQemuArgs, spawnQemu, stopQemu, waitForBoot, extractWrapper, type QemuLaunchConfig } from "./qemu.ts";
import { cleanDiskFiles, ensureConfiguredDisks, normalizeDiskOptions, parseSnapshotList, listSnapshots, formatDiskSize } from "./disk.ts";
import { monitorCommand, serialStreams, qgaCommand, channelEndpoint } from "./channels.ts";
import { installPackages, installAllPackages, downloadAndListPackages, downloadPackages, findPackageFile, uploadPackages } from "./packages.ts";
import { provision } from "./provision.ts";
import { renewLicense, getLicenseInfo } from "./license.ts";
import { resolveAuth, resolveCreds } from "./auth.ts";
import { scpPush, scpPull } from "./scp.ts";
import { deleteInstanceCredentials, credentialStorageLabel, getStoredCredentials } from "./credentials.ts";
import { restExecute } from "./exec.ts";
import { qgaExec } from "./qga.ts";
import { consoleExec } from "./console.ts";
import { restRequest, restGet, restPost } from "./rest.ts";
import { createNamedSocket, getNamedSocket, addSocketMember, removeSocketMember } from "./socket-registry.ts";
import { createLogger, type ProgressLogger } from "./log.ts";
import {
	formatDeviceModeSelection,
	readDeviceMode,
	resolveDeviceModeOptions,
	shouldApplyDeviceMode,
	startDeviceModeUpdate,
	verifyDeviceMode,
	waitForDeviceModeApi,
} from "./device-mode.ts";
import type { LicenseOptions } from "./types.ts";
import { toChrPorts } from "./network.ts";
import { assertSufficientQuickchrStorage, formatQuickchrUsage, getQuickchrStorageReport } from "./storage.ts";
import { existsSync, readdirSync, rmSync, copyFileSync, writeFileSync, unlinkSync, openSync, writeSync, closeSync, readFileSync } from "node:fs";
import { join } from "node:path";

// --- Architecture-aware defaults ---

/** Default mem (MiB) — more for cross-arch TCG emulation, less for native HVF/KVM. */
function defaultMem(arch: Arch, override?: number): number {
	return override ?? (isCrossArchEmulation(arch) ? 1024 : 512);
}

/** Default boot timeout — accel mode and cross-arch emulation affect how slow the VM boots. */
function defaultBootTimeout(arch: Arch, withPackages?: boolean, accel?: string): number {
	const cross = isCrossArchEmulation(arch);
	const factor = accelTimeoutFactor(accel ?? "tcg", cross);
	// Base: 120s for native, scaled by factor (TCG cross-arch = 15× = 1800s max)
	const base = Math.ceil(120_000 * factor);
	// Package reinstall adds a full reboot cycle — extend by the same factor.
	return withPackages ? base * 2 : base;
}

function hasProvisioningMutations(opts: {
	installAllPackages?: boolean;
	packages?: string[];
	hasDeviceModeProvisioning?: boolean;
	user?: { name: string; password: string };
	disableAdmin?: boolean;
	license?: LicenseInput;
	secureLogin?: boolean;
}): boolean {
	return !!(
		opts.installAllPackages ||
		(opts.packages?.length ?? 0) > 0 ||
		opts.hasDeviceModeProvisioning ||
		opts.user ||
		opts.disableAdmin ||
		opts.license ||
		opts.secureLogin === true
	);
}

function listProvisioningMutations(opts: {
	installAllPackages?: boolean;
	packages?: string[];
	hasDeviceModeProvisioning?: boolean;
	user?: { name: string; password: string };
	disableAdmin?: boolean;
	license?: LicenseInput;
	secureLogin?: boolean;
}): string[] {
	const operations: string[] = [];
	if (opts.installAllPackages) {
		operations.push("install all packages");
	} else if ((opts.packages?.length ?? 0) > 0) {
		operations.push("install extra packages");
	}
	if (opts.user) {
		operations.push("create a custom user");
	} else if (opts.secureLogin === true) {
		operations.push("create a managed login");
	}
	if (opts.disableAdmin) {
		operations.push("disable the default admin account");
	}
	if (opts.license) {
		operations.push("apply a license");
	}
	if (opts.hasDeviceModeProvisioning) {
		operations.push("change device-mode");
	}
	return operations;
}

function joinHumanList(items: string[]): string {
	if (items.length <= 1) return items[0] ?? "";
	if (items.length === 2) return `${items[0]} and ${items[1]}`;
	return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function describeProvisioningOperation(opts: Parameters<typeof listProvisioningMutations>[0]): string {
	const operations = listProvisioningMutations(opts);
	if (operations.length === 0) return `use ${PROVISIONING_FEATURE_LABEL}`;
	if (operations.length === 1) return operations[0] ?? `use ${PROVISIONING_FEATURE_LABEL}`;
	return `use ${PROVISIONING_FEATURE_LABEL} (${joinHumanList(operations)})`;
}

// --- Socket registry lifecycle helpers ---

function getSocketNamedNetworks(state: MachineState): string[] {
	return state.networks
		.filter((n) => typeof n.specifier === "object" && n.specifier.type === "socket")
		.map((n) => (n.specifier as { type: "socket"; name: string }).name);
}

function registerSocketMembers(state: MachineState): void {
	for (const name of getSocketNamedNetworks(state)) {
		try {
			if (!getNamedSocket(name)) {
				createNamedSocket(name, { autoCreated: true });
			}
			addSocketMember(name, state.name);
		} catch (e) {
			console.warn(`Warning: failed to register socket member "${state.name}" on "${name}": ${e instanceof Error ? e.message : String(e)}`);
		}
	}
}

function unregisterSocketMembers(state: MachineState): void {
	for (const name of getSocketNamedNetworks(state)) {
		try {
			removeSocketMember(name, state.name);
		} catch (e) {
			console.warn(`Warning: failed to unregister socket member "${state.name}" from "${name}": ${e instanceof Error ? e.message : String(e)}`);
		}
	}
}

// --- License helpers ---

/** Resolve a LicenseInput to a full LicenseOptions, filling in credentials from
 *  env vars / secret store when not provided by the caller. Returns null with a
 *  warning when credentials cannot be found. */
async function resolveLicenseInput(input: LicenseInput): Promise<LicenseOptions | null> {
	const opts: LicenseOptions = typeof input === "string" ? { level: input } : { ...input };
	if (opts.account && opts.password) return opts;
	// Try to fill in missing credentials.
	const stored = await getStoredCredentials();
	if (stored) {
		if (!opts.account) opts.account = stored.account;
		if (!opts.password) opts.password = stored.password;
		return opts;
	}
	console.warn(
		"License skipped: no MikroTik web credentials found. " +
		"Set MIKROTIK_WEB_ACCOUNT / MIKROTIK_WEB_PASSWORD or run 'quickchr login'.",
	);
	return null;
}

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
		portBase: state.portBase,
		captureInterface: process.platform === "darwin" ? "lo0" : "any",
		tzspGatewayIp: "10.0.2.2",

		async waitForBoot(timeoutMs?: number): Promise<boolean> {
			// Use resolved credentials so waitForBoot can validate the response body
			// on authenticated machines (post-provisioning, post-install reboots).
			const auth = resolveAuth(state);
			return waitForBoot(ports.http, timeoutMs, auth.header);
		},

		async waitFor(condition: () => Promise<boolean>, timeoutMs = 30_000): Promise<boolean> {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				try {
					if (await condition()) return true;
				} catch { /* swallow — condition may throw before the state is ready */ }
				const remaining = deadline - Date.now();
				if (remaining <= 0) break;
				await Bun.sleep(Math.min(2000, remaining));
			}
			return false;
		},

		async stop(): Promise<void> {
			if (state.pid) {
				await stopQemu(state.pid);
			}
			unregisterSocketMembers(state);
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
			unregisterSocketMembers(state);
			// Clean up stored instance credentials
			deleteInstanceCredentials(state.name);
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

			// Clean up disk files (boot.qcow2, extra disks)
			cleanDiskFiles(state.machineDir);

			// Re-prepare disks if the machine had disk customizations
			await ensureConfiguredDisks(
				state.machineDir,
				state.bootSize,
				state.extraDisks,
				state.bootDiskFormat ?? (state.bootSize ? "qcow2" : "raw"),
			);

			// Remove EFI vars to force re-creation
			const efiVars = join(state.machineDir, "efi-vars.fd");
			if (existsSync(efiVars)) rmSync(efiVars);

			// Clean up stored instance credentials (re-provisioned on next start)
			deleteInstanceCredentials(state.name);

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
			return monitorCommand(state.machineDir, command, undefined, state.portBase);
		},

		serial(): { readable: ReadableStream; writable: WritableStream } {
			return serialStreams(state.machineDir, state.portBase);
		},

		async qga(command: QgaCommand, args?: object): Promise<unknown> {
			return qgaCommand(state.machineDir, state.arch, command, args, undefined, state.portBase);
		},

		async rest(path: string, opts?: RequestInit): Promise<unknown> {
			const url = `${restUrl}/rest${path.startsWith("/") ? path : "/" + path}`;

			// Retry on ECONNRESET — RouterOS can transiently reset connections in the
			// brief window immediately after boot or a reboot, even after waitForBoot
			// returns. Three retries with 2 s backoff cover this window without hiding
			// genuine errors (auth failures, 4xx/5xx codes are never retried).
			const MAX_RETRIES = 3;
			for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
				if (attempt > 0) await Bun.sleep(2000);

				// Resolve auth and method
				const authResolved = resolveAuth(state);
				let authHeader = authResolved.header;
				// Allow caller to override Authorization via opts.headers
				if (opts?.headers) {
					const h = new Headers(opts.headers);
					const overrideAuth = h.get("Authorization");
					if (overrideAuth) authHeader = overrideAuth;
				}
				const method = (opts?.method ?? "GET").toUpperCase();
				const bodyStr = opts?.body != null ? String(opts.body) : null;

				try {
					const { status, body } = await restRequest(
						url,
						method,
						authHeader,
						bodyStr,
						10_000,
					);
					if (status < 200 || status >= 300) {
						throw new Error(`REST ${status}: ${body}`);
					}

					try {
						return JSON.parse(body) as unknown;
					} catch {
						return body;
					}
				} catch (e) {
					if (attempt < MAX_RETRIES && (e as { code?: string }).code === "ECONNRESET") {
						console.warn(`rest(${path}): ECONNRESET on attempt ${attempt + 1}, retrying...`);
						continue;
					}
					throw e;
				}
			}

			throw new Error("Unexpected exit from rest() retry loop");
		},

		async exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
			const via = opts?.via ?? "auto";

			if (via === "qga") {
				if (state.arch === "arm64") {
					throw new QuickCHRError(
						"QGA_UNSUPPORTED",
						"QEMU Guest Agent is not yet functional on ARM64 CHR — MikroTik arm64 guest agent support is planned but not yet released",
					);
				}
				const kvmWarning = qgaKvmWarning();
				if (kvmWarning) {
					console.warn(kvmWarning);
				}
				const endpoint = channelEndpoint(state.machineDir, "qga", state.portBase);
				const result = await qgaExec(endpoint, command, opts?.timeout ?? 30_000);
				return { output: result.stdout.trim(), via: "qga" };
			}

			if (via === "console") {
				const auth = resolveAuth(state, opts?.user, opts?.password);
				const result = await consoleExec(
					state.machineDir,
					command,
					auth.user,
					opts?.password ?? state.user?.password ?? "",
					opts?.timeout ?? 30_000,
					state.portBase,
				);
				return { output: result.output, via: "console" };
			}

			if (via !== "auto" && via !== "rest") {
				throw new QuickCHRError(
					"EXEC_FAILED",
					`exec transport "${via}" is not yet implemented`,
				);
			}
			const auth = resolveAuth(state, opts?.user, opts?.password);
			if (via === "rest") {
				return restExecute(restUrl, auth, command, opts);
			}
			// via === "auto": try REST, fall back to console on network/timeout errors.
			// QuickCHRError from REST (HTTP errors like 401/400) are not retried — they
			// represent a real command or auth failure, not an unreachable endpoint.
			try {
				return await restExecute(restUrl, auth, command, {
					...opts,
					timeout: opts?.timeout ?? 10_000,
				});
			} catch (e) {
				if (e instanceof QuickCHRError) throw e;
				// Network error (ECONNREFUSED, timeout) — fall back to console
				const consoleResult = await consoleExec(
					state.machineDir,
					command,
					auth.user,
					opts?.password ?? state.user?.password ?? "",
					opts?.timeout ?? 30_000,
					state.portBase,
				);
				return { output: consoleResult.output, via: "console" };
			}
		},

		async license(opts: LicenseOptions): Promise<void> {
			assertProvisioningSupportedVersion(state.version, "apply a license");
			const auth = resolveAuth(state);
			await renewLicense(ports.http, opts, undefined, undefined, undefined, auth.header);
			// Persist the applied level in state
			if (opts.level) {
				const current = loadMachine(state.name);
				if (current) {
					current.licenseLevel = opts.level;
					saveMachine(current);
				}
				state.licenseLevel = opts.level;
			}
		},

		async setDeviceMode(options: DeviceModeOptions, logger?: ProgressLogger): Promise<void> {
			assertProvisioningSupportedVersion(state.version, "set device-mode");
			const log = logger ?? createLogger();
			const resolved = resolveDeviceModeOptions(options);
			for (const w of resolved.warnings) log.warn(`Device-mode: ${w}`);
			const launchConfig = await buildLaunchConfigFromState(state);
			await applyDeviceMode(this as ChrInstance, state, resolved, launchConfig, log);
			// Persist updated device-mode in state
			const current = loadMachine(state.name);
			if (current) {
				current.deviceMode = options;
				saveMachine(current);
			}
			state.deviceMode = options;
		},

		async availablePackages(): Promise<string[]> {
			return downloadAndListPackages(state.version, state.arch);
		},

		async installPackage(packages: string | string[]): Promise<string[]> {
			assertProvisioningSupportedVersion(state.version, "install packages");
			const names = typeof packages === "string" ? [packages] : packages;
			if (names.length === 0) return [];

			const extractDir = await downloadPackages(state.version, state.arch);
			const packagePaths: string[] = [];
			const installed: string[] = [];
			for (const pkg of names) {
				const pkgPath = findPackageFile(extractDir, pkg);
				if (!pkgPath) {
					console.warn(`Package "${pkg}" not found in all_packages for ${state.version} (${state.arch})`);
					continue;
				}
				packagePaths.push(pkgPath);
				installed.push(pkg);
			}
			if (packagePaths.length === 0) return [];

			await uploadPackages(packagePaths, ports.ssh);

			// Reboot to activate packages
			let rebootAuth: string;
			try {
				const auth = resolveAuth(state);
				rebootAuth = auth.header;
				await restPost(
					`http://127.0.0.1:${ports.http}/rest/system/reboot`,
					rebootAuth,
					{},
					5000,
				);
			} catch {
				// Expected — connection drops during reboot
				rebootAuth ??= `Basic ${btoa("admin:")}`;
			}

			// Wait for the instance to come back up.
			// Pass resolved credentials so waitForBoot can validate the response body
			// (not just check for a connection), preventing ECONNRESET on the first
			// real REST call after the reboot completes.
			const accel = await detectAccel(state.arch);
			const timeout = defaultBootTimeout(state.arch, true, accel);
			await waitForBoot(ports.http, timeout, rebootAuth);

			// Persist installed packages to machine.json
			const current = loadMachine(state.name);
			if (current) {
				const merged = new Set([...(current.packages ?? []), ...installed]);
				current.packages = [...merged];
				saveMachine(current);
			}
			state.packages = [...new Set([...(state.packages ?? []), ...installed])];

			return installed;
		},

		async upload(localPath: string, remotePath?: string): Promise<void> {
			if (!isMachineRunning(state)) {
				throw new QuickCHRError(
					"MACHINE_STOPPED",
					`Machine "${state.name}" must be running to upload files.`,
				);
			}
			const creds = resolveCreds(state);
			await scpPush(localPath, remotePath, { sshPort: ports.ssh, ...creds });
		},

		async download(remotePath: string, localPath: string): Promise<void> {
			if (!isMachineRunning(state)) {
				throw new QuickCHRError(
					"MACHINE_STOPPED",
					`Machine "${state.name}" must be running to download files.`,
				);
			}
			const creds = resolveCreds(state);
			await scpPull(remotePath, localPath, { sshPort: ports.ssh, ...creds });
		},

		async destroy(): Promise<void> {
			await this.stop();
			await this.remove();
		},

		async subprocessEnv(): Promise<Record<string, string>> {
			const auth = resolveAuth(state);
			// auth.header is "Basic <base64>" — extract the raw user:pass.
			const rawCreds = auth.header.startsWith("Basic ")
				? Buffer.from(auth.header.slice(6), "base64").toString()
				: `${auth.user}:`;
			const restBase = `${restUrl}/rest`;
			return {
				QUICKCHR_NAME: state.name,
				QUICKCHR_REST_URL: restUrl,
				QUICKCHR_REST_BASE: restBase,
				QUICKCHR_SSH_PORT: String(ports.ssh),
				QUICKCHR_AUTH: rawCreds,
				// Legacy compat keys used by restraml and similar consumers.
				URLBASE: restBase,
				BASICAUTH: rawCreds,
			};
		},

		async queryLoad(): Promise<ChrLoadSample | null> {
			try {
				// Use QEMU monitor `info cpus` for CPU and `info balloon` for memory.
				const [cpuOut, balloonOut] = await Promise.all([
					monitorCommand(state.machineDir, "info cpus", 3000, state.portBase),
					monitorCommand(state.machineDir, "info balloon", 3000, state.portBase),
				]);
				// `info cpus` output: "* CPU #0: ... thread_id=N\n  CPU #1: ..."
				// Each CPU line contains a user/sys/idle percent breakdown — but the
				// most portable field is just thread count (always present).
				// Rough heuristic: count non-idle percentage from "info cpus" if it
				// includes timing; fall back to 0 since QEMU monitor output varies by version.
				let cpuPercent = 0;
				const cpuMatch = cpuOut.match(/\buser=(\d+)%/);
				if (cpuMatch) cpuPercent = Number(cpuMatch[1]);

				// `info balloon` output: "balloon: actual=512 MB"
				let memUsedMb = 0;
				const memMatch = balloonOut.match(/actual=(\d+)/);
				if (memMatch) memUsedMb = Number(memMatch[1]);

				return { cpuPercent, memUsedMb };
			} catch {
				return null;
			}
		},

		snapshot: {
			async list(): Promise<SnapshotInfo[]> {
				const format = state.bootDiskFormat ?? (state.bootSize ? "qcow2" : "raw");
				if (format !== "qcow2") return [];

				// Try monitor first (works on running machines, gives live state)
				if (state.status === "running") {
					try {
						const out = await monitorCommand(state.machineDir, "info snapshots", undefined, state.portBase);
						return parseSnapshotList(out);
					} catch { /* fall through to qemu-img */ }
				}

				// Fall back to qemu-img info (works on stopped machines too)
				const bootPath = join(state.machineDir, "boot.qcow2");
				if (existsSync(bootPath)) {
					return listSnapshots(bootPath);
				}
				return [];
			},

			async save(name?: string): Promise<SnapshotInfo> {
				const format = state.bootDiskFormat ?? (state.bootSize ? "qcow2" : "raw");
				if (format !== "qcow2") {
					throw new QuickCHRError("STATE_ERROR", "Snapshots require a qcow2 boot disk. Recreate with bootDiskFormat: \"qcow2\".");
				}
				if (state.status !== "running") {
					throw new QuickCHRError("MACHINE_STOPPED", `Machine "${state.name}" must be running to save a snapshot.`);
				}

				const snapName = name ?? new Date().toISOString().replace(/:/g, "-").replace(/\..+$/, "Z");
				const out = await monitorCommand(state.machineDir, `savevm ${snapName}`, undefined, state.portBase);
				if (/^error[:\s]/i.test(out)) {
					throw new QuickCHRError("PROCESS_FAILED", `savevm failed: ${out.trim()}`);
				}

				// Read back the snapshot list to return the new entry
				const snaps = await this.list();
				return snaps.find((s) => s.name === snapName) ?? {
					id: "0",
					name: snapName,
					vmStateSize: 0,
					date: new Date().toISOString(),
					vmClock: "0000:00:00.000",
				};
			},

			async load(name: string): Promise<void> {
				const format = state.bootDiskFormat ?? (state.bootSize ? "qcow2" : "raw");
				if (format !== "qcow2") {
					throw new QuickCHRError("STATE_ERROR", "Snapshots require a qcow2 boot disk.");
				}
				if (state.status !== "running") {
					throw new QuickCHRError("MACHINE_STOPPED", `Machine "${state.name}" must be running to load a snapshot.`);
				}

				const out = await monitorCommand(state.machineDir, `loadvm ${name}`, undefined, state.portBase);
				if (/^error[:\s]/i.test(out)) {
					throw new QuickCHRError("PROCESS_FAILED", `loadvm failed: ${out.trim()}`);
				}
			},

			async delete(name: string): Promise<void> {
				const format = state.bootDiskFormat ?? (state.bootSize ? "qcow2" : "raw");
				if (format !== "qcow2") {
					throw new QuickCHRError("STATE_ERROR", "Snapshots require a qcow2 boot disk.");
				}
				if (state.status !== "running") {
					throw new QuickCHRError("MACHINE_STOPPED", `Machine "${state.name}" must be running to delete a snapshot.`);
				}

				const out = await monitorCommand(state.machineDir, `delvm ${name}`, undefined, state.portBase);
				if (/^error[:\s]/i.test(out)) {
					throw new QuickCHRError("PROCESS_FAILED", `delvm failed: ${out.trim()}`);
				}
			},
		},
	};
}

/**
 * Atomically acquire an exclusive start lock for a machine directory.
 * Uses O_CREAT|O_EXCL so concurrent attempts are rejected by the OS — no TOCTOU race.
 * If the lock is stale (owning process is dead) it is silently replaced.
 * Throws MACHINE_LOCKED if the lock is held by a live process.
 */
export function acquireLock(lockPath: string): void {
	let fd: number;
	try {
		fd = openSync(lockPath, "wx"); // O_WRONLY | O_CREAT | O_EXCL — atomic
		writeSync(fd, String(process.pid));
		closeSync(fd);
		return;
	} catch {
		// File already exists — check whether owner is still alive
	}

	let ownerPid: number | undefined;
	try {
		ownerPid = Number.parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
	} catch { /* unreadable — treat as stale */ }

	if (ownerPid && !Number.isNaN(ownerPid)) {
		try {
			process.kill(ownerPid, 0); // probes liveness; throws ESRCH if process not found
			throw new QuickCHRError("MACHINE_LOCKED", `Machine is already being started (pid ${ownerPid})`);
		} catch (e) {
			if (e instanceof QuickCHRError) throw e;
			// Process is dead — stale lock, overwrite
			writeFileSync(lockPath, String(process.pid));
			return;
		}
	}

	// Owner unreadable or zero — treat as stale, overwrite
	writeFileSync(lockPath, String(process.pid));
}

/** Resolve the host architecture to a CHR architecture. */
function hostArchToChr(): Arch {
	const arch = process.arch;
	if (arch === "arm64") return "arm64";
	return "x86";
}

/** Resolve user-supplied arch (including the "auto" synonym) to a concrete Arch. */
function resolveArch(input: Arch | "auto" | undefined): Arch {
	if (input === undefined || input === "auto") return hostArchToChr();
	return input;
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch {
			return true;
		}
		await Bun.sleep(100);
	}
	return false;
}

/** Wait for CHR to boot with periodic progress status updates every 20s. */
async function waitForBootWithProgress(
	instance: ChrInstance,
	timeoutMs: number,
	log: ProgressLogger,
	label: string,
): Promise<boolean> {
	log.status(label);
	const start = Date.now();
	const progressInterval = setInterval(() => {
		const elapsedS = Math.round((Date.now() - start) / 1000);
		const remainingS = Math.max(0, Math.round((timeoutMs - (Date.now() - start)) / 1000));
		log.status(`  Still waiting for CHR to boot... (${elapsedS}s elapsed, up to ${remainingS}s remaining)`);
	}, 20_000);
	try {
		return await instance.waitForBoot(timeoutMs);
	} finally {
		clearInterval(progressInterval);
	}
}

async function hardRebootMachine(
	state: MachineState,
	launchConfig: QemuLaunchConfig,
	log: ProgressLogger,
): Promise<"monitor" | "signal"> {
	if (!state.pid) {
		throw new QuickCHRError("PROCESS_FAILED", "Cannot hard-reboot machine: missing QEMU pid");
	}

	let method: "monitor" | "signal" = "monitor";

	try {
		await monitorCommand(state.machineDir, "quit", 4000, state.portBase);
	} catch (e) {
		method = "signal";
		log.warn(`Device-mode: monitor quit failed, falling back to process terminate (${e instanceof Error ? e.message : String(e)})`);
	}

	const exited = await waitForPidExit(state.pid, 5000);
	if (!exited) {
		method = "signal";
		await stopQemu(state.pid);
	}

	const restartConfig: QemuLaunchConfig = {
		...launchConfig,
		background: true,
	};
	const qemuArgs = await buildQemuArgs(restartConfig);
	const wrapper = extractWrapper(restartConfig.networks);
	const { pid } = await spawnQemu(qemuArgs, state.machineDir, true, wrapper);
	state.pid = pid;
	state.status = "running";
	state.lastStartedAt = new Date().toISOString();
	saveMachine(state);

	return method;
}

/** Reconstruct the QEMU launch config from persisted machine state.
 *  Mirrors the logic in _launchExisting so setDeviceMode() can power-cycle
 *  a running instance without re-running the full start flow. */
async function buildLaunchConfigFromState(state: MachineState): Promise<QemuLaunchConfig> {
	const diskArtifacts = await ensureConfiguredDisks(
		state.machineDir,
		state.bootSize,
		state.extraDisks,
		state.bootDiskFormat ?? (state.bootSize ? "qcow2" : "raw"),
	);
	const platform = await detectPlatform();
	const hostfwd = buildHostfwdString(state.ports);
	const resolvedNetworks = resolveAllNetworks(state.networks, { platform }, hostfwd);
	return {
		arch: state.arch,
		machineDir: state.machineDir,
		bootDisk: diskArtifacts.bootDisk,
		extraDisks: diskArtifacts.extraDisks,
		mem: state.mem,
		cpu: state.cpu,
		ports: state.ports,
		networks: resolvedNetworks,
		background: true,
		portBase: state.portBase,
	};
}

/** Apply a device-mode change to a running CHR instance (may require hard power-cycle).
 *  Extracted from _provisionInstance so setDeviceMode() can reuse the same logic. */
async function applyDeviceMode(
	instance: ChrInstance,
	machineState: MachineState,
	resolvedDeviceMode: ReturnType<typeof resolveDeviceModeOptions>,
	launchConfig: QemuLaunchConfig,
	log: ProgressLogger,
): Promise<void> {
	const httpPort = toChrPorts(machineState.ports).http;
	const accel = await detectAccel(machineState.arch);
	const bootTimeout = defaultBootTimeout(machineState.arch, undefined, accel);
	await waitForDeviceModeApi(httpPort, 60_000);
	log.status(`Applying device-mode (${formatDeviceModeSelection(resolvedDeviceMode)})...`);

	let alreadyActive = false;
	try {
		const beforeMode = await readDeviceMode(httpPort);
		log.debug(`Device-mode before update: ${JSON.stringify(beforeMode)}`);
		alreadyActive = verifyDeviceMode(resolvedDeviceMode, beforeMode).ok;
	} catch { /* CHR unexpectedly unreachable — proceed with update */ }

	if (alreadyActive) {
		log.status("  Device-mode already active; no power-cycle required.");
		return;
	}

	const maxAttempts = 5;
	let pendingUpdate: Promise<{ status: number; body: string }> | undefined;
	let requiresPowerCycle = false;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const request = startDeviceModeUpdate(httpPort, resolvedDeviceMode);
		// RouterOS blocks this connection while waiting for hard power-cycle confirmation.
		// We race against 2s: if still pending at 2s, RouterOS has entered blocking state
		// and we can confirm by killing QEMU. If it resolves in <2s ("returned early"),
		// RouterOS hasn't committed the pending change yet — check state and retry.
		const outcome = await Promise.race([
			request
				.then((response) => ({ state: "resolved" as const, response }))
				.catch((error: unknown) => ({ state: "rejected" as const, error })),
			Bun.sleep(2000).then(() => ({ state: "pending" as const })),
		]);

		if (outcome.state === "rejected") {
			throw (outcome.error instanceof Error)
				? outcome.error
				: new QuickCHRError("PROCESS_FAILED", `Device-mode update request failed: ${String(outcome.error)}`);
		}

		if (outcome.state === "pending") {
			pendingUpdate = request;
			// Attach .catch immediately — ECONNRESET is expected when QEMU is killed
			// during the blocking power-cycle confirmation. Without this, the rejection
			// fires as "unhandled" while hardRebootMachine() is awaited.
			pendingUpdate.catch(() => {});
			requiresPowerCycle = true;
			log.debug("Device-mode update entered pending confirmation state");
			break;
		}

		log.debug(`Device-mode update response: HTTP ${outcome.response.status}`);
		await Bun.sleep(5000);

		let routerOsOffline = false;
		try {
			// Unauthenticated probe — just check if HTTP is up (webfig login page).
			await restGet(`http://127.0.0.1:${httpPort}/`, "", 2000);
		} catch {
			routerOsOffline = true;
		}

		if (routerOsOffline) {
			log.debug("Device-mode accepted — waiting for RouterOS internal reboot");
			const rebooted = await instance.waitForBoot(bootTimeout);
			if (!rebooted) {
				throw new QuickCHRError("BOOT_TIMEOUT", "RouterOS device-mode internal reboot timed out");
			}
			await waitForDeviceModeApi(httpPort, bootTimeout);
		}

		const actualNow = await readDeviceMode(httpPort);
		log.debug(`Device-mode after update attempt ${attempt}: ${JSON.stringify(actualNow)}`);
		const immediateVerification = verifyDeviceMode(resolvedDeviceMode, actualNow);
		if (immediateVerification.ok) {
			log.status("  Device-mode already active; no power-cycle required.");
			return;
		}

		if (attempt === maxAttempts) {
			throw new QuickCHRError(
				"PROCESS_FAILED",
				`Device-mode update did not activate after ${maxAttempts} attempts; last mismatch: ${immediateVerification.mismatches.join("; ")}`,
			);
		}

		log.warn(`Device-mode update returned early without activation (attempt ${attempt}/${maxAttempts}); retrying...`);
		await Bun.sleep(2000);
	}

	if (requiresPowerCycle) {
		const rebootMethod = await hardRebootMachine(machineState, launchConfig, log);
		log.status(`  Device-mode power-cycled via ${rebootMethod === "monitor" ? "QEMU monitor quit" : "process terminate"}`);

		const rebooted = await waitForBootWithProgress(instance, bootTimeout, log, "  Waiting for CHR to reboot after device-mode power-cycle...");
		if (!rebooted) {
			throw new QuickCHRError(
				"BOOT_TIMEOUT",
				`Device-mode activation reboot did not come back within ${bootTimeout / 1000}s`,
			);
		}
		await waitForDeviceModeApi(httpPort, bootTimeout);
	}

	const actual = await readDeviceMode(httpPort);
	log.debug(`Device-mode post-reboot: ${JSON.stringify(actual)}`);
	const verification = verifyDeviceMode(resolvedDeviceMode, actual);
	if (!verification.ok) {
		throw new QuickCHRError(
			"PROCESS_FAILED",
			`Device-mode verification failed after hard reboot: ${verification.mismatches.join("; ")}`,
		);
	}
	log.status(`  Device-mode verified: ${formatDeviceModeSelection(resolvedDeviceMode)}`);
}

/**
 * Main entry point for managing MikroTik CHR virtual machines via QEMU.
 *
 * All methods are static — there is no instance state on the class itself.
 * Use {@link QuickCHR.start} to create and boot a CHR, which returns a
 * {@link ChrInstance} runtime handle for interacting with it.
 *
 * @example
 * ```ts
 * const chr = await QuickCHR.start({ channel: "stable", arch: "arm64" });
 * const info = await chr.rest("/system/resource");
 * await chr.remove();
 * ```
 */
// biome-ignore lint/complexity/noStaticOnlyClass: QuickCHR is the public API — class provides a clear namespace for consumers
export class QuickCHR {
	/** Create a new CHR machine (download image, allocate ports, write config) without starting it.
	 *  Provisioning options (packages, deviceMode, user, disableAdmin) are stored in machine.json
	 *  and applied automatically on the first subsequent start(). Disk options (`bootSize`,
	 *  `extraDisks`) are materialized immediately and require `qemu-img` on the host. */
	static async add(opts: StartOptions = {}): Promise<MachineState> {
		if (opts.name?.startsWith("-")) {
			throw new QuickCHRError("INVALID_NAME", `Invalid machine name "${opts.name}" — names cannot start with "-"`);
		}

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

		const arch: Arch = resolveArch(opts.arch);
		requireQemu(arch);
		if (arch === "arm64") requireFirmware();
		const diskOpts = normalizeDiskOptions(opts.bootSize, opts.extraDisks, opts.bootDiskFormat);
		const resolvedDeviceMode = resolveDeviceModeOptions(opts.deviceMode);
		const hasDeviceModeProvisioning = shouldApplyDeviceMode(resolvedDeviceMode);

		if (hasProvisioningMutations({
			installAllPackages: opts.installAllPackages,
			packages: opts.packages,
			hasDeviceModeProvisioning,
			user: opts.user,
			disableAdmin: opts.disableAdmin,
			license: opts.license,
			secureLogin: opts.secureLogin,
		})) {
			assertProvisioningSupportedVersion(version, describeProvisioningOperation({
				installAllPackages: opts.installAllPackages,
				packages: opts.packages,
				hasDeviceModeProvisioning,
				user: opts.user,
				disableAdmin: opts.disableAdmin,
				license: opts.license,
				secureLogin: opts.secureLogin,
			}));
		}

		const existingNames = listMachineNames();
		const name = opts.name ?? generateMachineName(version, arch, existingNames);
		if (existingNames.includes(name)) {
			throw new QuickCHRError("MACHINE_EXISTS", `Machine "${name}" already exists. Use 'quickchr start ${name}' to start it.`);
		}

		const usedBases = getUsedPortBases();
		const portBase = opts.portBase ?? await findAvailablePortBlock(usedBases, opts.excludePorts, opts.extraPorts);
		validateExplicitExtraPorts(opts.extraPorts, portBase, opts.excludePorts, loadAllMachines(), name);
		const ports = buildPortMappings(portBase, opts.excludePorts, opts.extraPorts);

		const machineDir = getMachineDir(name);
		assertSufficientQuickchrStorage(`prepare CHR ${name}`);
		ensureDir(machineDir);
		const lockPath = join(machineDir, ".start-lock");
		acquireLock(lockPath);
		try {
			const cachedImg = await ensureCachedImage(version, arch);
			copyImageToMachine(cachedImg, machineDir);
			const diskArtifacts = await ensureConfiguredDisks(
				machineDir,
				diskOpts.bootSize,
				diskOpts.extraDisks,
				diskOpts.bootDiskFormat,
			);

			const state: MachineState = {
				name,
				version,
				arch,
				cpu: opts.cpu ?? 1,
				mem: defaultMem(arch, opts.mem),
				networks: resolveStartNetworks(opts.networks, opts.network),
				ports,
				packages: opts.packages ?? [],
				installAllPackages: opts.installAllPackages,
				deviceMode: opts.deviceMode,
				user: opts.user,
				disableAdmin: opts.disableAdmin,
				portBase,
				excludePorts: opts.excludePorts ?? [],
				extraPorts: opts.extraPorts ?? [],
				bootSize: diskOpts.bootSize,
				extraDisks: diskOpts.extraDisks,
				bootDiskFormat: diskArtifacts.bootDisk.format,
				createdAt: new Date().toISOString(),
				status: "stopped",
				machineDir,
			};
			saveMachine(state);
			return state;
		} finally {
			try { unlinkSync(lockPath); } catch { /* ignore */ }
		}
	}

	/**
	 * Start a new or existing CHR instance.
	 *
	 * The returned {@link ChrInstance} is REST-ready: all provisioning (packages, license,
	 * device-mode, user) has completed before this promise resolves.
	 * Callers do not need to call {@link ChrInstance.waitForBoot} again unless they have
	 * stopped and restarted the instance manually. Disk options (`bootSize`, `extraDisks`)
	 * apply when creating a new machine and require `qemu-img` on the host.
	 */
	static async start(opts: StartOptions = {}): Promise<ChrInstance> {
		// Validate name early (before any I/O) so callers get a fast, clear error
		if (opts.name?.startsWith("-")) {
			throw new QuickCHRError("INVALID_NAME", `Invalid machine name "${opts.name}" — names cannot start with "-"`);
		}

		const logger = createLogger(opts.onProgress);

		const requestedDeviceMode = opts.deviceMode;
		const resolvedDeviceMode = resolveDeviceModeOptions(requestedDeviceMode);
		for (const warning of resolvedDeviceMode.warnings) {
			logger.warn(`Device-mode: ${warning}`);
		}
		const hasDeviceModeProvisioning = shouldApplyDeviceMode(resolvedDeviceMode);

		// Resolve version
		let version: string;
		if (opts.version) {
			if ((CHANNELS as string[]).includes(opts.version)) {
				version = await resolveVersion(opts.version as Channel);
			} else if (!isValidVersion(opts.version)) {
				throw new QuickCHRError("INVALID_VERSION", `Invalid version: ${opts.version}`);
			} else {
				version = opts.version;
			}
		} else {
			const channel = opts.channel ?? "stable";
			version = await resolveVersion(channel);
		}

		if (hasProvisioningMutations({
			installAllPackages: opts.installAllPackages,
			packages: opts.packages,
			hasDeviceModeProvisioning,
			user: opts.user,
			disableAdmin: opts.disableAdmin,
			license: opts.license,
			secureLogin: opts.secureLogin,
		})) {
			assertProvisioningSupportedVersion(version, describeProvisioningOperation({
				installAllPackages: opts.installAllPackages,
				packages: opts.packages,
				hasDeviceModeProvisioning,
				user: opts.user,
				disableAdmin: opts.disableAdmin,
				license: opts.license,
				secureLogin: opts.secureLogin,
			}));
		}

		// Resolve architecture
		const arch: Arch = resolveArch(opts.arch);
		const diskOpts = normalizeDiskOptions(opts.bootSize, opts.extraDisks, opts.bootDiskFormat);

		// Check prerequisites (skip for dry-run — no QEMU needed)
		if (!opts.dryRun) {
			requireQemu(arch);
			if (arch === "arm64") {
				requireFirmware();
			}
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
			// First boot of add()-created machine: apply pending provisioning from stored state
			if (!existing.lastStartedAt) {
				const pendingOpts = {
					installAllPackages: opts.installAllPackages ?? existing.installAllPackages,
					packages: opts.packages?.length ? opts.packages : (existing.packages.length > 0 ? existing.packages : undefined),
					deviceMode: opts.deviceMode ?? existing.deviceMode,
					user: opts.user ?? existing.user,
					disableAdmin: opts.disableAdmin ?? existing.disableAdmin,
					license: opts.license,
					secureLogin: opts.secureLogin,
				};
				const hasPending = !!(
					pendingOpts.installAllPackages ||
					(pendingOpts.packages?.length ?? 0) > 0 ||
					pendingOpts.deviceMode ||
					pendingOpts.user ||
					pendingOpts.disableAdmin ||
					pendingOpts.license
				);
				if (hasPending) {
					return QuickCHR._launchExisting(existing, opts.background ?? true, pendingOpts, logger);
				}
			}
			// Exists but stopped — restart it
			return QuickCHR._launchExisting(existing, opts.background ?? true, undefined, logger);
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

		validateExplicitExtraPorts(
			opts.extraPorts,
			portBase,
			opts.excludePorts,
			loadAllMachines(),
			name,
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
				mem: defaultMem(arch, opts.mem),
				networks: resolveStartNetworks(opts.networks, opts.network),
				ports,
				packages: opts.packages ?? [],
				deviceMode: requestedDeviceMode,
				user: opts.user,
				disableAdmin: opts.disableAdmin,
				portBase,
				excludePorts: opts.excludePorts ?? [],
				extraPorts: opts.extraPorts ?? [],
				bootSize: diskOpts.bootSize,
				extraDisks: diskOpts.extraDisks,
				bootDiskFormat: diskOpts.bootDiskFormat,
				createdAt: new Date().toISOString(),
				status: "stopped",
				machineDir,
			};
			return createInstance(state);
		}

		// Acquire a lock to prevent concurrent starts of the same machine
		const machineDir = getMachineDir(name);
		assertSufficientQuickchrStorage(`start CHR ${name}`);
		ensureDir(machineDir);
		const lockPath = join(machineDir, ".start-lock");
		acquireLock(lockPath);
		try {

		// Download and prepare image
		const cachedImg = await ensureCachedImage(version, arch, undefined, logger);
		copyImageToMachine(cachedImg, machineDir);

		// Prepare disks (boot resize + extra disks)
		const diskArtifacts = await ensureConfiguredDisks(
			machineDir,
			diskOpts.bootSize,
			diskOpts.extraDisks,
			diskOpts.bootDiskFormat,
		);
		const bootDisk = diskArtifacts.bootDisk;
		const extraDiskConfigs = diskArtifacts.extraDisks;

		// Build machine config
		const background = opts.background ?? true;

		// Provisioning includes any work that requires the machine to have booted first.
		// When foreground mode is requested WITH provisioning, we must boot in background,
		// provision (packages/user/license), then attach the serial socket to stdio.
		// Without provisioning, foreground mode runs QEMU with stdio directly (classic path).
		const hasProvisioning = !!(
			opts.installAllPackages ||
			(opts.packages && opts.packages.length > 0) ||
			opts.user ||
			opts.disableAdmin ||
			opts.license ||
			hasDeviceModeProvisioning ||
			opts.secureLogin === true
		);

		const networkConfigs = resolveStartNetworks(opts.networks, opts.network);
		if (hasProvisioning && !hasUserModeNetwork(networkConfigs)) {
			throw new QuickCHRError(
				"NETWORK_UNAVAILABLE",
				"Provisioning (packages, login setup, device-mode, license) requires a user-mode network interface for localhost access. " +
				"Add a user-mode network or remove provisioning options.",
			);
		}

		const spawnInBackground = background || (!background && hasProvisioning);
		const state: MachineState = {
			name,
			version,
			arch,
			cpu: opts.cpu ?? 1,
			mem: defaultMem(arch, opts.mem),
			networks: networkConfigs,
			ports,
			packages: opts.packages ?? [],
			deviceMode: requestedDeviceMode,
			user: opts.user,
			disableAdmin: opts.disableAdmin,
			portBase,
			excludePorts: opts.excludePorts ?? [],
			extraPorts: opts.extraPorts ?? [],
			bootSize: diskOpts.bootSize,
			extraDisks: diskOpts.extraDisks,
			bootDiskFormat: bootDisk.format,
			createdAt: new Date().toISOString(),
			status: "running",
			machineDir,
		};

		// Build QEMU args and spawn
		const platform = await detectPlatform();
		const accel = await detectAccel(arch);
		registerSocketMembers(state);
		const hostfwd = buildHostfwdString(state.ports);
		const resolvedNetworks = resolveAllNetworks(state.networks, { platform }, hostfwd);

		const launchConfig: QemuLaunchConfig = {
			arch,
			machineDir,
			bootDisk,
			extraDisks: extraDiskConfigs,
			mem: state.mem,
			cpu: state.cpu,
			ports: state.ports,
			networks: resolvedNetworks,
			background: spawnInBackground,
			portBase: state.portBase,
			accel,
		};

		const qemuArgs = await buildQemuArgs(launchConfig);
		const wrapper = extractWrapper(resolvedNetworks);
		const { pid } = await spawnQemu(qemuArgs, machineDir, spawnInBackground, wrapper);

		// Foreground (no provisioning): spawnQemu blocks until QEMU exits
		if (!background && !hasProvisioning) {
			state.status = "stopped";
			state.lastStartedAt = new Date().toISOString();
			saveMachine(state);
			return createInstance(state);
		}

		state.pid = pid;
		state.lastStartedAt = new Date().toISOString();

		saveMachine(state);

		const instance = createInstance(state);

		const bootTimeout = defaultBootTimeout(arch, opts.installAllPackages, accel) + (opts.timeoutExtra ?? 0);

		// Always wait for boot in background mode — the JSDoc promises "REST-ready".
		const booted = await instance.waitForBoot(bootTimeout);
		if (!booted) {
			let qemuLogTail = "";
			try {
				const logPath = join(machineDir, "qemu.log");
				if (existsSync(logPath)) qemuLogTail = `\nqemu.log:\n${readFileSync(logPath, "utf-8").slice(-1200)}`;
			} catch { /* ignore */ }
			try { await instance.stop(); } catch { /* ignore */ }
			try { await instance.remove(); } catch { /* ignore */ }
			throw new QuickCHRError(
				"BOOT_TIMEOUT",
				`CHR did not respond within ${bootTimeout / 1000}s (accel=${accel})` +
				(hasProvisioning ? " — provisioning could not run." : ".") +
				` Machine "${name}" has been cleaned up automatically.${qemuLogTail}`,
			);
		}

		if (hasProvisioning) {
			await QuickCHR._provisionInstance(instance, state, {
				installAllPackages: opts.installAllPackages,
				packages: opts.packages,
				deviceMode: requestedDeviceMode,
				user: opts.user,
				disableAdmin: opts.disableAdmin,
				license: opts.license,
				secureLogin: opts.secureLogin,
			}, launchConfig, logger);
		}

		// Foreground + provisioning: all provisioning is done in background mode.
		// Now stop QEMU cleanly and re-launch with stdio so the user gets the real
		// QEMU mux console (Ctrl-A X to quit, Ctrl-A C for monitor — standard QEMU
		// shortcuts that are well-documented and googleable).
		if (!background && hasProvisioning) {
			await instance.stop();
			// Brief pause for QEMU to flush and release the disk image
			await Bun.sleep(1000);
			// Release lock before re-launching — _launchExisting acquires its own.
			// The outer finally block will attempt a second unlink; that is harmless.
			try { unlinkSync(lockPath); } catch { /* ignore */ }
			return QuickCHR._launchExisting(state, false, undefined, logger);
		}

			return instance;
		} catch (err) {
			// Clean up orphaned machine directory if spawn failed before machine.json was saved
			const machineJsonPath = join(machineDir, "machine.json");
			if (!existsSync(machineJsonPath)) {
				try { rmSync(machineDir, { recursive: true, force: true }); } catch { /* best effort */ }
			}
			throw err;
		} finally {
			try { unlinkSync(lockPath); } catch { /* ignore */ }
		}
	}

	/** Apply post-boot provisioning steps (packages, device-mode, license, users).
	 *  Assumes the machine has already booted and HTTP is responding. */
	static async _provisionInstance(
		instance: ChrInstance,
		machineState: MachineState,
		opts: {
			installAllPackages?: boolean;
			packages?: string[];
			deviceMode?: DeviceModeOptions;
			user?: { name: string; password: string };
			disableAdmin?: boolean;
			license?: LicenseInput;
			secureLogin?: boolean;
		},
		launchConfig: QemuLaunchConfig,
		logger?: ProgressLogger,
	): Promise<void> {
		const log = logger ?? createLogger();
		const resolvedDeviceMode = resolveDeviceModeOptions(opts.deviceMode);
		const hasDeviceModeProvisioning = shouldApplyDeviceMode(resolvedDeviceMode);
		assertProvisioningSupportedVersion(machineState.version, describeProvisioningOperation({
			installAllPackages: opts.installAllPackages,
			packages: opts.packages,
			hasDeviceModeProvisioning,
			user: opts.user,
			disableAdmin: opts.disableAdmin,
			license: opts.license,
			secureLogin: opts.secureLogin,
		}));
		for (const warning of resolvedDeviceMode.warnings) {
			log.warn(`Device-mode: ${warning}`);
		}
		const accel = await detectAccel(machineState.arch);
		const bootTimeout = defaultBootTimeout(machineState.arch, opts.installAllPackages || (opts.packages?.length ?? 0) > 0, accel);
		const chrPorts = toChrPorts(machineState.ports);

		// Give SSH a moment to start after HTTP comes up
		await Bun.sleep(2000);

		if (opts.installAllPackages) {
			const installed = await installAllPackages(machineState.version, machineState.arch, chrPorts.ssh, chrPorts.http, log);
			await waitForBootWithProgress(instance, bootTimeout, log, "  Waiting for CHR to reboot after package installation...");
			const current = loadMachine(machineState.name);
			if (current) {
				current.packages = installed;
				saveMachine(current);
			}
			machineState.packages = installed;
		} else if (opts.packages && opts.packages.length > 0) {
			const installed = await installPackages(opts.packages, machineState.version, machineState.arch, chrPorts.ssh, chrPorts.http, log);
			await waitForBootWithProgress(instance, bootTimeout, log, "  Waiting for CHR to reboot after package installation...");
			const current = loadMachine(machineState.name);
			if (current) {
				current.packages = installed;
				saveMachine(current);
			}
			machineState.packages = installed;
		}

		if (hasDeviceModeProvisioning) {
			await applyDeviceMode(instance, machineState, resolvedDeviceMode, launchConfig, log);
		}

		if (opts.license) {
			log.status("Applying CHR license...");
			const resolvedLicense = await resolveLicenseInput(opts.license);
			if (!resolvedLicense) {
				throw new QuickCHRError(
					"PROCESS_FAILED",
					"License requested but no MikroTik web credentials were available. Set MIKROTIK_WEB_ACCOUNT / MIKROTIK_WEB_PASSWORD or run 'quickchr login'.",
				);
			}
			try {
				await renewLicense(chrPorts.http, resolvedLicense, undefined, undefined, log);
				// Read back the actual applied level — RouterOS is the source of truth.
				let actualLevel: string = resolvedLicense.level ?? "p1";
				try {
					const info = await getLicenseInfo(chrPorts.http);
					if (info.level && info.level !== "free") actualLevel = info.level;
					log.debug(`License read-back: actual level=${actualLevel}`);
				} catch (e) {
					log.warn(`License read-back failed (using requested level): ${e instanceof Error ? e.message : String(e)}`);
				}
				const current = loadMachine(machineState.name);
				if (current) {
					current.licenseLevel = actualLevel as LicenseLevel;
					saveMachine(current);
				}
				machineState.licenseLevel = actualLevel as LicenseLevel;
				log.status(`  License applied: free → ${actualLevel}`);
			} catch (e) {
				if (e instanceof QuickCHRError) throw e;
				throw new QuickCHRError(
					"PROCESS_FAILED",
					`License renewal failed: ${e instanceof Error ? e.message : String(e)}`,
				);
			}
		}

		if (opts.user || opts.disableAdmin || opts.secureLogin === true) {
			const result = await provision(chrPorts.http, machineState.name, opts.user, opts.disableAdmin, opts.secureLogin, log, machineState.machineDir, machineState.portBase);
			if (result.user) {
				// Persist user info in state (password placeholder — real password in secret store)
				const current = loadMachine(machineState.name);
				if (current) {
					current.user = { name: result.user.name, password: "(stored in secrets)" };
					saveMachine(current);
				}
				machineState.user = { name: result.user.name, password: result.user.password };
				if (!opts.user) {
					// Auto-created quickchr account — credential display is handled by the caller (wizard/CLI)
					log.status(`  quickchr account created (user: ${result.user.name})`);
					log.status(`  Password saved to ${credentialStorageLabel()}`);
				}
			}
		}
	}

	/** Re-launch an existing stopped machine. */
	static async _launchExisting(
		state: MachineState,
		background: boolean,
		provisioningOpts?: {
			installAllPackages?: boolean;
			packages?: string[];
			deviceMode?: DeviceModeOptions;
			user?: { name: string; password: string };
			disableAdmin?: boolean;
			license?: LicenseInput;
			secureLogin?: boolean;
		},
		logger?: ProgressLogger,
	): Promise<ChrInstance> {
		const lockPath = join(state.machineDir, ".start-lock");
		acquireLock(lockPath);
		try {

		const diskPath = join(state.machineDir, "disk.img");
		if (!existsSync(diskPath)) {
			throw new QuickCHRError("MACHINE_NOT_FOUND", `Disk image not found for "${state.name}"`);
		}

		const diskArtifacts = await ensureConfiguredDisks(
			state.machineDir,
			state.bootSize,
			state.extraDisks,
			state.bootDiskFormat ?? (state.bootSize ? "qcow2" : "raw"),
		);
		const bootDisk = diskArtifacts.bootDisk;
		const extraDiskConfigs = diskArtifacts.extraDisks;

		const hasProvisioning = !!(
			provisioningOpts && (
				provisioningOpts.installAllPackages ||
				(provisioningOpts.packages?.length ?? 0) > 0 ||
				provisioningOpts.deviceMode ||
				provisioningOpts.user ||
				provisioningOpts.disableAdmin ||
				provisioningOpts.license ||
				provisioningOpts.secureLogin === true
			)
		);
		// Always boot in background when provisioning is needed
		const spawnBackground = hasProvisioning ? true : background;

		const platform = await detectPlatform();
		const accel = await detectAccel(state.arch);
		registerSocketMembers(state);
		const hostfwd = buildHostfwdString(state.ports);
		const resolvedNetworks = resolveAllNetworks(state.networks, { platform }, hostfwd);

		const launchConfig: QemuLaunchConfig = {
			arch: state.arch,
			machineDir: state.machineDir,
			bootDisk,
			extraDisks: extraDiskConfigs,
			mem: state.mem,
			cpu: state.cpu,
			ports: state.ports,
			networks: resolvedNetworks,
			background: spawnBackground,
			portBase: state.portBase,
			accel,
		};

		const qemuArgs = await buildQemuArgs(launchConfig);
		const wrapper = extractWrapper(resolvedNetworks);
		const { pid } = await spawnQemu(qemuArgs, state.machineDir, spawnBackground, wrapper);

		// Foreground without provisioning: spawnQemu blocks until QEMU exits
		if (!background && !hasProvisioning) {
			state.status = "stopped";
			state.lastStartedAt = new Date().toISOString();
			saveMachine(state);
			return createInstance(state);
		}

		state.pid = pid;
		state.status = "running";
		state.lastStartedAt = new Date().toISOString();
		saveMachine(state);

		const instance = createInstance(state);

		// Always wait for boot in background mode — start() promises "REST-ready".
		const bootTimeout = defaultBootTimeout(state.arch, provisioningOpts?.installAllPackages, accel);
		const booted = await instance.waitForBoot(bootTimeout);
		if (!booted) {
			let qemuLogTail = "";
			try {
				const logPath = join(state.machineDir, "qemu.log");
				if (existsSync(logPath)) qemuLogTail = `\nqemu.log:\n${readFileSync(logPath, "utf-8").slice(-1200)}`;
			} catch { /* ignore */ }
			try { await instance.stop(); } catch { /* ignore */ }
			try { await instance.remove(); } catch { /* ignore */ }
			throw new QuickCHRError(
				"BOOT_TIMEOUT",
				`CHR did not respond within ${bootTimeout / 1000}s (accel=${accel})` +
				(hasProvisioning ? " — provisioning could not run." : ".") +
				` Machine "${state.name}" has been cleaned up automatically.${qemuLogTail}`,
			);
		}

		if (hasProvisioning && provisioningOpts) {
			await QuickCHR._provisionInstance(instance, state, provisioningOpts, launchConfig, logger);
		}

		try {
			autoPruneIfOverCap({ logger: logger ? (msg) => logger.status(msg) : undefined, protectVersions: [state.version] });
		} catch { /* never propagate */ }

		return instance;
		} finally {
			try { unlinkSync(lockPath); } catch { /* ignore */ }
		}
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
				const qemuBin = requireQemu(arch);
				const ver = getQemuVersion(qemuBin);
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
		const storage = getQuickchrStorageReport();
		const cached = listCachedImages();
		checks.push({
			label: "Cache",
			status: "ok",
			detail: cached.length > 0
				? `${cached.length} image${cached.length !== 1 ? "s" : ""}, ${formatDiskSize(storage.cacheBytes)} cached`
				: "empty (0 B)",
		});

		// Machines
		const machines = refreshAllStatuses();
		const running = machines.filter((m) => m.status === "running").length;
		checks.push({
			label: "Machines",
			status: "ok",
			detail: `${machines.length} instance${machines.length !== 1 ? "s" : ""} (${running} running, ${formatDiskSize(storage.machinesBytes)} on disk)`,
		});

		let storageDetail = `${storage.path}: ${formatDiskSize(storage.freeBytes)} free; ${formatQuickchrUsage(storage)}`;
		if (storage.status === "error") {
			storageDetail += ` — below required minimum ${formatDiskSize(storage.recommendedFreeBytes)}`;
		} else if (storage.status === "warn") {
			storageDetail += ` — low headroom (target ${formatDiskSize(storage.warningFreeBytes)} free)`;
		}
		checks.push({
			label: storage.label === ".local" ? "Storage (.local)" : "Storage",
			status: storage.status,
			detail: storageDetail,
		});

		// socat (optional, for serial console piping)
		const socatPath = findCommandOnPath("socat");
		if (socatPath) {
			checks.push({
				label: "socat",
				status: "ok",
				detail: socatPath,
			});
		} else {
			checks.push({
				label: "socat",
				status: "warn",
				detail: "not found (optional, for serial console access)",
			});
		}

		// qemu-img (optional, for disk resize and extra disks)
		const qemuImgPath = findQemuImg();
		if (qemuImgPath) {
			checks.push({
				label: "qemu-img",
				status: "ok",
				detail: qemuImgPath,
			});
		} else {
			checks.push({
				label: "qemu-img",
				status: "warn",
				detail: `not found — required for --boot-size and --add-disk (${getQemuInstallHint()})`,
			});
		}

		// socket_vmnet (macOS only — rootless shared/bridged networking)
		if (process.platform === "darwin") {
			const vmnet = detectSocketVmnet();
			if (vmnet) {
				const sharedRunning = vmnet.sharedSocket
					? isSocketVmnetDaemonRunning(vmnet.sharedSocket)
					: false;
				const parts = [vmnet.client];
				if (vmnet.sharedSocket) parts.push(`shared: ${vmnet.sharedSocket}`);
				const bridgedIfaces = Object.keys(vmnet.bridgedSockets);
				if (bridgedIfaces.length > 0) parts.push(`bridged: ${bridgedIfaces.join(", ")}`);
				if (sharedRunning) {
					checks.push({
						label: "socket_vmnet",
						status: "ok",
						detail: parts.join(" — "),
					});
				} else if (vmnet.sharedSocket) {
					checks.push({
						label: "socket_vmnet",
						status: "warn",
						detail: `${vmnet.client} — installed but daemon not running. Start: sudo brew services start socket_vmnet`,
					});
				} else {
					checks.push({
						label: "socket_vmnet",
						status: "warn",
						detail: `${vmnet.client} — client found but no socket (daemon not started). Start: sudo brew services start socket_vmnet`,
					});
				}
			} else {
				checks.push({
					label: "socket_vmnet",
					status: "warn",
					detail: "not found (optional, for rootless shared/bridged networking — brew install socket_vmnet)",
				});
			}
		}

		// Orphaned machine directories (have files but no machine.json)
		const machinesDir = getMachinesDir();
		if (existsSync(machinesDir)) {
			const dirs = readdirSync(machinesDir, { withFileTypes: true })
				.filter(e => e.isDirectory());
			const orphans: string[] = [];
			for (const dir of dirs) {
				const mjPath = join(machinesDir, dir.name, "machine.json");
				if (!existsSync(mjPath)) {
					orphans.push(dir.name);
				}
			}
			if (orphans.length > 0) {
				const removeLines = orphans.map((o) => `  rm -rf ${join(machinesDir, o)}`).join("\n");
				checks.push({
					label: "Orphaned machine dirs",
					status: "warn",
					detail: `${orphans.length} dir(s) without machine.json: ${orphans.join(", ")}\nRemove manually:\n${removeLines}`,
				});
			} else {
				checks.push({
					label: "Machine state",
					status: "ok",
					detail: `${dirs.length} machine(s), no orphans`,
				});
			}
		}

		// Shell detection — always informational; useful for bug reports
		const { detectCurrentShell, shellBinary, completionStatusFor } = await import("./completions.ts");
		const shellInfo = detectCurrentShell();
		const binary = shellBinary(shellInfo);
		const shellDetail = shellInfo.version
			? `${binary} ${shellInfo.version} (${shellInfo.shell})`
			: shellInfo.shell || "unknown";
		checks.push({
			label: "Shell",
			status: "ok",
			detail: shellDetail,
		});

		// Shell completions — warn if not installed for the current shell
		if (shellInfo.supported) {
			const compStatus = completionStatusFor(binary as import("./completions.ts").SupportedShell);
			if (compStatus.installed) {
				checks.push({
					label: "Shell completions",
					status: "ok",
					detail: `${binary}: installed at ${compStatus.path}`,
				});
			} else {
				checks.push({
					label: "Shell completions",
					status: "warn",
					detail: `${binary}: not installed — run 'quickchr completions --install'`,
				});
			}
		} else {
			checks.push({
				label: "Shell completions",
				status: "warn",
				detail: `${binary || "unknown shell"}: not a supported shell (bash/zsh/fish) — manual install required`,
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
