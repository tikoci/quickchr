/**
 * Shared types for quickchr — CHR QEMU Manager.
 */

import type { ProgressLogger } from "./log.ts";

// --- Version & Architecture ---

export type Channel = "stable" | "long-term" | "testing" | "development";
export const CHANNELS: Channel[] = ["stable", "long-term", "testing", "development"];

export type Arch = "arm64" | "x86";
export const ARCHES: Arch[] = ["arm64", "x86"];

// --- Networking ---

/** @deprecated Use NetworkSpecifier instead. Kept for backward compatibility with old machine.json files. */
export type NetworkMode =
	| "user"
	| "vmnet-shared"
	| { type: "vmnet-bridge"; iface: string };

/**
 * Network specifier — expresses user intent for a network interface.
 * Generic specifiers (user, socket, shared, bridged) are cross-platform;
 * explicit specifiers (vmnet-shared, vmnet-bridged, tap) bypass platform resolution.
 */
export type NetworkSpecifier =
	| "user"
	| { type: "socket"; name: string }
	| { type: "socket-listen"; port: number }
	| { type: "socket-connect"; port: number }
	| { type: "socket-mcast"; group: string; port: number }
	| "shared"
	| { type: "bridged"; iface: string }
	| "vmnet-shared"
	| { type: "vmnet-bridged"; iface: string }
	| { type: "tap"; ifname: string };

/** Result of resolving a NetworkSpecifier on a specific platform. */
export interface ResolvedNetwork {
	/** QEMU -netdev and -device argument pairs. */
	qemuNetdevArgs: string[];
	/** Optional wrapper command (e.g. socket_vmnet_client). When set, QEMU is spawned as a child of this wrapper. */
	wrapper?: string[];
	/** If the specifier was downgraded (e.g. shared → user), details are here. */
	downgraded?: { from: string; reason: string };
	/** MAC address override for deterministic addressing (socket_vmnet DHCP). */
	mac?: string;
}

/** A single network interface in a machine's config. */
export interface NetworkConfig {
	/** The user-specified intent (stored in machine.json for re-resolution on restart). */
	specifier: NetworkSpecifier;
	/** QEMU netdev id (net0, net1, ...). */
	id: string;
	/** Resolved QEMU args (populated at launch time, not persisted). */
	resolved?: ResolvedNetwork;
}

/** Physical network interface detected on the host. */
export interface HostInterface {
	/** OS device name (e.g. en0, eth0). */
	device: string;
	/** Human-readable port name (e.g. "Wi-Fi", "Thunderbolt 1"). */
	name: string;
	/** MAC address. */
	mac?: string;
	/** Interface alias for --add-network convenience: "wifi", "ethernet", or undefined. */
	alias?: "wifi" | "ethernet";
}

/** socket_vmnet daemon availability on macOS. */
export interface SocketVmnetInfo {
	/** Path to socket_vmnet_client binary. */
	client: string;
	/** Path to shared daemon socket (if running). */
	sharedSocket?: string;
	/** Map of interface name → bridged daemon socket path (if running). */
	bridgedSockets: Record<string, string>;
}

export interface PortMapping {
	name: string;
	host: number;
	guest: number;
	proto: "tcp" | "udp";
}

/** Default RouterOS service ports and their offset within a port block. */
export const SERVICE_PORTS = {
	http: { guest: 80, offset: 0, proto: "tcp" as const },
	https: { guest: 443, offset: 1, proto: "tcp" as const },
	ssh: { guest: 22, offset: 2, proto: "tcp" as const },
	api: { guest: 8728, offset: 3, proto: "tcp" as const },
	"api-ssl": { guest: 8729, offset: 4, proto: "tcp" as const },
	winbox: { guest: 8291, offset: 5, proto: "tcp" as const },
} as const;

export type ServiceName = keyof typeof SERVICE_PORTS;
export const SERVICE_NAMES = Object.keys(SERVICE_PORTS) as ServiceName[];

/** Ports per instance block for allocation. */
export const PORTS_PER_BLOCK = 10;
export const DEFAULT_PORT_BASE = 9100;

