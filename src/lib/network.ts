/**
 * Port allocation, network specifier utilities, conflict detection, and
 * platform-aware network resolution.
 */

import { createConnection } from "node:net";
import {
	DEFAULT_PORT_BASE,
	PORTS_PER_BLOCK,
	type ChrPorts,
	type NetworkConfig,
	type NetworkMode,
	type NetworkSpecifier,
	type PlatformInfo,
	type PortMapping,
	type ResolvedNetwork,
	type ServiceName,
	type SocketVmnetInfo,
	SERVICE_PORTS,
	QuickCHRError,
} from "./types.ts";
import { getNamedSocket } from "./socket-registry.ts";
import { resolveInterfaceAlias, isSocketVmnetDaemonRunning } from "./platform.ts";

/** Allocate a port block for a new instance, avoiding conflicts with existing machines. */
export function allocatePortBlock(
	usedBases: number[],
	requestedBase?: number,
): number {
	if (requestedBase !== undefined) {
		return requestedBase;
	}

	let base = DEFAULT_PORT_BASE;
	const sorted = [...usedBases].sort((a, b) => a - b);

	for (const used of sorted) {
		if (base >= used && base < used + PORTS_PER_BLOCK) {
			base = used + PORTS_PER_BLOCK;
		}
	}

	return base;
}

/** Build port mappings for an instance given a base port. */
export function buildPortMappings(
	portBase: number,
	excludePorts: ServiceName[] = [],
	extraPorts: PortMapping[] = [],
): Record<string, PortMapping> {
	const mappings: Record<string, PortMapping> = {};

	for (const [name, spec] of Object.entries(SERVICE_PORTS)) {
		if (excludePorts.includes(name as ServiceName)) continue;
		mappings[name] = {
			name,
			host: portBase + spec.offset,
			guest: spec.guest,
			proto: spec.proto,
		};
	}

	// Add custom port mappings at offset 6+
	for (let i = 0; i < extraPorts.length; i++) {
		const extra = extraPorts[i];
		if (!extra) continue;
		const name = extra.name || `custom-${i}`;
		mappings[name] = {
			name,
			host: extra.host || portBase + 6 + i,
			guest: extra.guest,
			proto: extra.proto,
		};
	}

	return mappings;
}

/** Build QEMU hostfwd string from port mappings. */
export function buildHostfwdString(ports: Record<string, PortMapping>): string {
	return Object.values(ports)
		.map((p) => `hostfwd=${p.proto}::${p.host}-:${p.guest}`)
		.join(",");
}

/** Check if a TCP port is available on localhost.
 *  Uses a connect probe: if anything is actively listening, the connect
 *  succeeds and we return false.  ECONNREFUSED means nothing is listening.
 *  This approach is immune to SO_REUSEADDR/SO_REUSEPORT semantics that
 *  can cause bind-based checks to give false positives on macOS when a
 *  wildcard (0.0.0.0) listener is present. */
export async function isPortAvailable(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection({ host: "127.0.0.1", port });
		socket.setTimeout(300);
		socket.on("connect", () => {
			socket.destroy();
			resolve(false); // Something is listening — port occupied
		});
		socket.on("error", (err: Error & { code?: string }) => {
			resolve(err.code === "ECONNREFUSED");
		});
		socket.on("timeout", () => {
			socket.destroy();
			resolve(true); // Nothing answered in time — treat as available
		});
	});
}

/** Check all ports in a mapping for availability. Returns conflicting ports. */
export async function checkPortConflicts(
	ports: Record<string, PortMapping>,
): Promise<PortMapping[]> {
	const conflicts: PortMapping[] = [];

	for (const mapping of Object.values(ports)) {
		const available = await isPortAvailable(mapping.host);
		if (!available) {
			conflicts.push(mapping);
		}
	}

	return conflicts;
}

