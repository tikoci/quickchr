/**
 * Shared types for quickchr — CHR QEMU Manager.
 */

// --- Version & Architecture ---

export type Channel = "stable" | "long-term" | "testing" | "development";
export const CHANNELS: Channel[] = ["stable", "long-term", "testing", "development"];

export type Arch = "arm64" | "x86";
export const ARCHES: Arch[] = ["arm64", "x86"];

// --- Networking ---

export type NetworkMode =
	| "user"
	| "vmnet-shared"
	| { type: "vmnet-bridge"; iface: string };

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

// --- Machine State ---

export interface MachineConfig {
	name: string;
	version: string;
	arch: Arch;
	cpu: number;
	mem: number;
	network: NetworkMode;
	ports: Record<string, PortMapping>;
	packages: string[];
	user?: { name: string; password: string };
	disableAdmin?: boolean;
	portBase: number;
	excludePorts: ServiceName[];
	extraPorts: PortMapping[];
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

export interface StartOptions {
	version?: string;
	channel?: Channel;
	arch?: Arch;
	name?: string;
	cpu?: number;
	mem?: number;
	background?: boolean;
	packages?: string[];
	user?: { name: string; password: string };
	disableAdmin?: boolean;
	portBase?: number;
	excludePorts?: ServiceName[];
	extraPorts?: PortMapping[];
	network?: NetworkMode;
	installDeps?: boolean;
	dryRun?: boolean;
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

export interface ChrInstance {
	name: string;
	state: MachineState;
	ports: ChrPorts;
	restUrl: string;
	sshPort: number;

	waitForBoot(timeoutMs?: number): Promise<boolean>;
	stop(): Promise<void>;
	remove(): Promise<void>;
	clean(): Promise<void>;

	monitor(command: string): Promise<string>;
	serial(): { readable: ReadableStream; writable: WritableStream };
	qga(command: string, args?: object): Promise<unknown>;

	rest(path: string, opts?: RequestInit): Promise<unknown>;
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
	efiFirmware?: EfiFirmwarePaths;
	accelAvailable: string[];
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
	| "DOWNLOAD_FAILED"
	| "MACHINE_EXISTS"
	| "MACHINE_NOT_FOUND"
	| "MACHINE_RUNNING"
	| "MACHINE_STOPPED"
	| "INVALID_VERSION"
	| "INVALID_ARCH"
	| "PROCESS_FAILED";

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

// --- Known extra packages ---

export const KNOWN_PACKAGES = [
	"container",
	"iot",
	"wifi-qcom",
	"wifi-qcom-ac",
	"zerotier",
	"rose-storage",
	"ups",
	"gps",
	"calea",
	"tr069-client",
] as const;
