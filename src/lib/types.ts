/**
 * Shared types for quickchr — CHR QEMU Manager.
 */

import type { ProgressLogger } from "./log.ts";

// --- Version & Architecture ---

export type Channel = "stable" | "long-term" | "testing" | "development";
/** Canonical channel order. Frozen so neither library code nor consumers can mutate it. */
export const CHANNELS: readonly Channel[] = Object.freeze(["stable", "long-term", "testing", "development"] as Channel[]);

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
 *
 * Pick by traffic shape (full guide: `docs/networking-recipes.md`):
 * - **Management / host→guest TCP+UDP services** → `"user"` (SLIRP + `hostfwd`).
 *   Keep `"user"` first (ether1) so RouterOS' DHCP client gets `10.0.2.15`.
 * - **Host needs to see guest L2 frames** (MNDP, MAC-Telnet, raw Ethernet,
 *   broadcasts) → `{type:"socket-connect", port}` against a host TCP server
 *   (rootless, cross-platform; recipe in `docs/mndp.md`).
 * - **L2 link between two VMs** → `{type:"socket", name}` (named pair) or
 *   `socket-listen`/`socket-connect`/`socket-mcast` (low-level).
 * - **Real LAN / DHCP-from-host presence** → `"shared"` or `{type:"bridged", iface}`
 *   (rootless via socket_vmnet on macOS / pre-created TAP on Linux).
 *
 * Note: receiving guest-*originated* UDP (e.g. a guest replying to `10.0.2.2`)
 * needs no extra NIC and no forward — see {@link ChrInstance.tzspGatewayIp}.
 */
export type NetworkSpecifier =
	/** SLIRP user-mode NAT + `hostfwd` port mapping. Management default; the only
	 *  NIC that makes `extraPorts`/`--forward` reachable. Terminates Layer 2. */
	| "user"
	/** L2 socket pair between two VMs sharing a registered `name` (`quickchr networks sockets`). */
	| { type: "socket"; name: string }
	/** Low-level QEMU `socket` netdev that binds and listens (`0.0.0.0:port`). */
	| { type: "socket-listen"; port: number }
	/** Low-level QEMU `socket` netdev that connects to `127.0.0.1:port`. The
	 *  rootless, cross-platform way for a host process to receive guest L2 frames. */
	| { type: "socket-connect"; port: number }
	/** Multi-VM L2 segment over UDP multicast. Works on Linux/CI; **broken on macOS**
	 *  (QEMU sets only `SO_REUSEADDR`). */
	| { type: "socket-mcast"; group: string; port: number }
	/** NAT'd L3 with DHCP from the host; resolves to socket_vmnet/vmnet (macOS) or TAP (Linux). */
	| "shared"
	/** L2 bridged onto a host interface; resolves like `"shared"` but bridged. */
	| { type: "bridged"; iface: string }
	/** Explicit macOS vmnet-shared (bypasses resolution; runs QEMU as root). */
	| "vmnet-shared"
	/** Explicit macOS vmnet-bridged (bypasses resolution; runs QEMU as root). */
	| { type: "vmnet-bridged"; iface: string }
	/** Pre-created user-owned TAP on Linux (no quickchr setup). */
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

/** A single host→guest port forward, realized as one QEMU SLIRP `hostfwd`
 *  directive (`hostfwd=<proto>::<host>-:<guest>`).
 *
 *  This is the programmatic equivalent of one CLI `--forward` spec. Build them
 *  by hand, or parse spec strings with {@link parseForwardSpec} (single port) /
 *  {@link expandForwardSpec} (port ranges). Forwards only reach the guest over a
 *  user-mode (`"user"`) NIC — see the networking recipes guide
 *  (`docs/networking-recipes.md`) for which mechanism fits which traffic shape. */