/** Find the next available port block that has no conflicts. */
export async function findAvailablePortBlock(
	usedBases: number[],
	excludePorts: ServiceName[] = [],
	extraPorts: PortMapping[] = [],
	startBase?: number,
): Promise<number> {
	let base = startBase ?? allocatePortBlock(usedBases);
	const maxAttempts = 20;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const mappings = buildPortMappings(base, excludePorts, extraPorts);
		const conflicts = await checkPortConflicts(mappings);
		if (conflicts.length === 0) {
			return base;
		}
		base += PORTS_PER_BLOCK;
	}

	throw new QuickCHRError(
		"PORT_CONFLICT",
		`Could not find available port block after ${maxAttempts} attempts (tried ${startBase ?? DEFAULT_PORT_BASE}–${base})`,
	);
}

/** Extract ChrPorts from port mappings. */
export function toChrPorts(ports: Record<string, PortMapping>): ChrPorts {
	const result: Record<string, number> = {};
	for (const [name, mapping] of Object.entries(ports)) {
		// Convert kebab-case to camelCase for API
		const key = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
		result[key] = mapping.host;
	}
	return result as ChrPorts;
}

// ── Network config helpers ──────────────────────────────────────────

/** Convert a legacy `NetworkMode` to the new `NetworkConfig[]` format. */
export function networkModeToConfigs(mode: NetworkMode): NetworkConfig[] {
	if (mode === "vmnet-shared") {
		return [{ specifier: "vmnet-shared", id: "net0" }];
	}
	if (typeof mode === "object" && mode.type === "vmnet-bridge") {
		return [
			{ specifier: { type: "vmnet-bridged", iface: mode.iface }, id: "net0" },
			// Old behavior added a management vmnet-shared NIC too
			{ specifier: "vmnet-shared", id: "net1" },
		];
	}
	return [{ specifier: "user", id: "net0" }];
}

/** Parse a user-provided network specifier string into a `NetworkSpecifier`. */
export function parseNetworkSpecifier(input: string): NetworkSpecifier {
	const trimmed = input.trim();
	if (!trimmed) {
		throw new QuickCHRError("INVALID_NETWORK", "Empty network specifier");
	}

	// Exact literal matches
	switch (trimmed) {
		case "user":
			return "user";
		case "shared":
		case "auto":
			return "shared";
		case "vmnet-shared":
			return "vmnet-shared";
		case "wifi":
			return { type: "bridged", iface: "wifi" };
		case "ethernet":
			return { type: "bridged", iface: "ethernet" };
	}

	// bridged:<iface>
	if (trimmed.startsWith("bridged:")) {
		const iface = trimmed.slice("bridged:".length);
		if (!iface) {
			throw new QuickCHRError(
				"INVALID_NETWORK",
				"bridged: requires an interface name (e.g. bridged:en0)",
			);
		}
		return { type: "bridged", iface };
	}

	// vmnet-bridged:<iface>
	if (trimmed.startsWith("vmnet-bridged:")) {
		const iface = trimmed.slice("vmnet-bridged:".length);
		if (!iface) {
			throw new QuickCHRError(
				"INVALID_NETWORK",
				"vmnet-bridged: requires an interface name (e.g. vmnet-bridged:en0)",
			);
		}
		return { type: "vmnet-bridged", iface };
	}

	// tap:<ifname>
	if (trimmed.startsWith("tap:")) {
		const ifname = trimmed.slice("tap:".length);
		if (!ifname) {
			throw new QuickCHRError(
				"INVALID_NETWORK",
				"tap: requires an interface name (e.g. tap:tap-chr0)",
			);
		}
		return { type: "tap", ifname };
	}

	// socket:<subtype>:<arg>
	if (trimmed.startsWith("socket:")) {
		return parseSocketSpecifier(trimmed);
	}

	throw new QuickCHRError(
		"INVALID_NETWORK",
		`Unknown network specifier: "${trimmed}"`,
	);
}