/**
 * TCP endpoint for QEMU IPC channels on Windows.
 * Used instead of named pipes when QEMU's Winsock bind() can't handle \\.\pipe\ paths.
 * Offsets within the port block: monitor=+6, serial=+7, qga=+8.
 */
export type ChannelTcpEndpoint = { host: string; port: number };

// --- Disk ---

export type BootDiskFormat = "raw" | "qcow2";

/** Information about a single QEMU snapshot stored in a qcow2 disk image.
 *
 *  Populated by parsing QEMU monitor `info snapshots` output or
 *  `qemu-img info --output=json`.  The `vmStateSize` field gives a rough
 *  indication of how much guest state has changed — larger values typically
 *  mean more RAM pages were dirty at snapshot time. */
export interface SnapshotInfo {
	/** Numeric snapshot ID (assigned by QEMU, monotonically increasing). */
	id: string;
	/** Human-readable tag / name (the string passed to `savevm`). */
	name: string;
	/** Size of the saved VM state in bytes.  Gives a rough sense of how "heavy"
	 *  the snapshot is — proportional to the amount of dirty guest RAM at save time. */
	vmStateSize: number;
	/** When the snapshot was created (ISO 8601 string). */
	date: string;
	/** Guest VM clock at snapshot time, formatted as `HH:MM:SS.mmm`. */
	vmClock: string;
	/** Instruction count at snapshot time, or `undefined` if QEMU reported `--`. */
	icount?: number;
}

// --- Machine State ---

export interface MachineConfig {
	name: string;
	version: string;
	arch: Arch;
	cpu: number;
	mem: number;
	/** @deprecated Use `networks` instead. Kept for backward compat with old machine.json. */
	network?: NetworkMode;
	/** Network interfaces for this machine. Default: single user-mode NIC. */
	networks: NetworkConfig[];
	ports: Record<string, PortMapping>;
	packages: string[];
	/** Install all packages from all_packages.zip on first boot. */
	installAllPackages?: boolean;
	deviceMode?: DeviceModeOptions;
	user?: { name: string; password: string };
	disableAdmin?: boolean;
	/** Create a 'quickchr' managed account with a generated password.  Defaults to true. */
	secureLogin?: boolean;
	portBase: number;
	excludePorts: ServiceName[];
	extraPorts: PortMapping[];
	licenseLevel?: LicenseLevel;
	/** Boot disk size override (e.g. "512M", "2G"). Requires `qemu-img` on the host.
	 *  When set, the boot disk is converted from raw to qcow2. */
	bootSize?: string;
	/** Extra blank disk sizes (e.g. ["512M", "1G"]). Requires `qemu-img` on the host.
	 *  Extra disks are always created as qcow2 images. */
	extraDisks?: string[];
	/** Format of the boot disk — raw by default, qcow2 when resized. */
	bootDiskFormat?: BootDiskFormat;
}

export interface MachineState extends MachineConfig {
	createdAt: string;
	lastStartedAt?: string;
	status: "stopped" | "running" | "error";
	pid?: number;
	/** Path to the machine directory. */
	machineDir: string;
}

// --- Start Options ---

/**
 * Options for creating and starting a CHR instance.
 *
 * Boot-only options (version, arch, cpu, mem, networks, disks) work with any RouterOS 7.x.
 * Post-boot provisioning options (packages, user, license, deviceMode) require RouterOS ≥ 7.20.8
 * and will throw if used with an older version.
 *
 * When `installAllPackages` is set, boot time increases significantly (full package install
 * requires SCP upload + reboot cycle, typically 60–120s extra on native acceleration).
 */