export interface PortMapping {
	/** Label for this forward; also the key in `MachineState.ports` and what
	 *  `quickchr list` shows. Must be unique within a machine. */
	name: string;
	/** Host-side port. `0` (or omitted) auto-allocates from the instance's port block. */
	host: number;
	/** Guest-side (RouterOS) port the forward targets. */
	guest: number;
	/** Transport — carried verbatim into the `hostfwd` directive. `udp` is fully
	 *  supported (e.g. SNMP, syslog, bandwidth-test data ports). */
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

/**
 * Facts about the SSH keypair quickchr generated and installed for its managed
 * user during provisioning. Persisted on {@link MachineState} so consumers (the
 * #71 descriptor contract) can advertise SSH private-key batch auth as usable —
 * but only when `batchVerified` is true. See `test/lab/ssh-keys/REPORT.md`.
 */
export interface ManagedSshKey {
	/** Absolute path to the private key on the host (public key is `${path}.pub`). */
	privateKeyPath: string;
	/** Key algorithm. Currently always `ed25519` — grounded across quickchr's
	 *  provisioning floor and current stable in REPORT.md (issue #74). */
	algorithm: string;
	/** True only when a host-OpenSSH `BatchMode=yes` / `PasswordAuthentication=no`
	 *  login with this key actually succeeded — not merely that the key appears in
	 *  RouterOS's `/user/ssh-keys` listing. This is the signal #71 gates on. */
	batchVerified: boolean;
	/** ISO timestamp of the successful batch verification, when one happened. */
	verifiedAt?: string;
}

export interface MachineState extends MachineConfig {
	createdAt: string;
	lastStartedAt?: string;
	status: "stopped" | "running" | "error";
	pid?: number;
	/** Path to the machine directory. */
	machineDir: string;
	/** Accelerator resolved for the most recent boot ("kvm" | "hvf" | "tcg"). */
	lastAccel?: string;
	/** Wall-clock ms from QEMU spawn to REST-ready for the most recent boot. */
	lastBootMs?: number;
	/** Managed SSH key installed during provisioning, if any (issue #74). */
	managedSshKey?: ManagedSshKey;
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
	/** RouterOS version to use (e.g. "7.22.1"). Mutually exclusive with `channel`.
	 *  As a convenience, a channel name (e.g. "long-term") is also accepted here and
	 *  resolves the same as `channel: "long-term"` — but this emits a warning, since
	 *  `channel` is the self-documenting field for that case. */
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
	/** Convenience alias: `noAuth: true` is equivalent to `secureLogin: false` —
	 *  skip the managed `quickchr` user provisioning, leave admin password-less.
	 *  Self-documenting alternative for callers who find `secureLogin: false` cryptic.
	 *  When both are set, an explicit `secureLogin` value wins. */
	noAuth?: boolean;
	/** Starting port number for this instance's port block. Auto-allocated if omitted. */
	portBase?: number;
	/** Services to exclude from port mappings (e.g. ["winbox", "api-ssl"]). */
	excludePorts?: ServiceName[];
	/** Additional host→guest port forwards appended to the default service set —
	 *  the library equivalent of the CLI `--forward` flag. Each becomes one SLIRP
	 *  `hostfwd` directive and only works over a `"user"` NIC.
	 *
	 *  `proto` may be `"tcp"` or `"udp"`. To turn CLI-style spec strings into this
	 *  array, use {@link parseForwardSpec} (single port) or {@link expandForwardSpec}
	 *  (port ranges, e.g. dynamic UDP data ports). `WELL_KNOWN_GUEST_PORTS` /
	 *  {@link lookupGuestPort} resolve guest port + proto for common service names.
	 *
	 *  For *receiving* guest-originated UDP (no forward needed), see
	 *  {@link ChrInstance.tzspGatewayIp} and `docs/networking-recipes.md`.
	 *  @example
	 *  extraPorts: [{ name: "snmp", host: 9161, guest: 161, proto: "udp" }]
	 *  @example
	 *  // dynamic UDP data ports via a range spec:
	 *  extraPorts: expandForwardSpec("btest:9200-9210:2000-2010/udp")
	 */
	extraPorts?: PortMapping[];
	/** @deprecated Use `networks` instead. Kept for backward compatibility. */
	network?: NetworkMode;
	/** Network interfaces — the library equivalent of repeated `--add-network` flags.
	 *  Each entry becomes a NIC on the CHR, in order (so `networks[0]` is ether1).
	 *  Default (when omitted): a single `"user"` NIC.
	 *  When specified: count of entries = count of NICs (explicit control).
	 *
	 *  Keep `"user"` first for management/`hostfwd`; add a second NIC for L2 work.
	 *  See {@link NetworkSpecifier} for which specifier fits which traffic shape,
	 *  and `docs/networking-recipes.md` / `docs/mndp.md` for runnable recipes.
	 *  @example
	 *  // management + host-visible L2 (e.g. to receive MNDP on the host):
	 *  networks: ["user", { type: "socket-connect", port: hostTcpServerPort }]
	 */
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

// --- Descriptor v1 (centrs interface contract) ---
//
// Live, credential-bearing connection-handoff shape for a *running* CHR instance —
// the quickchr <-> centrs interface contract (issue #71). Full contract, per-service
// mapping rules, and scope boundaries: docs/centrs-interface.md.

/** Canonical service IDs for {@link Descriptor.services}, matching centrs' `--via`
 *  values verbatim. Exported as constants for TS ergonomics
 *  (`SERVICE_IDS.nativeApi === "native-api"`) while the serialized JSON key stays the
 *  canonical string. See docs/centrs-interface.md "Service naming decision". */
export const SERVICE_IDS = {
	restApi: "rest-api",
	nativeApi: "native-api",
	ssh: "ssh",
} as const;

/** Schema compatibility boundary for {@link Descriptor}. Changes within a version are
 *  additive-only (new optional fields/keys); bump only for a breaking restructure.
 *  See docs/centrs-interface.md "Forward-compat policy". */
export const QUICKCHR_DESCRIPTOR_VERSION = 1 as const;

/** Per-service endpoint shape, deliberately shared with centrs' internal
 *  `ServiceEndpoint` (tikoci/centrs#174) for `rest-api`/`native-api`. A consumer must
 *  gate on `available` before dialing — the `available: false` variant's extra fields
 *  are best-effort echoes, not a promise the endpoint is reachable.
 *  See docs/centrs-interface.md "ServiceEndpoint (rest-api, native-api)". */
export type ServiceEndpoint =
	| {
			available: true;
			/** Hostname/IP — always `"127.0.0.1"` for quickchr's SLiRP-forwarded loopback
			 *  ports. NOT a port; see the `PortMapping.host` naming-collision note in
			 *  docs/centrs-interface.md. */
			host: string;
			port: number;
			guestPort?: number;
			transport: "tcp" | "udp";
			/** true for https/apiSsl-backed endpoints, false otherwise. */
			tls: boolean;
			url?: string;
			source?: { provider: "quickchr"; portMappingName?: string };
			auth?: { username: string; password?: string; basic?: string; header?: string };
	  }
	| {
			available: false;
			unavailableReason: string;
			host?: string;
			port?: number;
			guestPort?: number;
			transport?: "tcp" | "udp";
			tls?: boolean;
			url?: string;
			source?: { provider: "quickchr"; portMappingName?: string };
	  };

/** SSH's per-endpoint shape. Extends the generic {@link ServiceEndpoint}'s
 *  available/host/port/transport/source discriminated union with an SSH-specific
 *  `auth` sub-shape substituted for the REST/native-api auth object — NOT an
 *  independent type. See docs/centrs-interface.md "SshServiceEndpoint". */
export type SshServiceEndpoint =
	| ({ available: true } & Omit<Extract<ServiceEndpoint, { available: true }>, "auth"> & {
				auth: {
					/** `state.user?.name ?? "admin"`. */
					username: string;
					/** `managedSshKey.privateKeyPath` — ONLY set when `batchVerified === true`.
					 *  Never emit an unverified path. */
					privateKeyPath?: string;
					/** Modes centrs *may* try (broader, not all vouched-for). */
					modes: Array<"private-key" | "agent-or-config" | "password">;
					/** The gate centrs enforces for `--via ssh` / `transfer --via sftp` — only
					 *  modes quickchr actually vouches for. */
					batchModes: Array<"private-key" | "agent-or-config">;
					passwordAvailable?: boolean;
				};
	  })
	| Extract<ServiceEndpoint, { available: false }>;

/** Generic extra port-forward listing beyond the three canonical `services` keys
 *  (e.g. `winbox`, or a user's `extraPorts`). Descriptor-specific shape — do not leak
 *  internal `PortMapping` field names (there, `host` is a port number; here it's a
 *  hostname). See docs/centrs-interface.md "CustomForward". */
export interface CustomForward {
	name: string;
	transport: "tcp" | "udp";
	host: string;
	hostPort: number;
	guestPort: number;
}

/** Topology-only awareness of a machine's network interfaces — declarative, not a
 *  resolved connection fact. Do not add `available`/`host`/`port` here; that would
 *  imply a resolved-connection promise quickchr can't keep for DHCP-assigned segments.
 *  See docs/centrs-interface.md "Multi-network awareness". */
export interface NetworkTopologyEntry {
	/** Matches `NetworkConfig.id` / boot order (`"net0"` = ether1). */
	id: string;
	/** Verbatim declared intent from `state.networks[].specifier`. */
	specifier: NetworkSpecifier;
}

/** Live, credential-bearing connection-handoff descriptor for a *running* CHR
 *  instance — the quickchr <-> centrs interface contract (issue #71).
 *  `descriptor()` only ever returns this running shape; stopped machines throw
 *  `MACHINE_STOPPED` as today. A missing machine name never reaches this type —
 *  `QuickCHR.get(name)` returns `undefined` for that case (a typed absent value;
 *  no separate `MACHINE_NOT_FOUND` throw from this surface).
 *  See docs/centrs-interface.md "Descriptor v1 shape". */
export interface Descriptor {
	descriptorVersion: 1;
	quickchr: { packageVersion: string };
	status: "running";