function parseSocketSpecifier(input: string): NetworkSpecifier {
	// socket::name → named socket
	if (input.startsWith("socket::")) {
		const name = input.slice("socket::".length);
		if (!name) {
			throw new QuickCHRError(
				"INVALID_NETWORK",
				"socket:: requires a link name (e.g. socket::mylink)",
			);
		}
		return { type: "socket", name };
	}

	const parts = input.split(":");
	const subtype = parts[1];

	if (subtype === "listen" || subtype === "connect") {
		const port = Number(parts[2]);
		if (!parts[2] || !Number.isInteger(port) || port < 1 || port > 65535) {
			throw new QuickCHRError(
				"INVALID_NETWORK",
				`socket:${subtype}: requires a valid port number (1–65535)`,
			);
		}
		return { type: `socket-${subtype}`, port };
	}

	if (subtype === "mcast") {
		// socket:mcast:<group>:<port>
		const group = parts[2];
		const port = Number(parts[3]);
		if (
			!group ||
			!parts[3] ||
			!Number.isInteger(port) ||
			port < 1 ||
			port > 65535
		) {
			throw new QuickCHRError(
				"INVALID_NETWORK",
				"socket:mcast requires group and port (e.g. socket:mcast:230.0.0.1:4001)",
			);
		}
		return { type: "socket-mcast", group, port };
	}

	throw new QuickCHRError(
		"INVALID_NETWORK",
		`Unknown socket subtype: "${subtype}" in "${input}"`,
	);
}

/** Build default `NetworkConfig[]` from `StartOptions.networks` or legacy `network`. */
export function resolveStartNetworks(
	networks?: NetworkSpecifier[],
	legacyNetwork?: NetworkMode,
): NetworkConfig[] {
	if (networks && networks.length > 0) {
		return networks.map((specifier, i) => ({
			specifier,
			id: `net${i}`,
		}));
	}
	if (legacyNetwork) {
		return networkModeToConfigs(legacyNetwork);
	}
	return [{ specifier: "user", id: "net0" }];
}

/** Returns true when at least one network uses QEMU user-mode (hostfwd) networking.
 *  Only user-mode networks forward localhost ports — shared/bridged/tap/socket networks
 *  assign a DHCP address that is not reachable from host localhost. */
export function hasUserModeNetwork(networks: NetworkConfig[]): boolean {
	return networks.some((n) => n.specifier === "user");
}

// ── Platform-aware network resolution ───────────────────────────────

export interface ResolutionContext {
	platform: PlatformInfo;
	socketVmnet?: SocketVmnetInfo;
}

function deviceArgs(id: string): string[] {
	return ["-device", `virtio-net-pci,netdev=${id}`];
}

function resolveUser(
	config: NetworkConfig,
	hostfwd: string,
): ResolvedNetwork {
	const netdevValue = hostfwd
		? `user,id=${config.id},${hostfwd}`
		: `user,id=${config.id}`;
	return {
		qemuNetdevArgs: [
			"-netdev", netdevValue,
			...deviceArgs(config.id),
		],
	};
}

function resolveShared(
	config: NetworkConfig,
	ctx: ResolutionContext,
): ResolvedNetwork {
	if (ctx.platform.os === "darwin") {
		const svn = ctx.socketVmnet ?? ctx.platform.socketVmnet;
		if (svn?.sharedSocket) {
			if (!isSocketVmnetDaemonRunning(svn.sharedSocket)) {
				throw new QuickCHRError(
					"NETWORK_UNAVAILABLE",
					`socket_vmnet daemon is not running (socket not found: ${svn.sharedSocket})`,
					"Start it with: sudo brew services start socket_vmnet",
				);
			}
			return {
				qemuNetdevArgs: [
					"-netdev", `socket,id=${config.id},fd=3`,
					...deviceArgs(config.id),
				],
				wrapper: [svn.client, svn.sharedSocket],
			};
		}
		return {
			qemuNetdevArgs: [
				"-netdev", `vmnet-shared,id=${config.id}`,
				...deviceArgs(config.id),
			],
			downgraded: {
				from: "shared (socket_vmnet)",
				reason: "Requires root — socket_vmnet not available",
			},
		};
	}
	throw new QuickCHRError(
		"NETWORK_UNAVAILABLE",
		`"shared" network is not yet supported on ${ctx.platform.os} (TAP support planned)`,
	);
}