export interface StartOptions {
	/** RouterOS version to use (e.g. "7.22.1"). Mutually exclusive with `channel`. */
	version?: string;
	/** Release channel to resolve latest version from. Default: "stable". */
	channel?: Channel;
	/** Guest architecture. Default: matches host (arm64 on Apple Silicon, x86 on Intel/AMD).
	 *  Pass `"auto"` as an explicit synonym for the default — useful when an agent or
	 *  caller wants to state the intent rather than omit the field. */
	arch?: Arch | "auto";
	/** Instance name. Auto-generated from version+arch if omitted. Must not start with "-". */
	name?: string;
	/** Number of virtual CPUs. Default: 1. */
	cpu?: number;
	/** Memory in MiB. Default: 512 (1024 for cross-arch TCG emulation). */
	mem?: number;
	/** Run QEMU in background (true, default) or foreground with serial console on stdio (false). */
	background?: boolean;
	/** Extra packages to install after boot.
	 *  This is quickchr provisioning, so it is validated/tested on RouterOS 7.20.8+ only. */
	packages?: string[];
	/** Install all packages from the all_packages ZIP (overrides packages[]).
	 *  This is quickchr provisioning, so it is validated/tested on RouterOS 7.20.8+ only. */
	installAllPackages?: boolean;
	/** Create a user after boot.
	 *  This is quickchr provisioning, so it is validated/tested on RouterOS 7.20.8+ only. */
	user?: { name: string; password: string };
	/** Disable the default admin account after boot.
	 *  This is quickchr provisioning, so it is validated/tested on RouterOS 7.20.8+ only. */
	disableAdmin?: boolean;
	/** Create a 'quickchr' managed account with a generated password.  Defaults to true.
	 *  Set to false to keep admin with no password (exec still works).
	 *  Enabling the managed login path is quickchr provisioning, so it is validated/tested
	 *  on RouterOS 7.20.8+ only. */
	secureLogin?: boolean;
	/** Starting port number for this instance's port block. Auto-allocated if omitted. */
	portBase?: number;
	/** Services to exclude from port mappings (e.g. ["winbox", "api-ssl"]). */
	excludePorts?: ServiceName[];
	/** Additional custom port mappings appended to the default set. */
	extraPorts?: PortMapping[];
	/** @deprecated Use `networks` instead. Kept for backward compatibility. */
	network?: NetworkMode;
	/** Network interfaces. Each entry becomes a NIC on the CHR.
	 *  Default (when omitted): single user-mode NIC.
	 *  When specified: count of entries = count of NICs (explicit control). */
	networks?: NetworkSpecifier[];
	/** Install OS-level dependencies (QEMU, firmware) automatically if missing. */
	installDeps?: boolean;
	/** Print QEMU command and config without actually starting the VM. */
	dryRun?: boolean;
	/** Apply a CHR trial license after boot via /system/license/renew.
	 *  Pass a level string (e.g. "p1") to auto-resolve MikroTik credentials,
	 *  or a LicenseOptions object to supply credentials explicitly.
	 *  This is quickchr provisioning, so it is validated/tested on RouterOS 7.20.8+ only. */
	license?: LicenseInput;
	/** Configure /system/device-mode after boot. If omitted, CHR boots with RouterOS defaults (mode=advanced).
	 *  This is quickchr provisioning, so it is validated/tested on RouterOS 7.20.8+ only. */
	deviceMode?: DeviceModeOptions;
	/** Boot disk size override (e.g. "512M", "2G"). Requires `qemu-img` on the host.
	 *  Converts the boot disk to qcow2 before first boot. */
	bootSize?: string;
	/** Boot disk format. `qcow2` enables snapshots and resize; `raw` keeps the original raw image.
	 *  Raw boot disks cannot be resized. */
	bootDiskFormat?: BootDiskFormat;
	/** Extra blank disks to attach, specified as sizes (e.g. ["512M", "1G"]).
	 *  Requires `qemu-img` on the host. Extra disks are always qcow2. */
	extraDisks?: string[];
	/** Extra milliseconds added to the computed boot timeout.
	 *  Useful on slow hosts where `defaultBootTimeout` underestimates actual boot time. */
	timeoutExtra?: number;
	/** Progress callback for status messages during start.
	 *  If not provided, messages go to console.log.
	 *  Debug-level messages (prefixed [debug]) are only emitted when QUICKCHR_DEBUG=1. */
	onProgress?: (message: string) => void;
}

// --- Instance (runtime handle) ---