	name: string;
	version: string;
	arch: Arch;
	cpu: number;
	mem: number;
	pid: number | null;
	machineDir: string;
	createdAt: string;
	lastStartedAt: string | null;

	services: {
		"rest-api": ServiceEndpoint;
		"native-api": ServiceEndpoint;
		ssh: SshServiceEndpoint;
	};

	/** Only present when quickchr has forwards beyond the three `services` keys
	 *  above (e.g. `winbox`, or a user's `extraPorts`). */
	customForwards?: CustomForward[];
	/** Topology-only; SLiRP-forwarded connection facts stay in `services`. */
	networks?: NetworkTopologyEntry[];
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
	/** Port block base for this instance. Useful for picking L2 socket ports
	 *  that won't collide with this instance's management ports.
	 *  Each block occupies `PORTS_PER_BLOCK` (10) consecutive ports starting here.
	 *  @example
	 *  // Pick a socket port outside any running instance's block:
	 *  const socketPort = Math.max(...instances.map(i => i.portBase)) + PORTS_PER_BLOCK;
	 */
	portBase: number;
	/** Platform-appropriate network interface for capturing TZSP traffic from this instance.
	 *  `"lo0"` on macOS — QEMU user-mode (slirp) routes guest UDP through the host loopback.
	 *  `"any"` on Linux — TZSP arrives on whichever interface the host routes it to.
	 *  Pass directly to tshark: `tshark -i ${instance.captureInterface} -f "udp port 37008"`
	 *  Only meaningful when the instance has a user-mode (`"user"`) network interface. */
	captureInterface: string;
	/** QEMU user-mode (SLIRP) gateway IP — the host's address as seen from inside the VM.
	 *  Always `"10.0.2.2"` for QEMU slirp user-mode networking.
	 *
	 *  This is the general **guest→host UDP** primitive, not just for TZSP: any
	 *  datagram the guest sends to `10.0.2.2:<port>` is delivered to a host process
	 *  bound on loopback at `<port>` (capture it on {@link captureInterface}) with
	 *  **no `hostfwd` and no extra NIC**. The host socket must be left **unconnected**
	 *  (use `recvfrom`, not `connect`) — a connected socket filters out the
	 *  gateway-origin datagrams. This covers guest-originated UDP (syslog, NetFlow,
	 *  TZSP) and a guest server replying to the gateway. Recipe + lab evidence:
	 *  `docs/networking-recipes.md`, `examples/udp-gateway/`.
	 *  @example
	 *  // RouterOS TZSP sniffer streaming to the host:
	 *  await instance.exec(`/tool/sniffer/set streaming-server=${instance.tzspGatewayIp}:37008`);
	 */
	tzspGatewayIp: string;