function resolveVmnetShared(
	config: NetworkConfig,
	ctx: ResolutionContext,
): ResolvedNetwork {
	if (ctx.platform.os !== "darwin") {
		throw new QuickCHRError(
			"NETWORK_UNAVAILABLE",
			"vmnet-shared is macOS only",
		);
	}
	return {
		qemuNetdevArgs: [
			"-netdev", `vmnet-shared,id=${config.id}`,
			...deviceArgs(config.id),
		],
	};
}

function resolveBridged(
	config: NetworkConfig,
	iface: string,
	ctx: ResolutionContext,
): ResolvedNetwork {
	if (ctx.platform.os === "darwin") {
		const resolved = resolveInterfaceAlias(iface);
		const svn = ctx.socketVmnet ?? ctx.platform.socketVmnet;
		const bridgeSocket = svn?.bridgedSockets[resolved];
		if (svn && bridgeSocket) {
			if (!isSocketVmnetDaemonRunning(bridgeSocket)) {
				throw new QuickCHRError(
					"NETWORK_UNAVAILABLE",
					`socket_vmnet bridged daemon is not running (socket not found: ${bridgeSocket})`,
					"Start it with: sudo brew services start socket_vmnet",
				);
			}
			return {
				qemuNetdevArgs: [
					"-netdev", `socket,id=${config.id},fd=3`,
					...deviceArgs(config.id),
				],
				wrapper: [svn.client, bridgeSocket],
			};
		}
		return {
			qemuNetdevArgs: [
				"-netdev", `vmnet-bridged,id=${config.id},ifname=${resolved}`,
				...deviceArgs(config.id),
			],
			downgraded: {
				from: `bridged:${iface} (socket_vmnet)`,
				reason: "Requires root — socket_vmnet not available",
			},
		};
	}
	throw new QuickCHRError(
		"NETWORK_UNAVAILABLE",
		`"bridged" network is not yet supported on ${ctx.platform.os} (TAP bridge support planned)`,
	);
}

function resolveVmnetBridged(
	config: NetworkConfig,
	iface: string,
	ctx: ResolutionContext,
): ResolvedNetwork {
	if (ctx.platform.os !== "darwin") {
		throw new QuickCHRError(
			"NETWORK_UNAVAILABLE",
			"vmnet-bridged is macOS only",
		);
	}
	return {
		qemuNetdevArgs: [
			"-netdev", `vmnet-bridged,id=${config.id},ifname=${iface}`,
			...deviceArgs(config.id),
		],
	};
}

function resolveSocketNamed(
	config: NetworkConfig,
	name: string,
): ResolvedNetwork {
	const entry = getNamedSocket(name);
	if (!entry) {
		throw new QuickCHRError(
			"NETWORK_UNAVAILABLE",
			`Named socket "${name}" not found — create it first with 'quickchr network create ${name}'`,
		);
	}
	if (entry.mode === "mcast") {
		return {
			qemuNetdevArgs: [
				"-netdev", `socket,id=${config.id},mcast=${entry.mcastGroup}:${entry.port}`,
				...deviceArgs(config.id),
			],
		};
	}
	const isFirst = entry.members.length === 0;
	const netdevArg = isFirst
		? `socket,id=${config.id},listen=:${entry.port}`
		: `socket,id=${config.id},connect=127.0.0.1:${entry.port}`;
	return {
		qemuNetdevArgs: [
			"-netdev", netdevArg,
			...deviceArgs(config.id),
		],
	};
}