export interface ChrPorts {
	http: number;
	https: number;
	ssh: number;
	api: number;
	apiSsl: number;
	winbox: number;
	[key: string]: number;
}

/** Return value of ChrInstance.queryLoad(). */
export interface ChrLoadSample {
	/** Host CPU percent across all virtual CPUs (0–100 × vCPU count). */
	cpuPercent: number;
	/** Balloon-reported guest memory in use, in MiB. */
	memUsedMb: number;
}

/**
 * Runtime handle for a CHR virtual machine.
 *
 * Returned by {@link QuickCHR.start}. Provides methods to interact with the running
 * (or stopped) instance: REST API calls, CLI command execution, QGA, serial console,
 * snapshots, licensing, and lifecycle management.
 *
 * After `QuickCHR.start()` resolves, the instance is REST-ready — all requested
 * provisioning (packages, license, device-mode, user creation) has completed.
 */
export interface ChrInstance {
	name: string;
	state: MachineState;
	ports: ChrPorts;
	restUrl: string;
	sshPort: number;

	/** Check or wait for REST API readiness.
	 *  After `QuickCHR.start()` with provisioning options (installAllPackages, license, etc.),
	 *  the returned instance is already REST-reachable — this returns immediately.
	 *  Call this only when starting without provisioning, or as a safety check after a manual stop/restart. */
	waitForBoot(timeoutMs?: number): Promise<boolean>;
	stop(): Promise<void>;
	remove(): Promise<void>;
	clean(): Promise<void>;
	/** Stop and permanently delete this instance (disk + state). Equivalent to stop() then remove(). */
	destroy(): Promise<void>;

	monitor(command: string): Promise<string>;
	serial(): { readable: ReadableStream; writable: WritableStream };
	/**
	 * Execute any raw QGA command.  Prefer the typed helpers (`qgaGetOsInfo`,
	 * `qgaGetNetworkInterfaces`, etc.) exported from this package for common
	 * operations.  Use this for advanced / one-off commands.
	 *
	 * x86_64 only — throws `QGA_UNSUPPORTED` on ARM64 until MikroTik ships
	 * guest-agent support for that architecture.
	 */
	qga(command: QgaCommand, args?: object): Promise<unknown>;

	rest(path: string, opts?: RequestInit): Promise<unknown>;
	/** Run a RouterOS CLI command against the instance. */
	exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
	/** Apply or renew a CHR trial license.
	 *  quickchr validates this provisioning flow on RouterOS 7.20.8+ only. */
	license(opts: LicenseOptions): Promise<void>;
	/** Change device-mode on a running instance (e.g. enable container, rose, etc.).
	 *  quickchr validates this provisioning flow on RouterOS 7.20.8+ only.
	 *  This requires a hard QEMU power-cycle to confirm the change — the instance
	 *  will briefly stop and restart. Wait for the returned promise before using the
	 *  instance again.
	 *  @param options  Desired device-mode flags (same as StartOptions.deviceMode).
	 *  @param logger   Optional progress logger for status/debug output. */
	setDeviceMode(options: DeviceModeOptions, logger?: ProgressLogger): Promise<void>;

	/** Copy a local file to the CHR via SCP.
	 *  Machine must be running. `remotePath` defaults to `/<basename>` (RouterOS flash root).
	 *  Uses the resolved instance credentials.
	 *  @example
	 *  await instance.upload("./dude.db", "/dude/dude.db");
	 *  await instance.upload("./config.rsc"); // → /config.rsc
	 */
	upload(localPath: string, remotePath?: string): Promise<void>;

	/** Copy a file from the CHR to the local filesystem via SCP.
	 *  Machine must be running. Uses the resolved instance credentials.
	 *  @example
	 *  await instance.download("/dude/dude.db", "./dude-snapshot.db");
	 */
	download(remotePath: string, localPath: string): Promise<void>;

