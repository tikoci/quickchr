/**
 * QuickCHR — main API class tying together all modules.
 */

import type {
	Arch,
	Channel,
	ChrInstance,
	ChrLoadSample,
	CustomForward,
	Descriptor,
	DeviceModeOptions,
	DoctorResult,
	ExecOptions,
	ExecResult,
	LicenseInput,
	LicenseLevel,
	MachineState,
	NetworkConfig,
	NetworkTopologyEntry,
	PlatformInfo,
	PortMapping,
	ProvisioningStep,
	QgaCommand,
	ServiceEndpoint,
	SnapshotInfo,
	SshServiceEndpoint,
	StartOptions,
} from "./types.ts";
import { QuickCHRError, ARCHES, CHANNELS, SERVICE_IDS, QUICKCHR_DESCRIPTOR_VERSION, HOST_GATEWAY_IP } from "./types.ts";
import { assertValidResourceName, assertPathSafeName } from "./names.ts";
import packageJson from "../../package.json";
import { detectPlatform, requireQemu, requireFirmware, getQemuVersion, getQemuInstallHint, isCrossArchEmulation, accelTimeoutFactor, detectAccel, accelNote, resolveAccelOverrideWithSource, accelSourceLabel, findQemuImg, qgaKvmWarning, detectSocketVmnet, isSocketVmnetDaemonRunning, findCommandOnPath } from "./platform.ts";
import {
	resolveVersion,
	isValidVersion,
	generateMachineName,
	assertProvisioningSupportedVersion,
	PROVISIONING_FEATURE_LABEL,
} from "./versions.ts";
import { buildPortMappings, findAvailablePortBlock, resolveStartNetworks, resolveAllNetworks, assignMacs, buildHostfwdString, hasUserModeNetwork, validateExplicitExtraPorts, describeSocketTransport } from "./network.ts";
import {
	getUsedPortBases,
	getUsedMacs,
	saveMachine,
	loadMachine,
	loadAllMachines,
	listUnreadableMachines,
	removeMachine as removeState,
	getMachineDir,
	getMachinesDir,
	listMachineNames,
	isOrphanMachineDir,
	listOrphanMachineDirs,
	refreshAllStatuses,
	isMachineRunning,
	ensureDir,
	getCacheDir,
	getDataDir,
	appendBootLog,
} from "./state.ts";
import { ensureCachedImage, copyImageToMachine, listCachedImages } from "./images.ts";
import { autoPruneIfOverCap } from "./cache.ts";
import { resolveSetting } from "./settings.ts";
import { buildQemuArgs, spawnQemu, stopQemu, cleanupQemuSockets, waitForBoot, extractWrapper, type QemuLaunchConfig } from "./qemu.ts";
import { cleanDiskFiles, ensureConfiguredDisks, normalizeDiskOptions, parseSnapshotList, listSnapshots, formatDiskSize } from "./disk.ts";
import { monitorCommand, serialStreams, qgaCommand, channelEndpoint, channelFileExists, channelPath } from "./channels.ts";
import { captureBootFailure, newBootProbeStats, type BootFailureReport, type BootProbeStats, type FailureTrigger } from "./diagnostics.ts";
import { installPackages, installAllPackages, downloadAndListPackages, downloadPackages, findPackageFile, uploadPackages } from "./packages.ts";
import { provision } from "./provision.ts";
import { renewLicense, getLicenseInfo } from "./license.ts";
import { resolveAuth, resolveCreds } from "./auth.ts";
import { scpPush, scpPull } from "./scp.ts";
import { deleteInstanceCredentials, credentialStorageLabel, getStoredCredentials, getInstanceCredentials, STORED_IN_SECRETS_PASSWORD } from "./credentials.ts";
import { restExecute } from "./exec.ts";
import { qgaExec } from "./qga.ts";
import { consoleExec, CONSOLE_LOGIN_COST_MS } from "./console.ts";
import { restRequest, restGet, restPost } from "./rest.ts";
import { getNamedSocket, joinNamedSocket, removeSocketMember, getSocketSlot } from "./socket-registry.ts";
import { createLogger, type ProgressLogger } from "./log.ts";
import {
	describeDeviceModeChange,
	formatDeviceModeSelection,
	mergeDeviceModeOptions,
	readDeviceMode,
	resolveDeviceModeOptions,
	shouldApplyDeviceMode,
	startDeviceModeUpdate,
	verifyDeviceMode,
	waitForDeviceModeApi,
} from "./device-mode.ts";
import {
	assertProvisioningWindow,
	isProvisioningWindowOpen,
} from "./provisioning-window.ts";
import type { LicenseOptions } from "./types.ts";
import type { GuestExec } from "./guest-snapshot.ts";
import { toChrPorts } from "./network.ts";
import { assertSufficientQuickchrStorage, formatQuickchrUsage, getQuickchrStorageReport } from "./storage.ts";
import { existsSync, rmSync, copyFileSync, writeFileSync, unlinkSync, openSync, writeSync, closeSync, readFileSync } from "node:fs";
import { join } from "node:path";

// --- Architecture-aware defaults ---

/** Default mem (MiB) — more for cross-arch TCG emulation, less for native HVF/KVM. */
function defaultMem(arch: Arch, override?: number): number {
	return override ?? (isCrossArchEmulation(arch) ? 1024 : 512);
}

