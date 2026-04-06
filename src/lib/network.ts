/**
 * Port allocation and conflict detection for QEMU user-mode networking.
 */

import {
	DEFAULT_PORT_BASE,
	PORTS_PER_BLOCK,
	type ChrPorts,
	type PortMapping,
	type ServiceName,
	SERVICE_PORTS,
	QuickCHRError,
} from "./types.ts";

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

/** Check if a TCP port is available by attempting to listen on it.
 *  Binds to 0.0.0.0 (wildcard) to match how QEMU sets up hostfwd.
 *  On macOS, binding 127.0.0.1 can succeed even when 0.0.0.0 is already
 *  claimed (SO_REUSEADDR + different local address), giving a false positive.
 *  Using 0.0.0.0 detects all conflicts. */
export async function isPortAvailable(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		try {
			const server = Bun.listen({
				hostname: "0.0.0.0",
				port,
				socket: {
					data() {},
					open() {},
					close() {},
					error() {},
				},
			});
			server.stop();
			resolve(true);
		} catch {
			resolve(false);
		}
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