	/** List extra packages available for this instance's version and arch.
	 *  Downloads and caches the all_packages ZIP on the first call. */
	availablePackages(): Promise<string[]>;
	/** Install extra package(s), reboot, and wait until REST API is ready again.
	 *  quickchr validates this provisioning flow on RouterOS 7.20.8+ only.
	 *  Accepts a single package name or an array. Returns the names that were
	 *  actually installed (missing packages are skipped with a warning). */
	installPackage(packages: string | string[]): Promise<string[]>;

	/** Build an env-var map for spawning a subprocess against this instance.
	 *  Includes QUICKCHR_* prefixed keys plus legacy URLBASE/BASICAUTH for compat.
	 *  Resolves auth from the instance secret store, provisioned user, or admin default.
	 *
	 *  @example
	 *  Bun.spawn(["bun", "my-script.ts"], { env: { ...process.env, ...await chr.subprocessEnv() } })
	 */
	subprocessEnv(): Promise<Record<string, string>>;

	/** Sample QEMU guest load from the monitor. Returns null when the monitor is
	 *  unavailable (machine stopped or running in foreground mode). */
	queryLoad(): Promise<ChrLoadSample | null>;

	/** Snapshot operations on this instance's boot disk.
	 *
	 *  Requires a qcow2 boot disk (`bootDiskFormat: "qcow2"` in StartOptions).
	 *  Raw disks do not support snapshots — methods throw `STATE_ERROR` if called
	 *  on a raw-disk instance.
	 *
	 *  **For running machines**, `save`/`load`/`delete` use the QEMU monitor
	 *  (`savevm`/`loadvm`/`delvm`).  `list` uses the monitor for live state.
	 *
	 *  **For stopped machines**, only `list` works (reads qcow2 metadata directly
	 *  via `qemu-img info`).  Other operations require the machine to be running.
	 *
	 *  @example
	 *  const snaps = await instance.snapshot.list();
	 *  await instance.snapshot.save("before-upgrade");
	 *  // ... do something risky ...
	 *  await instance.snapshot.load("before-upgrade");
	 */
	snapshot: {
		/** List all snapshots on this instance's boot disk.
		 *  Works on both running and stopped machines. */
		list(): Promise<SnapshotInfo[]>;
		/** Save a snapshot of the current VM state.  Requires the machine to be running.
		 *  @param name - Snapshot tag name (e.g. "before-upgrade"). Auto-generated if omitted. */
		save(name?: string): Promise<SnapshotInfo>;
		/** Load (restore) a previously saved snapshot.  Requires the machine to be running.
		 *  The VM state is replaced; existing runtime state is lost.
		 *  @param name - Snapshot tag name to restore. */
		load(name: string): Promise<void>;
		/** Delete a snapshot.  Requires the machine to be running.
		 *  @param name - Snapshot tag name to delete. */
		delete(name: string): Promise<void>;
	};
}

// --- Platform ---

export interface EfiFirmwarePaths {
	code: string;
	vars: string;
}

export type PackageManager = "brew" | "apt" | "dnf" | "pacman" | "winget" | "unknown";

export interface PlatformInfo {
	os: "darwin" | "linux" | "win32";
	hostArch: "x64" | "arm64";
	packageManager: PackageManager;
	qemuBinX86?: string;
	qemuBinArm64?: string;
	qemuImg?: string;
	efiFirmware?: EfiFirmwarePaths;
	accelAvailable: string[];
	socketVmnet?: SocketVmnetInfo;
}

// --- Doctor ---

export interface DoctorCheck {
	label: string;
	status: "ok" | "warn" | "error";
	detail: string;
}

export interface DoctorResult {
	checks: DoctorCheck[];
	ok: boolean;
}

// --- Errors ---