/** Default boot timeout — accel mode and cross-arch emulation affect how slow the VM boots. */
export function defaultBootTimeout(arch: Arch, withPackages?: boolean, accel?: string): number {
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

/** Normalize convenience aliases on StartOptions:
 *  - `noAuth: true` → `secureLogin: false` (only when secureLogin is not explicitly set).
 *  Returns a shallow copy so the caller's input object is not mutated. */
function normalizeStartOptions(opts: StartOptions): StartOptions {
	if (opts.noAuth === true && opts.secureLogin === undefined) {
		return { ...opts, secureLogin: false };
	}
	return opts;
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

/** Refuse a start that a named socket has no room for, before any I/O.
 *
 *  Only a *new* member is refused: a machine already holding an endpoint is simply
 *  restarting into its own slot. An unknown socket is left alone — `start()`
 *  auto-creates it further down. */
function assertNamedSocketsHaveRoom(opts: StartOptions, logger: ProgressLogger): void {
	const named = resolveStartNetworks(opts.networks, opts.network)
		.map((n) => n.specifier)
		.filter((spec): spec is { type: "socket"; name: string } =>
			typeof spec === "object" && spec !== null && spec.type === "socket");
	for (const { name } of named) {
		const entry = getNamedSocket(name);
		if (!entry?.endpoints) continue;
		if (opts.name && entry.endpoints.includes(opts.name)) continue;
		if (entry.endpoints.includes(null)) continue;
		const held = entry.endpoints.filter((m): m is string => m !== null);
		logger.debug(`socket::${name} endpoints held by ${held.join(", ")}`);
		throw new QuickCHRError(
			"NETWORK_UNAVAILABLE",
			`Named socket "${name}" is a ${entry.mode} link and carries 2 machines; ` +
			`${held.join(" and ")} already hold both ends. ` +
			`Stop one of them, or create an N-way segment with 'quickchr networks sockets create <name> --mode mcast'.`,
		);
	}
}

/** QEMU version for the binary this machine's arch will run on, when it can be read.
 *  `-netdev dgram` needs 7.2, and a named socket should say so rather than failing at
 *  spawn with a netdev QEMU does not recognize. */
function qemuVersionForArch(platform: PlatformInfo, arch: Arch): string | undefined {
	const bin = arch === "arm64" ? platform.qemuBinArm64 : platform.qemuBinX86;
	return bin ? getQemuVersion(bin) : undefined;
}

function registerSocketMembers(state: MachineState): void {
	for (const name of getSocketNamedNetworks(state)) {
		try {
			// Create-if-missing and join under one registry lock: two concurrent starts
			// both pass a test-then-create, and both then claim the same endpoint slot.
			joinNamedSocket(name, state.name, { autoCreated: true });
		} catch (e) {
			// A full two-member link is a refusal, not a warning: carrying on would spawn
			// QEMU with no endpoint to bind, and on a `dgram` link a second machine
			// binding the same path unlinks the first one's socket and steals the link
			// with nothing logged on either side.
			if (e instanceof QuickCHRError && e.code === "NETWORK_UNAVAILABLE") throw e;
			console.warn(`Warning: failed to register socket member "${state.name}" on "${name}": ${e instanceof Error ? e.message : String(e)}`);
		}
	}
}

/** Report the transport each named socket resolved to.
 *
 *  #158's acceptance bar: nothing about a named socket should require opening a file
 *  under the data dir. The field report that produced these issues had to read
 *  `machine.json` to discover its link was UDP multicast, after ping had already
 *  failed silently. */
function reportSocketTransports(state: MachineState, logger: ProgressLogger): void {
	for (const name of getSocketNamedNetworks(state)) {
		const entry = getNamedSocket(name);
		if (!entry) continue;
		logger.status(`  Network socket::${name}: ${describeSocketTransport(entry, getSocketSlot(entry, state.name))}`);
	}
}

/** Claim each named socket's endpoint, then resolve — releasing the claims if
 *  resolution fails.
 *
 *  Membership is persisted *before* networks resolve, because the resolver needs to
 *  know which end this machine holds. So a resolution that throws — a `dgram` link on
 *  Windows, or on a QEMU older than 7.2 — would otherwise leave the machine holding an
 *  endpoint it never used, and two failed starts would fill a link with machines that
 *  are not running. */
export function registerAndResolveNetworks(
	state: MachineState,
	ctx: { platform: PlatformInfo; qemuVersion?: string },
	hostfwd: string,
): NetworkConfig[] {
	try {
		// Inside the try, not before it: this claims one endpoint per named socket, so a
		// machine on two links whose second link is full would otherwise keep the first
		// claim — and the caller cannot clean it either, since it only learns about the
		// claim once this returns.
		registerSocketMembers(state);
		return resolveAllNetworks(state.networks, { ...ctx, machine: state.name }, hostfwd);
	} catch (e) {
		unregisterSocketMembers(state);
		throw e;
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
	const buildEnv = (): Record<string, string> => {
		const creds = resolveCreds(state);
		const rawCreds = `${creds.user}:${creds.password}`;
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
	};
	// Service keys beyond these five are surfaced as `customForwards` (winbox, plus
	// any user-added extraPorts) — see docs/centrs-interface.md "CustomForward".
	const CANONICAL_PORT_NAMES = new Set(["http", "https", "api", "api-ssl", "ssh"]);

	const buildDescriptor = (): Descriptor => {
		if (state.status !== "running") {
			throw new QuickCHRError(
				"MACHINE_STOPPED",
				`Machine "${state.name}" must be running to inspect its connection environment (current status: ${state.status}).`,
			);
		}

		const auth = resolveAuth(state);
		const creds = resolveCreds(state);
		const basic = `${creds.user}:${creds.password}`;
		const storedCreds = getInstanceCredentials(state.name);
		// resolveAuth/resolveCreds never throw — when disableAdmin is true and no
		// provisioned/stored user exists, they still fall back to the meaningless
		// admin:"" tuple (auth.ts docstring: "the caller will get a 401"). Don't
		// report a service available:true off that fallback alone.
		const disableAdminLockout = state.disableAdmin === true && !state.user && !storedCreds;
		// A provisioned user whose password is the STORED_IN_SECRETS_PASSWORD sentinel
		// only resolves a real password when the per-instance credential store actually
		// has an entry — otherwise resolveAuth/resolveCreds fall through to returning the
		// literal sentinel string as the "password". Don't report available:true (or leak
		// the sentinel as a usable password) off that unresolvable case either, regardless
		// of disableAdmin.
		const sentinelUnresolvable = state.user?.password === STORED_IN_SECRETS_PASSWORD && !storedCreds;
		const credentialsAvailable = !disableAdminLockout && !sentinelUnresolvable;

		const buildHttpService = (
			securePM: PortMapping | undefined,
			plainPM: PortMapping | undefined,
			serviceLabel: string,
			scheme: { secure: string; plain: string },
			authObj: { username: string; password?: string; basic?: string; header?: string },
			urlSuffix = "",
		): ServiceEndpoint => {
			// Plain-first (#95): on a stock CHR the TLS services are not dialable —
			// `www-ssl` is disabled and `api-ssl` is certificate-less (TLS alert 40) —
			// so preferring the secure forward advertised dead endpoints. Prefer the
			// plain forward for each service; the secure forward remains the fallback
			// so excluded plain ports still resolve when a secure forward is available
			// (with `tls: true`). Secure preference can return once boot provisioning
			// installs a certificate and enables www-ssl.
			const chosen = plainPM ?? securePM;
			if (!chosen) {
				return { available: false, unavailableReason: `no forwarded port for ${serviceLabel}` };
			}
			const tls = chosen === securePM;
			const echo = {
				host: "127.0.0.1",
				port: chosen.host,
				guestPort: chosen.guest,
				transport: chosen.proto,
				tls,
				url: `${tls ? scheme.secure : scheme.plain}://127.0.0.1:${chosen.host}${urlSuffix}`,
				source: { provider: "quickchr" as const, portMappingName: chosen.name },
			};
			if (!credentialsAvailable) {
				return { available: false, unavailableReason: "admin disabled, no user provisioned", ...echo };
			}
			return { available: true, ...echo, auth: authObj };
		};

		// Preference order lives in buildHttpService (plain-first, #95); this also
		// keeps the excludePorts fix: excluding "http" while keeping "https" now
		// resolves rest-api onto the surviving secure port instead of a port that
		// doesn't exist.
		const restApi = buildHttpService(
			state.ports.https,
			state.ports.http,
			"rest-api",
			{ secure: "https", plain: "http" },
			{ username: creds.user, password: creds.password, basic, header: auth.header },
			"/rest",
		);
		const nativeApi = buildHttpService(
			state.ports["api-ssl"],
			state.ports.api,
			"native-api",
			{ secure: "tls", plain: "tcp" },
			{ username: creds.user, password: creds.password },
		);

		const sshPM = state.ports.ssh;
		const sshUsername = state.user?.name ?? "admin";
		const managedKey = state.managedSshKey;
		const batchVerified = managedKey?.batchVerified === true;
		const sshModes: Array<"private-key" | "agent-or-config" | "password"> = [];
		if (managedKey) sshModes.push("private-key");
		sshModes.push("agent-or-config");
		if (credentialsAvailable) sshModes.push("password");

		const sshService: SshServiceEndpoint = !sshPM
			? { available: false, unavailableReason: "no forwarded port for ssh" }
			: {
					available: true,
					host: "127.0.0.1",
					port: sshPM.host,
					guestPort: sshPM.guest,
					transport: sshPM.proto,
					tls: false,
					url: `ssh://${sshUsername}@127.0.0.1:${sshPM.host}`,
					source: { provider: "quickchr" as const, portMappingName: "ssh" },
					auth: {
						username: sshUsername,
						...(batchVerified && managedKey ? { privateKeyPath: managedKey.privateKeyPath } : {}),
						modes: sshModes,
						// Only "private-key" is ever vouched for here, and only once verified —
						// "agent-or-config" is host ssh-agent/~/.ssh/config policy quickchr has
						// no way to check, so it stays out of batchModes (Done-when's own
						// unverified/absent-key example expects batchModes: [], not
						// ["agent-or-config"]).
						batchModes: batchVerified ? ["private-key"] : [],
						passwordAvailable: credentialsAvailable,
					},
				};

		const customForwards: CustomForward[] = Object.entries(state.ports)
			.filter(([name]) => !CANONICAL_PORT_NAMES.has(name))
			.map(([name, pm]) => ({
				name,
				transport: pm.proto,
				host: "127.0.0.1",
				hostPort: pm.host,
				guestPort: pm.guest,
			}));

		const networks: NetworkTopologyEntry[] = state.networks.map((n) => ({ id: n.id, specifier: n.specifier }));

		return {
			descriptorVersion: QUICKCHR_DESCRIPTOR_VERSION,
			quickchr: { packageVersion: packageJson.version },
			status: "running",
			name: state.name,
			version: state.version,
			arch: state.arch,
			cpu: state.cpu,
			mem: state.mem,
			pid: state.pid ?? null,
			machineDir: state.machineDir,
			createdAt: state.createdAt,
			lastStartedAt: state.lastStartedAt ?? null,
			services: {
				[SERVICE_IDS.restApi]: restApi,
				[SERVICE_IDS.nativeApi]: nativeApi,
				[SERVICE_IDS.ssh]: sshService,
			},
			...(customForwards.length > 0 ? { customForwards } : {}),
			networks,
		};
	};

	return {
		name: state.name,
		state,
		ports,
		restUrl,
		sshPort: ports.ssh,
		portBase: state.portBase,
		captureInterface: process.platform === "darwin" ? "lo0" : "any",
		hostGatewayIp: HOST_GATEWAY_IP,
		// Deprecated alias for hostGatewayIp (#26) — same value, removed no earlier
		// than the next minor.
		tzspGatewayIp: HOST_GATEWAY_IP,

		async waitForBoot(timeoutMs?: number, stats?: BootProbeStats): Promise<boolean> {
			// Use resolved credentials so waitForBoot can validate the response body
			// on authenticated machines (post-provisioning, post-install reboots).
			const auth = resolveAuth(state);
			return waitForBoot(ports.http, timeoutMs, auth.header, stats);
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
			// Same invariant as stop()/remove(): a machine that is not running holds no
			// endpoint. clean() stops QEMU directly rather than through stop(), so without
			// this a cleaned machine keeps a pair link occupied and blocks its removal.
			unregisterSocketMembers(state);
			// NOTE: clean() deliberately does NOT delete efi-vars.fd. On the arm64 `virt`
			// machine that file stores UEFI boot order (Boot0000 -> first virtio-blk-pci
			// disk), not OS state; wiping it forces a full device scan (~480s) on the next
			// boot. The fresh disk re-copy below is a sufficient factory reset. Regression
			// anchor: the "clean() resets disk to factory defaults" arm64 integration test
			// (120s reboot wait would blow past 480s if the wipe were reintroduced).
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

			// Every guest-side credential went with the old disk, so the credential
			// facts in machine.json now describe a machine that no longer exists.
			// Nothing re-provisions them either: a post-clean() start() takes the
			// `_launchExisting(…, undefined)` path (lastStartedAt is set), so the
			// erased account is never recreated. Left in place, `resolveAuth()` /
			// `resolveCreds()` prefer `state.user` and authenticate every REST call,
			// exec, and SCP as a deleted user — the confound #79 removes here.
			// Clearing them restores the documented fallback: factory `admin` with an
			// empty password, which is what a fresh CHR image actually answers to
			// (anchored by the "clean() resets disk to factory defaults" integration
			// test). `disableAdmin` goes with them because it is read as a live fact
			// about the guest (buildDescriptor's `disableAdminLockout`) and a fresh
			// image has admin enabled again. `licenseLevel` goes with them for the same
			// reason: it is a read-back of the license the erased disk held, not an
			// intent — quickchr never persists the license *input* — so leaving it
			// behind would report a level the fresh image does not have. Provisioning
			// *intent* — packages, deviceMode, secureLogin — is not guest state and
			// survives, and is what the next `start()` re-applies now that the window
			// reopens.
			deleteInstanceCredentials(state.name);
			// The managed keypair authenticated to the account factory reset erased,
			// so it is dead credential material sitting in the machine dir. Removing
			// it also keeps a future re-provision viable: `ssh-keygen -f <path>` on an
			// existing file exits 1 with "already exists" rather than overwriting
			// (verified locally), so a leftover key would break `installSshKey()`.
			rmSync(join(state.machineDir, "ssh"), { recursive: true, force: true });

			// Update state. `provisioning` and `lastStartedAt` go with the credentials:
			// both describe a guest that no longer exists, and together they are what
			// closes the provisioning window. Leaving them behind is what stopped a cleaned
			// machine from ever being provisioned again — the disk was factory-fresh and
			// `start()` still refused to provision it (#176). `cleanedAt` keeps the
			// forensic clue that the timestamp carried.
			const cleanedAt = new Date().toISOString();
			const current = loadMachine(state.name);
			if (current) {
				current.status = "stopped";
				current.pid = undefined;
				current.user = undefined;
				current.managedSshKey = undefined;
				current.disableAdmin = undefined;
				current.provisioning = undefined;
				current.lastStartedAt = undefined;
				current.licenseLevel = undefined;
				current.cleanedAt = cleanedAt;
				saveMachine(current);
			}
			state.status = "stopped";
			state.pid = undefined;
			state.user = undefined;
			state.managedSshKey = undefined;
			state.disableAdmin = undefined;
			state.provisioning = undefined;
			state.lastStartedAt = undefined;
			state.licenseLevel = undefined;
			state.cleanedAt = cleanedAt;
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
			if (!shouldApplyDeviceMode(resolved)) {
				throw new QuickCHRError(
					"INVALID_ARGUMENT",
					`Nothing to set: device-mode options for "${state.name}" resolved to no change ` +
					"(mode=skip disables device-mode entirely; pass a mode or a feature to enable/disable).",
				);
			}
			assertDeviceModeApplicable(state);
			const launchConfig = await buildLaunchConfigFromState(state);
			await applyDeviceMode(this as ChrInstance, state, resolved, launchConfig, log);
			// Persist what is now true of the guest: the applied selection folded into
			// what was already recorded, not the request on its own. Device-mode updates
			// are cumulative — only the settings a request names move — so overwriting
			// would leave `machine.json` describing a machine that does not exist.
			const deviceMode = mergeDeviceModeOptions(state.deviceMode, resolved);
			const current = loadMachine(state.name);
			if (current) {
				current.deviceMode = deviceMode;
				saveMachine(current);
			}
			state.deviceMode = deviceMode;
			// This is quickchr applying a provisioning step, so it belongs in the record
			// the window reads (#176). It does not reopen the window — it adds the one
			// step that just ran, so a later `start` passing the same device-mode is
			// recognised as already applied instead of refused.
			recordProvisioningStep(state, "deviceMode");
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
			return buildEnv();
		},

		async descriptor(): Promise<Descriptor> {
			return buildDescriptor();
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

				// Read back the snapshot list — the new entry MUST be there. A
				// fabricated fallback here once masked savevm failing outright on
				// arm64 (#31): the example printed a snapshot that never existed.
				const snaps = await this.list();
				const created = snaps.find((s) => s.name === snapName);
				if (!created) {
					// Self-grounding error: include the raw monitor listing so a CI
					// failure carries the evidence (QEMU output formats vary by version
					// and a parse gap here looks identical to a real savevm failure).
					let rawList = "(unavailable)";
					try {
						rawList = await monitorCommand(state.machineDir, "info snapshots", undefined, state.portBase);
					} catch { /* keep placeholder */ }
					throw new QuickCHRError(
						"PROCESS_FAILED",
						`savevm reported no error but snapshot "${snapName}" is absent from the parsed list — ` +
							`treat as failed. savevm said: "${out.trim() || "(empty)"}"; raw 'info snapshots': "${rawList}"`,
					);
				}
				return created;
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
					// A failed loadvm leaves the VM in "paused (restore-vm)" — resume
					// it so the guest isn't wedged (REST dead) on top of the error.
					try {
						await monitorCommand(state.machineDir, "cont", undefined, state.portBase);
					} catch (contErr) {
						// Best effort — the throw below is the real signal, but a failed
						// resume means the VM may still be paused; say so.
						console.warn(
							`quickchr: 'cont' after failed loadvm also failed (${contErr instanceof Error ? contErr.message : String(contErr)}) — machine "${state.name}" may be paused`,
						);
					}
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

/** Where boot-failure reports land: `<dataDir>/failures/`, deliberately outside
 *  any machine directory so `remove()` — which every integration test calls from
 *  its `finally` — cannot delete the evidence it was written to explain (#79). */
function bootFailureReportDir(): string {
	return join(getDataDir(), "failures");
}

/**
 * How long one credential candidate gets inside a single guest-exec call.
 *
 * `timeoutMs` is a budget for the whole call, not per attempt: `captureGuestSnapshot()`
 * sizes its own budget assuming one exec costs at most what it passed in, so N
 * candidates × the full timeout would spend the snapshot's entire budget on the
 * first query. Untried candidates therefore share it, and once a credential is
 * known to work it gets all of it — which is every query after the first.
 *
 * The floor is {@link CONSOLE_LOGIN_COST_MS} rather than a round number, because
 * a share below the cost of a login cannot succeed **by construction** — and a
 * candidate that can never succeed also never becomes the working one, so every
 * later query repeats the same doomed division. The floor used to be 5 s against
 * a measured 11.4 s login, which is why forensics reported "console unreachable"
 * for guests that were answering serial in 10 ms (#69). A share this large is
 * affordable only because `captureGuestSnapshot()` adds a login allowance to its
 * query budget until the console answers; see `GUEST_LOGIN_ALLOWANCE_MS`.
 *
 * Exported for tests: this is the arithmetic the #69/B10 fix turns on, and it is
 * otherwise reachable only through a live serial socket.
 */
export function credentialShareMs(timeoutMs: number, candidateCount: number, haveWorking: boolean): number {
	if (haveWorking) return timeoutMs;
	return Math.max(CONSOLE_LOGIN_COST_MS, Math.floor(timeoutMs / Math.max(1, candidateCount)));
}

/** Serial-console executor for boot forensics, or null when there is no serial
 *  channel to talk to (foreground runs, or QEMU never got far enough).
 *
 *  Which account works depends on how far the failed boot got: a machine that
 *  timed out before provisioning — and any machine after `clean()` — is factory
 *  fresh and answers only to `admin` with an empty password, while a relaunch of
 *  an already-provisioned machine needs its stored credentials. Rather than
 *  guess, candidates are tried in order and the first that reaches a prompt is
 *  reused for the rest of the snapshot. */
function bootFailureGuestExec(state: MachineState): { exec: GuestExec; users: string[] } | null {
	if (!channelFileExists(channelPath(state.machineDir, "serial"))) return null;

	// Order matters only for speed — a wrong candidate costs a ~15 s login timeout
	// before the next is tried. Stored credentials are the strongest evidence the
	// machine is provisioned (provisioning stores them on success), so they lead;
	// factory admin comes next because a cleaned machine has neither (`clean()`
	// clears both the stored credentials and `state.user`), leaving `state.user`
	// as the weakest case: a user configured on the machine but never provisioned
	// onto the guest.
	const candidates: { user: string; password: string }[] = [];
	// Guarded even though secrets.ts already swallows unreadable/corrupt stores:
	// this runs on the BOOT_TIMEOUT path *before* captureBootFailure(), so
	// anything thrown here would replace the forensics report with an unrelated
	// error — the exact failure mode the diagnostics modules exist to avoid.
	let stored: { user: string; password: string } | null = null;
	try {
		stored = getInstanceCredentials(state.name);
	} catch { /* no stored credentials — fall through to the other candidates */ }
	if (stored) candidates.push(stored);
	candidates.push({ user: "admin", password: "" });
	if (state.user && state.user.name !== "admin" && state.user.password !== STORED_IN_SECRETS_PASSWORD) {
		candidates.push({ user: state.user.name, password: state.user.password });
	}

	let working: { user: string; password: string } | undefined;
	const exec: GuestExec = async (command, timeoutMs) => {
		const order = working ? [working, ...candidates.filter((c) => c !== working)] : candidates;
		const deadline = Date.now() + timeoutMs;
		const share = credentialShareMs(timeoutMs, order.length, working !== undefined);
		let lastError: unknown = new Error("no credential candidates");
		for (const cred of order) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) break;
			try {
				const { output, framed } = await consoleExec(
					state.machineDir, command, cred.user, cred.password, Math.min(share, remaining), state.portBase,
				);
				working = cred;
				return { output, framed };
			} catch (e) {
				lastError = e;
			}
		}
		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	};

	return { exec, users: candidates.map((c) => c.user) };
}

/**
 * Capture the boot-failure evidence set for a machine that is **already
 * running** — a request that failed after the machine was declared REST-ready.
 *
 * Same instruments as the BOOT_TIMEOUT path (guest snapshot, per-port slirp
 * classification, monitor state, QEMU liveness, embedded logs), because #69's
 * one-line `ECONNRESET` has never been enough to say whether the reset came from
 * the client, RouterOS `www`, or slirp — and every one of those instruments
 * answers a different part of that. What it does *not* share is the boot
 * budget's excuse for the machine looking healthy: {@link FailureTrigger} is
 * required here, so the report always records which request died and what
 * changed just before it.
 *
 * Does not stop, remove, or otherwise touch the machine — the caller owns its
 * lifecycle and may well want to keep testing against it. Never throws;
 * `captureBootFailure()` swallows its own failures.
 *
 * One trace it does leave, and the reason that matters more here than on the
 * boot path: the guest snapshot logs in over the serial console, and a RouterOS
 * console login survives the host socket closing. A boot-timeout capture is
 * followed by `stop()`/`remove()`, so nothing outlives it; here the machine
 * keeps running. Harmless — `consoleExec()` `/quit`s a session belonging to a
 * different user before it logs in — but a later console interaction on this
 * machine starts from an already-logged-in prompt, not a `Login:` one.
 */
export async function captureRunningFailure(
	state: MachineState,
	phase: string,
	trigger: FailureTrigger,
): Promise<BootFailureReport> {
	// Approximate, and labelled as such in the field docs: lastStartedAt is
	// stamped at spawn and lastBootMs measured from just before it, so their sum
	// is REST-ready to within the few ms between those two statements. Both are
	// absent on a machine that never completed a timed boot, in which case the
	// field is simply omitted rather than guessed at.
	const readyAt = state.lastStartedAt !== undefined && state.lastBootMs !== undefined
		? Date.parse(state.lastStartedAt) + state.lastBootMs
		: undefined;
	const guest = bootFailureGuestExec(state);
	return await captureBootFailure({
		name: state.name,
		machineDir: state.machineDir,
		arch: state.arch,
		accel: state.lastAccel ?? "unknown",
		pid: state.pid,
		httpPort: state.ports.http?.host,
		portBase: state.portBase,
		phase,
		trigger: {
			...trigger,
			sinceReadyMs: trigger.sinceReadyMs
				?? (readyAt !== undefined && Number.isFinite(readyAt) ? Date.now() - readyAt : undefined),
		},
		reportDir: bootFailureReportDir(),
		monitorQuery: (cmd) => monitorCommand(state.machineDir, cmd, 3000, state.portBase),
		forwards: Object.values(state.ports),
		guestExec: guest?.exec,
		guestUser: guest?.users.join(" → "),
	});
}

/** Tear down a machine that failed to boot, and describe what was done.
 *
 *  Default is full cleanup — a failed `start()` must not leave a half-dead
 *  machine behind for the next call to trip over. QUICKCHR_PRESERVE_ON_FAILURE=1
 *  inverts that for **local** debugging: the QEMU process is still stopped (it is
 *  wedged, and its port block must be released), but the machine directory
 *  survives so it can be inspected by hand.
 *
 *  Evidence does not depend on that flag, and CI deliberately does not set it —
 *  `captureBootFailure()` has already written its report outside the machine dir
 *  with qemu.log and serial.log embedded, so cleanup cannot destroy it (#79). */
async function cleanupAfterBootFailure(
	instance: ChrInstance,
	name: string,
	failure: BootFailureReport,
): Promise<string> {
	try { await instance.stop(); } catch { /* ignore */ }
	if (failure.preserved) {
		return ` Machine "${name}" was preserved for diagnosis (QUICKCHR_PRESERVE_ON_FAILURE=1) — remove it with \`quickchr remove ${name}\`.`;
	}
	try { await instance.remove(); } catch { /* ignore */ }
	return ` Machine "${name}" has been cleaned up automatically.`;
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
	const resolvedNetworks = resolveAllNetworks(
		state.networks,
		{ platform, machine: state.name, qemuVersion: qemuVersionForArch(platform, state.arch) },
		hostfwd,
	);
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

/** Persist what provisioning landed on the current disk, in state and on disk.
 *  A run with nothing to do still records — an empty `steps` says "provisioning ran
 *  and had nothing to apply", which is a different fact from never having run. */
function recordProvisioning(state: MachineState, steps: ProvisioningStep[]): void {
	const record = { at: new Date().toISOString(), steps };
	const current = loadMachine(state.name);
	if (current) {
		current.provisioning = record;
		saveMachine(current);
	}
	state.provisioning = record;
}

/** Add one step to the provisioning record, keeping whatever is already there.
 *
 *  `recordProvisioning()` stamps a whole first-boot run; this is for a step applied on
 *  its own afterwards — `setDeviceMode()` today, `installPackage()` when #24 lands.
 *  `steps` accumulates and `at` moves to now, which is what `ProvisioningRecord`
 *  promises: the last time quickchr applied provisioning to this disk.
 *
 *  It cannot reopen or close a window by accident. The only caller requires a running
 *  machine, and a running machine has `lastStartedAt`, so the window was already shut
 *  before this wrote anything. */
function recordProvisioningStep(state: MachineState, step: ProvisioningStep): void {
	const steps = [...new Set([...(state.provisioning?.steps ?? []), step])];
	const record = { at: new Date().toISOString(), steps };
	const current = loadMachine(state.name);
	if (current) {
		current.provisioning = record;
		saveMachine(current);
	}
	state.provisioning = record;
}

/** Preconditions a post-boot device-mode change inherits from provisioning.
 *
 *  Both were undocumented and both fail confusingly when unchecked (#176):
 *  `applyDeviceMode()` polls `waitForDeviceModeApi` before it does anything, so a
 *  stopped machine spends 60 s to report a timeout, and a machine with no user-mode
 *  NIC has no localhost route to REST at all and never recovers.
 *
 *  This is the same guard `start()` applies to provisioning, moved to the one step
 *  that may also run afterwards. */
function assertDeviceModeApplicable(state: MachineState): void {
	if (!isMachineRunning(state)) {
		throw new QuickCHRError(
			"MACHINE_STOPPED",
			`Device-mode is applied through the guest's REST API, so "${state.name}" has to be running. ` +
			`Start it with 'quickchr start ${state.name}', then set device-mode.`,
		);
	}
	if (!hasUserModeNetwork(state.networks)) {
		throw new QuickCHRError(
			"NETWORK_UNAVAILABLE",
			`Device-mode is applied over localhost REST, which needs a user-mode network interface — ` +
			`"${state.name}" has none, so quickchr cannot reach its REST API. ` +
			"Recreate the machine with a user-mode NIC alongside its other networks.",
		);
	}
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
		// Say what the power cycle is buying before spending it. `mode` moves as a
		// side-effect of enabling a feature — `--device-mode-enable container` resolves
		// `auto` to `rose` — and a change nobody asked for should at least be announced
		// (#176).
		for (const change of describeDeviceModeChange(resolvedDeviceMode, beforeMode)) {
			log.status(`  ${change}`);
		}
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
		opts = normalizeStartOptions(opts);
		// add() always creates, so the full name rules apply before any I/O.
		if (opts.name !== undefined) assertValidResourceName(opts.name, "machine");

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
			// A directory with no readable machine.json is a half-created machine, not a
			// machine — `list` cannot show it and `start` cannot boot it, so saying
			// "already exists" sends the user looking for something that is not there (#155).
			throw isOrphanMachineDir(name)
				? new QuickCHRError(
					"MACHINE_EXISTS",
					`Machine "${name}" has a leftover directory with no readable machine.json — a create that did not finish. Clear it with 'quickchr remove ${name}', then retry.`,
				)
				: new QuickCHRError("MACHINE_EXISTS", `Machine "${name}" already exists. Use 'quickchr start ${name}' to start it.`);
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
				networks: assignMacs(name, resolveStartNetworks(opts.networks, opts.network), getUsedMacs()),
				ports,
				packages: opts.packages ?? [],
				installAllPackages: opts.installAllPackages,
				deviceMode: opts.deviceMode,
				user: opts.user,
				disableAdmin: opts.disableAdmin,
				secureLogin: opts.secureLogin,
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
		} catch (err) {
			// A failed create must leave nothing behind: the directory exists from this
			// call's ensureDir(), and without readable state it is invisible to `list`
			// and unremovable by `remove` while still blocking re-add (#155).
			//
			// The test is "no *readable* machine.json", not "no machine.json" — a
			// saveMachine() that died mid-write (disk full) leaves a truncated file, and
			// a file-exists check would take that for a finished machine and strand the
			// directory it was supposed to clean up. Nothing runs after saveMachine()
			// but `return state`, so a readable file here means the create succeeded.
			if (isOrphanMachineDir(name)) {
				try { rmSync(machineDir, { recursive: true, force: true }); } catch { /* best effort */ }
			}
			throw err;
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
		opts = normalizeStartOptions(opts);
		// Cheap guard before any I/O: a name that reads as a flag is always a mistake.
		// The full charset rules are applied below, but only when this call creates the
		// machine — a machine named under the older, looser rules must still start.
		if (opts.name?.startsWith("-")) {
			throw new QuickCHRError("INVALID_NAME", `Invalid machine name "${opts.name}" — names cannot start with "-" (it would be read as a flag)`);
		}

		const logger = createLogger(opts.onProgress);

		// Before any download or disk work: a named socket whose two ends are already
		// taken cannot carry this machine, and #156's rule is that a start that cannot
		// succeed should not first fetch 43 MB.
		assertNamedSocketsHaveRoom(opts, logger);

		const requestedDeviceMode = opts.deviceMode;
		const resolvedDeviceMode = resolveDeviceModeOptions(requestedDeviceMode);
		for (const warning of resolvedDeviceMode.warnings) {
			logger.warn(`Device-mode: ${warning}`);
		}
		const hasDeviceModeProvisioning = shouldApplyDeviceMode(resolvedDeviceMode);

		// Resolve version
		let version: string;
		if (opts.version) {
			if ((CHANNELS as readonly string[]).includes(opts.version)) {
				logger.warn(
					`'${opts.version}' is a channel name, not a version — passed as 'version' but resolved as a channel. Use 'channel: "${opts.version}"' instead to make this explicit.`,
				);
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
		// Only a *new* name has to satisfy the current rules — see the guard at the top.
		if (!existingNames.includes(name)) assertValidResourceName(name, "machine");

		// Check if machine already exists
		const existing = loadMachine(name);
		if (existing) {
			// Both paths below re-launch a guest quickchr did not just create, so neither
			// can run provisioning. Refuse before either of them: dropping the options in
			// silence is what #176 removes, and the running-machine path is the quieter of
			// the two — it returns a handle without so much as a boot.
			const satisfied = assertProvisioningWindow(existing, {
				installAllPackages: opts.installAllPackages,
				packages: opts.packages,
				deviceMode: opts.deviceMode,
				user: opts.user,
				disableAdmin: opts.disableAdmin,
				license: opts.license,
				secureLogin: opts.secureLogin,
			});
			for (const ask of satisfied) {
				(logger ?? createLogger()).status(`${ask.description} is already applied — nothing to do.`);
			}
			if (isMachineRunning(existing)) {
				return createInstance(existing);
			}
			// First boot of add()-created machine: apply pending provisioning from stored state
			if (isProvisioningWindowOpen(existing)) {
				const pendingOpts = {
					installAllPackages: opts.installAllPackages ?? existing.installAllPackages,
					packages: opts.packages?.length ? opts.packages : (existing.packages.length > 0 ? existing.packages : undefined),
					deviceMode: opts.deviceMode ?? existing.deviceMode,
					user: opts.user ?? existing.user,
					disableAdmin: opts.disableAdmin ?? existing.disableAdmin,
					license: opts.license,
					secureLogin: opts.secureLogin ?? existing.secureLogin,
				};
				const hasPending = !!(
					pendingOpts.installAllPackages ||
					(pendingOpts.packages?.length ?? 0) > 0 ||
					pendingOpts.deviceMode ||
					pendingOpts.user ||
					pendingOpts.disableAdmin ||
					pendingOpts.license ||
					pendingOpts.secureLogin === true
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
				networks: assignMacs(name, resolveStartNetworks(opts.networks, opts.network), getUsedMacs()),
				ports,
				packages: opts.packages ?? [],
				deviceMode: requestedDeviceMode,
				user: opts.user,
				disableAdmin: opts.disableAdmin,
				secureLogin: opts.secureLogin,
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
		const dirCreatedHere = !existsSync(machineDir);
		ensureDir(machineDir);
		const lockPath = join(machineDir, ".start-lock");
		acquireLock(lockPath);
		// Endpoints are claimed before QEMU is spawned, because resolution needs to know
		// which end this machine holds. A launch that fails before its state is persisted
		// has no instance lifecycle to release them later, so a failed start would leave a
		// machine holding an end of a link it never used — and two of those fill the link.
		// Cleared once saveMachine() has committed the claim.
		let unpersistedSocketClaim: MachineState | undefined;
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

		const networkConfigs = assignMacs(name, resolveStartNetworks(opts.networks, opts.network), getUsedMacs());
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
			secureLogin: opts.secureLogin,
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
		const note = accelNote(arch, accel);
		if (note) logger.warn(note);
		const hostfwd = buildHostfwdString(state.ports);
		const resolvedNetworks = registerAndResolveNetworks(
			state,
			{ platform, qemuVersion: qemuVersionForArch(platform, state.arch) },
			hostfwd,
		);
		unpersistedSocketClaim = state;
		reportSocketTransports(state, logger);

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
		const bootStart = Date.now();
		let { pid } = await spawnQemu(qemuArgs, machineDir, spawnInBackground, wrapper);

		// Foreground (no provisioning): spawnQemu blocks until QEMU exits
		if (!background && !hasProvisioning) {
			// QEMU has already exited here — spawnQemu() blocks in foreground. A machine
			// that is not running must not keep holding an end of a link: stop() and
			// remove() unregister, and this path reaches "stopped" without going through
			// either of them.
			unregisterSocketMembers(state);
			state.status = "stopped";
			state.lastStartedAt = new Date().toISOString();
			saveMachine(state);
			unpersistedSocketClaim = undefined;
			return createInstance(state);
		}

		state.pid = pid;
		state.lastStartedAt = new Date().toISOString();

		saveMachine(state);
		unpersistedSocketClaim = undefined;

		const instance = createInstance(state);

		const bootTimeout = defaultBootTimeout(arch, opts.installAllPackages, accel) + (opts.timeoutExtra ?? 0);

		// Always wait for boot in background mode — the JSDoc promises "REST-ready".
		const probe = newBootProbeStats();
		let booted = await instance.waitForBoot(bootTimeout, probe);

		// Hardware-accelerated runners (nested-KVM on CI, HVF on virtualized macOS
		// runners) occasionally produce a single QEMU process that boots but never
		// reaches REST, while sibling boots on the same host succeed in ~30-45s. The
		// process is wedged, not merely slow — so a fresh respawn recovers reliably
		// where a longer timeout would only stretch the failure. Retry once, gated to
		// hardware accel (TCG boots are legitimately long; doubling buys nothing there).
		if (!booted && (accel === "kvm" || accel === "hvf")) {
			logger.warn(
				`CHR "${name}" did not reach REST within ${bootTimeout / 1000}s (accel=${accel}) — respawning QEMU once.`,
			);
			try { await stopQemu(pid); } catch { /* ignore */ }
			cleanupQemuSockets(machineDir);
			({ pid } = await spawnQemu(qemuArgs, machineDir, spawnInBackground, wrapper));
			state.pid = pid;
			saveMachine(state);
			booted = await instance.waitForBoot(bootTimeout, probe);
		}

		if (!booted) {
			const guest = bootFailureGuestExec(state);
			const failure = await captureBootFailure({
				name,
				machineDir,
				arch,
				accel,
				bootTimeoutMs: bootTimeout,
				pid,
				httpPort: instance.ports.http,
				portBase: state.portBase,
				qemuArgs,
				probe,
				phase: "start",
				reportDir: bootFailureReportDir(),
				monitorQuery: (cmd) => monitorCommand(machineDir, cmd, 3000, state.portBase),
				forwards: Object.values(state.ports),
				guestExec: guest?.exec,
				guestUser: guest?.users.join(" → "),
			});
			throw new QuickCHRError(
				"BOOT_TIMEOUT",
				`CHR did not respond within ${bootTimeout / 1000}s (accel=${accel})` +
				(hasProvisioning ? " — provisioning could not run." : ".") +
				await cleanupAfterBootFailure(instance, name, failure) +
				`\n${failure.summary}`,
			);
		}

		// Record boot timing (cumulative from first spawn, incl. the respawn-once
		// path) — in machine.json for `list`/`get` and in the boot-history log.
		// Side-band metrics must never fail a boot that succeeded.
		state.lastAccel = accel;
		state.lastBootMs = Date.now() - bootStart;
		saveMachine(state);
		try {
			appendBootLog({
				ts: new Date().toISOString(),
				name,
				version,
				arch,
				accel,
				bootMs: state.lastBootMs,
				host: process.platform,
			});
		} catch { /* never propagate */ }

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
			// Release an endpoint this launch claimed but never committed. stop()/remove()
			// would do it for a machine that reached persisted state; one that did not has
			// no instance to do it.
			if (unpersistedSocketClaim) unregisterSocketMembers(unpersistedSocketClaim);
			// Clean up an orphaned machine directory if the spawn failed before readable
			// state was saved — same predicate as add()'s cleanup, so a truncated
			// machine.json is not mistaken for a finished machine.
			//
			// `dirCreatedHere` is the difference from add(): start() also starts machines
			// that already exist, and a directory this call did not create is never ours
			// to delete, whatever state it is in.
			if (dirCreatedHere && isOrphanMachineDir(name)) {
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
		// What actually ran, persisted at the end as MachineState.provisioning — the
		// record that says this guest has been provisioned, and with what (#176).
		const applied: ProvisioningStep[] = [];
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
			applied.push("packages");
		} else if (opts.packages && opts.packages.length > 0) {
			const installed = await installPackages(opts.packages, machineState.version, machineState.arch, chrPorts.ssh, chrPorts.http, log);
			await waitForBootWithProgress(instance, bootTimeout, log, "  Waiting for CHR to reboot after package installation...");
			const current = loadMachine(machineState.name);
			if (current) {
				current.packages = installed;
				saveMachine(current);
			}
			machineState.packages = installed;
			applied.push("packages");
		}

		if (hasDeviceModeProvisioning) {
			await applyDeviceMode(instance, machineState, resolvedDeviceMode, launchConfig, log);
			applied.push("deviceMode");
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
				applied.push("license");
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
			if (opts.user) applied.push("user");
			if (opts.disableAdmin) applied.push("disableAdmin");
			if (opts.secureLogin === true) applied.push("secureLogin");
			const result = await provision(chrPorts.http, machineState.name, opts.user, opts.disableAdmin, opts.secureLogin, log, machineState.machineDir, machineState.portBase, chrPorts.ssh);
			if (result.user || result.managedSshKey) {
				// Persist user info + managed SSH key fact in state (password placeholder —
				// real password in secret store). The managedSshKey fact is what the #71
				// descriptor reads to advertise SSH private-key batch auth (only when verified).
				const current = loadMachine(machineState.name);
				if (current) {
					if (result.user) current.user = { name: result.user.name, password: STORED_IN_SECRETS_PASSWORD };
					if (result.managedSshKey) current.managedSshKey = result.managedSshKey;
					saveMachine(current);
				}
			}
			if (result.managedSshKey) {
				machineState.managedSshKey = result.managedSshKey;
				if (!result.managedSshKey.batchVerified) {
					log.warn("  SSH key installed but batch login could not be verified — SSH transport may fall back to password");
				}
			}
			if (result.user) {
				machineState.user = { name: result.user.name, password: result.user.password };
				if (!opts.user) {
					// Auto-created quickchr account — credential display is handled by the caller (wizard/CLI)
					log.status(`  quickchr account created (user: ${result.user.name})`);
					log.status(`  Password saved to ${credentialStorageLabel()}`);
				}
			}
		}

		// Stamped only here, after every requested step returned. A run that throws
		// leaves the record absent, which is honest — the guest is half-provisioned and
		// quickchr should not claim otherwise. (Making that case *retryable* is the
		// remaining half of #176; the step list is what a retry will read.)
		recordProvisioning(machineState, applied);
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
		// Same pre-persistence window as start(): a relaunch that claims an endpoint and
		// then fails to spawn would keep it, with no instance to release it.
		let unpersistedSocketClaim: MachineState | undefined;
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
		const note = accelNote(state.arch, accel);
		if (note) (logger ?? createLogger()).warn(note);
		const hostfwd = buildHostfwdString(state.ports);
		const resolvedNetworks = registerAndResolveNetworks(
			state,
			{ platform, qemuVersion: qemuVersionForArch(platform, state.arch) },
			hostfwd,
		);
		unpersistedSocketClaim = state;
		reportSocketTransports(state, logger ?? createLogger());

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
		const bootStart = Date.now();
		const { pid } = await spawnQemu(qemuArgs, state.machineDir, spawnBackground, wrapper);

		// Foreground without provisioning: spawnQemu blocks until QEMU exits
		if (!background && !hasProvisioning) {
			// See the same branch in start(): QEMU has exited, so the endpoint goes back.
			unregisterSocketMembers(state);
			state.status = "stopped";
			state.lastStartedAt = new Date().toISOString();
			saveMachine(state);
			unpersistedSocketClaim = undefined;
			return createInstance(state);
		}

		state.pid = pid;
		state.status = "running";
		state.lastStartedAt = new Date().toISOString();
		saveMachine(state);
		unpersistedSocketClaim = undefined;

		const instance = createInstance(state);

		// Always wait for boot in background mode — start() promises "REST-ready".
		const bootTimeout = defaultBootTimeout(state.arch, provisioningOpts?.installAllPackages, accel);
		const probe = newBootProbeStats();
		const booted = await instance.waitForBoot(bootTimeout, probe);
		if (!booted) {
			const guest = bootFailureGuestExec(state);
			const failure = await captureBootFailure({
				name: state.name,
				machineDir: state.machineDir,
				arch: state.arch,
				accel,
				bootTimeoutMs: bootTimeout,
				pid,
				httpPort: instance.ports.http,
				portBase: state.portBase,
				qemuArgs,
				probe,
				phase: "_launchExisting",
				reportDir: bootFailureReportDir(),
				monitorQuery: (cmd) => monitorCommand(state.machineDir, cmd, 3000, state.portBase),
				forwards: Object.values(state.ports),
				guestExec: guest?.exec,
				guestUser: guest?.users.join(" → "),
			});
			throw new QuickCHRError(
				"BOOT_TIMEOUT",
				`CHR did not respond within ${bootTimeout / 1000}s (accel=${accel})` +
				(hasProvisioning ? " — provisioning could not run." : ".") +
				await cleanupAfterBootFailure(instance, state.name, failure) +
				`\n${failure.summary}`,
			);
		}

		// Record boot timing — mirrors start(); side-band, never fails the boot.
		state.lastAccel = accel;
		state.lastBootMs = Date.now() - bootStart;
		saveMachine(state);
		try {
			appendBootLog({
				ts: new Date().toISOString(),
				name: state.name,
				version: state.version,
				arch: state.arch,
				accel,
				bootMs: state.lastBootMs,
				host: process.platform,
			});
		} catch { /* never propagate */ }

		if (hasProvisioning && provisioningOpts) {
			await QuickCHR._provisionInstance(instance, state, provisioningOpts, launchConfig, logger);
		}

		try {
			autoPruneIfOverCap({
				logger: logger ? (msg) => logger.status(msg) : undefined,
				protectVersions: [state.version],
				maxSizeBytes: resolveSetting("cache-max-size").value as number | undefined,
			});
		} catch { /* never propagate */ }

		return instance;
		} catch (err) {
			if (unpersistedSocketClaim) unregisterSocketMembers(unpersistedSocketClaim);
			throw err;
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

	/** Machines whose `machine.json` is present but cannot be turned into state, each
	 *  with the reason: the file would not read, the JSON is invalid, or it parsed into
	 *  something that is not a machine.
	 *
	 *  `list()` skips these so one corrupt file cannot abort the enumeration; this is
	 *  where they stay visible. `get(name)` still throws for such a machine — a lookup
	 *  by name is not an enumeration (#165). */
	static listUnreadable(): Array<{ name: string; error: string }> {
		return listUnreadableMachines();
	}

	/** Names of machine directories with no readable `machine.json` — half-created
	 *  machines that `list()` cannot show and `get()` cannot resolve (#155). */
	static listOrphans(): string[] {
		return listOrphanMachineDirs();
	}

	/** Delete a half-created machine directory. Returns false when `name` is a real
	 *  machine (use `get(name)?.remove()`) or does not exist at all.
	 *
	 *  A crash or SIGKILL can strand a directory even with add()'s cleanup in place, and
	 *  a stranded directory blocks re-add while being invisible to `list` — so clearing
	 *  one must not require knowing that the data dir exists. */
	static removeOrphan(name: string): boolean {
		// Explicit, before the predicate: this deletes a directory tree, and `join()`
		// turns ".." into the data dir itself. Say why rather than answering `false`.
		assertPathSafeName(name, "machine");
		if (!isOrphanMachineDir(name)) return false;

		// A create still in flight is indistinguishable from an orphan by directory
		// contents alone — add()/start() write machine.json last, so the window between
		// ensureDir() and saveMachine() looks exactly like a half-made machine. The
		// start-lock is what tells them apart, so take it: acquireLock() throws
		// MACHINE_LOCKED while a live creator holds it, and replaces one whose owner is
		// gone — which is the case this recovery exists for.
		const lockPath = join(getMachineDir(name), ".start-lock");
		acquireLock(lockPath);

		// The creator may have finished between the check above and the lock.
		if (!isOrphanMachineDir(name)) {
			try { unlinkSync(lockPath); } catch { /* ignore */ }
			return false;
		}

		removeState(name);
		return true;
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
				const hint = getQemuInstallHint();
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
				// Under an override, accelAvailable is just the forced mode for every
				// arch — say so, or the row reads as a capability report it isn't.
				const { mode: forced, source } = resolveAccelOverrideWithSource();
				const suffix = forced === "auto" ? "" : ` — configured override via ${accelSourceLabel(source)}`;
				checks.push({
					label: "Acceleration",
					status: "ok",
					detail: `${platform.accelAvailable.join(", ")} (host: ${platform.hostArch})${suffix}`,
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
		if (existsSync(getMachinesDir())) {
			const orphans = listOrphanMachineDirs();
			if (orphans.length > 0) {
				const removeLines = orphans.map((o) => `  quickchr remove ${o}`).join("\n");
				checks.push({
					label: "Orphaned machine dirs",
					status: "warn",
					detail: `${orphans.length} dir(s) with no readable machine.json: ${orphans.join(", ")}\nClear them with:\n${removeLines}`,
				});
			} else {
				checks.push({
					label: "Machine state",
					status: "ok",
					detail: `${listMachineNames().length} machine(s), no orphans`,
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