function resolveSocketListen(
	config: NetworkConfig,
	port: number,
): ResolvedNetwork {
	return {
		qemuNetdevArgs: [
			"-netdev", `socket,id=${config.id},listen=:${port}`,
			...deviceArgs(config.id),
		],
	};
}

function resolveSocketConnect(
	config: NetworkConfig,
	port: number,
): ResolvedNetwork {
	return {
		qemuNetdevArgs: [
			"-netdev", `socket,id=${config.id},connect=127.0.0.1:${port}`,
			...deviceArgs(config.id),
		],
	};
}

function resolveSocketMcast(
	config: NetworkConfig,
	group: string,
	port: number,
): ResolvedNetwork {
	return {
		qemuNetdevArgs: [
			"-netdev", `socket,id=${config.id},mcast=${group}:${port}`,
			...deviceArgs(config.id),
		],
	};
}

function resolveTap(
	config: NetworkConfig,
	ifname: string,
	ctx: ResolutionContext,
): ResolvedNetwork {
	if (ctx.platform.os !== "linux") {
		throw new QuickCHRError(
			"NETWORK_UNAVAILABLE",
			"TAP networking is Linux only",
		);
	}
	return {
		qemuNetdevArgs: [
			"-netdev", `tap,id=${config.id},ifname=${ifname},script=no,downscript=no`,
			...deviceArgs(config.id),
		],
	};
}

/** Resolve a single NetworkConfig's specifier into QEMU arguments for the current platform. */
export function resolveNetworkConfig(
	config: NetworkConfig,
	ctx: ResolutionContext,
	hostfwd = "",
): NetworkConfig {
	const spec = config.specifier;
	let resolved: ResolvedNetwork;

	if (spec === "user") {
		resolved = resolveUser(config, hostfwd);
	} else if (spec === "shared") {
		resolved = resolveShared(config, ctx);
	} else if (spec === "vmnet-shared") {
		resolved = resolveVmnetShared(config, ctx);
	} else if (typeof spec === "object") {
		switch (spec.type) {
			case "bridged":
				resolved = resolveBridged(config, spec.iface, ctx);
				break;
			case "vmnet-bridged":
				resolved = resolveVmnetBridged(config, spec.iface, ctx);
				break;
			case "socket":
				resolved = resolveSocketNamed(config, spec.name);
				break;
			case "socket-listen":
				resolved = resolveSocketListen(config, spec.port);
				break;
			case "socket-connect":
				resolved = resolveSocketConnect(config, spec.port);
				break;
			case "socket-mcast":
				resolved = resolveSocketMcast(config, spec.group, spec.port);
				break;
			case "tap":
				resolved = resolveTap(config, spec.ifname, ctx);
				break;
			default:
				throw new QuickCHRError(
					"INVALID_NETWORK",
					`Unknown network specifier type: ${(spec as { type: string }).type}`,
				);
		}
	} else {
		throw new QuickCHRError(
			"INVALID_NETWORK",
			`Unknown network specifier: ${String(spec)}`,
		);
	}

	return { ...config, resolved };
}

/** Resolve all network configs and check for conflicts. */
export function resolveAllNetworks(
	configs: NetworkConfig[],
	ctx: ResolutionContext,
	hostfwd = "",
): NetworkConfig[] {
	const resolved = configs.map((c) => resolveNetworkConfig(c, ctx, hostfwd));

	const userCount = configs.filter((c) => c.specifier === "user").length;
	if (userCount > 1) {
		throw new QuickCHRError(
			"INVALID_NETWORK",
			`Multiple user-mode NICs (${userCount}) — QEMU only supports one user-mode netdev reliably`,
		);
	}

	const wrappers = resolved.filter((c) => c.resolved?.wrapper);
	if (wrappers.length > 1) {
		throw new QuickCHRError(
			"INVALID_NETWORK",
			"Multiple networks require socket_vmnet wrappers — only one wrapper is supported per QEMU process",
		);
	}

	return resolved;
}