export type ErrorCode =
	| "MISSING_QEMU"
	| "MISSING_FIRMWARE"
	| "MISSING_BUN"
	| "MISSING_UNZIP"
	| "PORT_CONFLICT"
	| "BOOT_TIMEOUT"
	| "QGA_UNSUPPORTED"
	| "QGA_TIMEOUT"
	| "DOWNLOAD_FAILED"
	| "MACHINE_EXISTS"
	| "MACHINE_NOT_FOUND"
	| "MACHINE_RUNNING"
	| "MACHINE_STOPPED"
	| "INVALID_VERSION"
	| "INVALID_ARCH"
	| "INVALID_NAME"
	| "INVALID_DISK_SIZE"
	| "MACHINE_LOCKED"
	| "EXEC_FAILED"
	| "PROCESS_FAILED"
	| "SPAWN_FAILED"
	| "NETWORK_UNAVAILABLE"
	| "INVALID_NETWORK"
	| "INVALID_FORWARD_SPEC"
	| "PROVISIONING_VERSION_UNSUPPORTED"
	| "INSUFFICIENT_DISK_SPACE"
	| "STATE_ERROR";

export class QuickCHRError extends Error {
	code: ErrorCode;
	installHint?: string;

	constructor(code: ErrorCode, message: string, installHint?: string) {
		super(message);
		this.name = "QuickCHRError";
		this.code = code;
		this.installHint = installHint;
	}
}

// --- Exec ---

/** Transport used to execute a RouterOS CLI command. */
export type ExecTransport = "auto" | "rest" | "ssh" | "console" | "qga";

/** Options for ChrInstance.exec(). */
export interface ExecOptions {
	/** Transport to use. "auto" tries REST /execute, future: SSH fallback. */
	via?: ExecTransport;
	/** Override username (default: resolved from machine config). */
	user?: string;
	/** Override password (default: resolved from machine config). */
	password?: string;
	/** Request timeout in milliseconds (default: 30 000). */
	timeout?: number;
}

/** Result of a ChrInstance.exec() call. */
export interface ExecResult {
	/** Command output as a string (or parsed JSON when output="json"). */
	output: string;
	/** Which transport actually carried the command. */
	via: ExecTransport;
}

// --- QGA (QEMU Guest Agent) ---

/** Result of a QGA guest-exec command (exitcode + decoded stdout/stderr). */
export interface QgaExecResult {
	exitcode: number;
	stdout: string;
	stderr: string;
}

/**
 * All QGA commands supported by RouterOS CHR (x86_64 only).
 *
 * Use with {@link ChrInstance.qga} for raw access, or call the typed QGA
 * helper functions (`qgaGetOsInfo`, `qgaGetNetworkInterfaces`, etc.).
 *
 * RouterOS implements these via its own QGA (version "2.10.50") — not stock
 * qemu-ga. The `guest-exec` command only accepts `input-data` (RouterOS script),
 * not `path`. File operations use flat RouterOS filenames only (no directories).
 *
 * QGA requires KVM — RouterOS only starts the guest agent daemon under KVM hypervisors.
 * On macOS (HVF) and Windows, the daemon never starts; calls will time out.
 * ARM64 CHR does not implement QGA at all (MikroTik feature, pending).
 */
export type QgaCommand =
	| "guest-ping"
	| "guest-info"
	| "guest-get-osinfo"
	| "guest-get-host-name"
	| "guest-get-time"
	| "guest-get-timezone"
	| "guest-network-get-interfaces"
	| "guest-fsfreeze-status"
	| "guest-fsfreeze-freeze"
	| "guest-fsfreeze-thaw"
	| "guest-shutdown"
	| "guest-exec"
	| "guest-exec-status"
	| "guest-file-open"
	| "guest-file-read"
	| "guest-file-write"
	| "guest-file-close"
	| "guest-file-flush";

/** OS information returned by {@link qgaGetOsInfo}. */
export interface QgaOsInfo {
	/** Always "routeros" */
	id: string;
	/** "RouterOS" */
	name: string;
	/** e.g. "RouterOS 7.22" */
	prettyName: string;
	/** Linux kernel release, e.g. "5.6.3-64" */
	kernelRelease: string;
	/** CPU architecture, e.g. "x86_64" */
	machine: string;
}

/** Single IP address on a network interface (from {@link qgaGetNetworkInterfaces}). */
export interface QgaNetworkIpAddress {
	type: "ipv4" | "ipv6";
	address: string;
	prefix: number;
}