	/** Check or wait for REST API readiness.
	 *  After `QuickCHR.start()` with provisioning options (installAllPackages, license, etc.),
	 *  the returned instance is already REST-reachable — this returns immediately.
	 *  Call this only when starting without provisioning, or as a safety check after a manual stop/restart. */
	waitForBoot(timeoutMs?: number): Promise<boolean>;
	/** Poll a condition until it returns true or the timeout elapses.
	 *  Retries every 2 s, swallowing errors from the condition function.
	 *  Returns `true` when the condition passes, `false` on timeout.
	 *
	 *  Useful for waiting on RouterOS state that isn't reflected in the boot readiness
	 *  check — e.g. waiting for a package to become active, a daemon to enable, or a
	 *  background script to complete.
	 *
	 *  @param condition  Async predicate: return `true` when the desired state is reached.
	 *  @param timeoutMs  Maximum wait in milliseconds (default: 30 000).
	 *  @example
	 *  // Wait for the Dude daemon to report enabled=yes
	 *  const ready = await instance.waitFor(async () => {
	 *    const r = await instance.exec("/dude/print");
	 *    return r.output.includes("enabled: yes");
	 *  }, 30_000);
	 */
	waitFor(condition: () => Promise<boolean>, timeoutMs?: number): Promise<boolean>;
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
	/** Run a RouterOS CLI command against the instance.
	 *
	 *  **Single command per call.** RouterOS `/rest/execute` runs the input as one
	 *  script statement; a multi-line `command` string with `\n`-separated commands
	 *  may execute only the first line and silently ignore the rest depending on
	 *  RouterOS version. To run several commands, call `exec()` multiple times, or
	 *  wrap them in an explicit RouterOS script: `:do { /cmd1; /cmd2 }`.
	 *
	 *  **Soft errors.** Some RouterOS commands return HTTP 200 with an error
	 *  string in `output` (e.g. `/dude/agent/add` may resolve OK with
	 *  `"doAdd Agent not implemented"`). `exec()` does not parse output for these
	 *  patterns — inspect `result.output` if you need to assert success.
	 */
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
	/** Build a stable machine-readable connection descriptor for a running instance —
	 *  the quickchr <-> centrs interface contract (issue #71, docs/centrs-interface.md). */
	descriptor(): Promise<Descriptor>;

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
	| "STATE_ERROR"
	| "INVALID_SIZE_STRING"
	| "INVALID_SETTING_KEY"
	| "INVALID_SETTING_VALUE";

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