/** Network interface as seen by RouterOS (from {@link qgaGetNetworkInterfaces}). */
export interface QgaNetworkInterface {
	/** RouterOS interface name, e.g. "ether1" */
	name: string;
	/** MAC address, e.g. "0e:61:47:d8:43:2a" */
	mac?: string;
	ipAddresses: QgaNetworkIpAddress[];
}

/** Timezone information returned by {@link qgaGetTimezone}. */
export interface QgaTimezone {
	/** Offset from UTC in seconds (positive = east of UTC) */
	offset: number;
	/** IANA timezone name if reported by the guest */
	zone?: string;
}

/** Filesystem freeze state returned by {@link qgaFsFreezeStatus}. */
export type QgaFsFreezeStatus = "thawed" | "frozen";

// --- CHR License ---

/** CHR trial license levels (speed caps). free = 1 Mbps, p1 = 1 Gbps, p10 = 10 Gbps, unlimited = no cap. */
export type LicenseLevel = "p1" | "p10" | "unlimited";
export const LICENSE_LEVELS: LicenseLevel[] = ["p1", "p10", "unlimited"];

/** Options passed to /system/license/renew.
 *  `account` and `password` are optional: when omitted, quickchr resolves them
 *  from env vars (MIKROTIK_WEB_ACCOUNT / MIKROTIK_WEB_PASSWORD) or the secret store.
 */
export interface LicenseOptions {
	account?: string;
	password?: string;
	level?: LicenseLevel;
}

/** License shorthand accepted by StartOptions.license.
 *  A string value (e.g. "p1") auto-resolves MikroTik credentials from env vars
 *  or the secret store.  An object lets the caller supply credentials explicitly.
 */
export type LicenseInput = LicenseLevel | LicenseOptions;

// --- Device-mode ---

/** Device-mode options for /system/device-mode/update. */
export interface DeviceModeOptions {
	/** Profile mode. Supports known modes plus unknown future values. */
	mode?: string;
	/** Feature names to set to yes (e.g. container, routerboard). */
	enable?: string[];
	/** Feature names to set to no (e.g. zerotier, iot). */
	disable?: string[];
}

// --- Known extra packages ---
// Baseline: exact contents of RouterOS 7.22.1 all_packages ZIP files.
// x86:   all_packages-x86-7.22.1.zip
// arm64: all_packages-arm64-7.22.1.zip
// Note: some packages are hardware-specific (switch-marvell, wifi-*) or mutually
// exclusive (wireless vs wifi-qcom vs wifi-qcom-be). All are included here because
// even on CHR (VM) they register API endpoints useful for schema generation.

/** Extra packages in all_packages-x86-7.22.1.zip (sorted). */
export const KNOWN_PACKAGES_X86 = [
	"calea",
	"container",
	"dude",
	"gps",
	"iot",
	"openflow",
	"rose-storage",
	"tr069-client",
	"ups",
	"user-manager",
	"wireless",
] as const;

/** Extra packages in all_packages-arm64-7.22.1.zip (sorted). */
export const KNOWN_PACKAGES_ARM64 = [
	"calea",
	"container",
	"dude",
	"extra-nic",
	"gps",
	"iot",
	"iot-bt-extra",
	"openflow",
	"rose-storage",
	"switch-marvell",
	"tr069-client",
	"ups",
	"user-manager",
	"wifi-qcom",
	"wifi-qcom-be",
	"wireless",
	"zerotier",
] as const;

/** Union of all known packages across architectures. */
export const KNOWN_PACKAGES = [
	"calea",
	"container",
	"dude",
	"extra-nic",
	"gps",
	"iot",
	"iot-bt-extra",
	"openflow",
	"rose-storage",
	"switch-marvell",
	"tr069-client",
	"ups",
	"user-manager",
	"wifi-qcom",
	"wifi-qcom-be",
	"wireless",
	"zerotier",
] as const;

/** Return the known packages for a specific architecture. */
export function knownPackagesForArch(arch: Arch): readonly string[] {
	return arch === "arm64" ? KNOWN_PACKAGES_ARM64 : KNOWN_PACKAGES_X86;
}
