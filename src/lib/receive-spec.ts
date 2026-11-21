/**
 * Guest→host receive slots (#299): the `--receive` spec grammar, the descriptor form,
 * and the cross-machine collision check.
 *
 * Grammar `name[:port][/proto]`:
 *
 * - `name` — required, case-insensitive, stored lowercase (it is the descriptor's key).
 *   A name in `WELL_KNOWN_RECEIVE_PORTS` fills a missing `port` and `proto`.
 * - `port` — the host loopback port, which is also the port the guest sends to at the
 *   gateway (SLIRP does not translate it). Required for a name the registry lacks.
 * - `proto` — `udp` or `tcp`. Defaults from the registry, else `udp`.
 *
 * Ports are explicit or registry defaults; they are not allocated from the machine's
 * port block (that waits for #57). Pure: no I/O.
 */

import { lookupReceivePort } from "./guest-ports.ts";
import { shellQuote } from "./names.ts";
import { HOST_GATEWAY_IP, type MachineState, PORTS_PER_BLOCK, type PortMapping, QuickCHRError, type ReceiveEndpoint, type ReceivePort } from "./types.ts";

function fail(spec: string, reason: string): never {
	throw new QuickCHRError("INVALID_RECEIVE_SPEC", `Invalid --receive spec "${spec}": ${reason}`);
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

export function parseReceiveSpec(spec: string): ReceivePort {
	const trimmed = spec?.trim() ?? "";
	if (!trimmed) throw new QuickCHRError("INVALID_RECEIVE_SPEC", "Empty --receive spec");

	let body = trimmed;
	let protoStr: string | undefined;
	const slash = trimmed.lastIndexOf("/");
	if (slash !== -1) {
		body = trimmed.slice(0, slash);
		protoStr = trimmed.slice(slash + 1).toLowerCase();
		if (protoStr !== "tcp" && protoStr !== "udp") fail(spec, `protocol must be "udp" or "tcp", got "${protoStr}"`);
	}

	const parts = body.split(":");
	if (parts.length > 2) fail(spec, `too many ":" segments (expected name[:port]) — a receive slot has one port, used on both sides`);
	const name = (parts[0] ?? "").trim().toLowerCase();
	if (!name) fail(spec, "name is required");
	if (!NAME_RE.test(name)) fail(spec, `name "${name}" may use only letters, digits, "-" and "_"`);

	const known = lookupReceivePort(name);
	let port: number;
	const rawPort = parts[1]?.trim();
	if (rawPort) {
		if (!/^\d+$/.test(rawPort)) fail(spec, `port "${rawPort}" is not a number`);
		port = Number(rawPort);
		if (port < 1 || port > 65535) fail(spec, `port ${port} out of range (1-65535)`);
	} else if (known) {
		port = known.defaultPort;
	} else {
		fail(spec, `a port is required for "${name}" (known names: tzsp, netflow, ipfix, syslog) — e.g. ${name}:9400`);
	}

	const proto = (protoStr as "tcp" | "udp" | undefined) ?? known?.proto ?? "udp";
	return { name, port, proto };
}

/** Accept a `ReceivePort` from a library caller, normalized like a parsed spec. */
export function normalizeReceivePort(input: ReceivePort | string): ReceivePort {
	if (typeof input === "string") return parseReceiveSpec(input);
	const label = `${input?.name ?? ""}:${input?.port ?? ""}/${input?.proto ?? ""}`;
	const name = String(input?.name ?? "").trim().toLowerCase();
	if (!NAME_RE.test(name)) fail(label, `name "${input?.name ?? ""}" may use only letters, digits, "-" and "_"`);
	if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) fail(label, `port ${input.port} out of range (1-65535)`);
	if (input.proto !== "udp" && input.proto !== "tcp") fail(label, `protocol must be "udp" or "tcp"`);
	return { name, port: input.port, proto: input.proto };
}

export function receiveEndpoint(slot: ReceivePort): ReceiveEndpoint {
	return {
		transport: slot.proto,
		host: "127.0.0.1",
		hostPort: slot.port,
		guestHost: HOST_GATEWAY_IP,
		guestPort: slot.port,
	};
}

export function receiveEndpoints(slots: ReceivePort[] | undefined): Record<string, ReceiveEndpoint> {
	const out: Record<string, ReceiveEndpoint> = {};
	for (const slot of slots ?? []) out[slot.name] = receiveEndpoint(slot);
	return out;
}

type PortOwner = { machine: string; label: string };

/** The part of a machine the receive-slot check reads. `portBase` is optional so an
 *  in-flight creation's reservation can stand in for a machine. */
export type ReceiveCheckMachine = Pick<MachineState, "name" | "ports" | "receivePorts"> & { portBase?: number | undefined };

/** Every host port a machine holds: its whole port block (services, auto extras and,
 *  on Windows, QEMU's own monitor/serial/QGA TCP sockets at +6..+8), explicit forwards,
 *  and receive slots. */
function machinePorts(m: Pick<ReceiveCheckMachine, "ports" | "receivePorts" | "portBase">): Array<[number, string]> {
	const out: Array<[number, string]> = [];
	if (m.portBase) {
		for (let i = 0; i < PORTS_PER_BLOCK; i++) out.push([m.portBase + i, `port block ${m.portBase}–${m.portBase + PORTS_PER_BLOCK - 1}`]);
	}
	for (const p of Object.values(m.ports ?? {})) out.push([p.host, `forward "${p.name}"`]);
	for (const r of m.receivePorts ?? []) out.push([r.port, `receive "${r.name}"`]);
	return out;
}

/** Host ports held by other machines' receive slots — for the forward/block checks,
 *  which already see other machines' forwards. */
export function otherMachinesReceivePorts(machines: ReceiveCheckMachine[], ownName?: string): Set<number> {
	const out = new Set<number>();
	for (const m of machines) {
		if (ownName && m.name === ownName) continue;
		for (const r of m.receivePorts ?? []) out.add(r.port);
	}
	return out;
}

/**
 * Check receive slots about to be recorded on `ownName`.
 *
 * Refuses a duplicate name, a port another requested slot takes, a port inside this
 * machine's port block (`ownPortBase`) or forwarded by it (`ownPorts`), a port it
 * already receives on (`ownReceive`, minus same-name entries being replaced), and a
 * port inside any other machine's block or forwarded or received by it. A port clash is
 * `PORT_CONFLICT` and names the next free port, so a second machine's `tzsp` can take
 * `+1` without guessing.
 */
export function validateReceivePorts(
	requested: ReceivePort[],
	ownName: string,
	ownPorts: Record<string, PortMapping>,
	ownReceive: ReceivePort[],
	machines: ReceiveCheckMachine[],
	ownPortBase?: number,
): void {
	const taken = new Map<number, PortOwner>();
	for (const [port, label] of machinePorts({ ports: ownPorts, portBase: ownPortBase })) taken.set(port, { machine: ownName, label });
	const requestedNames = new Set(requested.map((r) => r.name));
	for (const r of ownReceive) {
		if (!requestedNames.has(r.name)) taken.set(r.port, { machine: ownName, label: `receive "${r.name}"` });
	}
	for (const m of machines) {
		if (m.name === ownName) continue;
		for (const [port, label] of machinePorts(m)) taken.set(port, { machine: m.name, label });
	}

	const seenNames = new Set<string>();
	for (const r of requested) {
		if (seenNames.has(r.name)) {
			throw new QuickCHRError("INVALID_RECEIVE_SPEC", `Receive slot "${r.name}" is given twice — each name maps to one port.`);
		}
		seenNames.add(r.name);
		const owner = taken.get(r.port);
		if (owner) {
			const where = owner.machine === ownName ? `this machine's ${owner.label}` : `machine "${owner.machine}" (${owner.label})`;
			const next = nextFreePort(r.port, taken);
			throw new QuickCHRError(
				"PORT_CONFLICT",
				`Receive port ${r.port} for "${r.name}" is already used by ${where}. Next free port: ${next} — e.g. --receive ${r.name}:${next}`,
			);
		}
		taken.set(r.port, { machine: ownName, label: `receive "${r.name}"` });
	}
}

/**
 * The receive slots a machine ends up with after removing `remove` (by name) and adding
 * `add`, validated as one change (#299). Pure: the caller saves the result, so a
 * refused change leaves the record as it was — `--no-receive syslog --receive
 * syslog:5515` cannot drop the old slot and then fail to add the new one.
 *
 * Adding a slot the machine already has with the same port and proto is a no-op; the
 * same name with a different port is `INVALID_RECEIVE_SPEC` unless that name is also
 * being removed.
 */
export function planReceiveChange(
	machine: Pick<MachineState, "name" | "ports" | "portBase" | "receivePorts">,
	add: ReceivePort[],
	remove: string[],
	machines: ReceiveCheckMachine[],
): ReceivePort[] {
	const removeSet = new Set(remove.map((n) => n.trim().toLowerCase()));
	const kept = (machine.receivePorts ?? []).filter((r) => !removeSet.has(r.name));
	const fresh: ReceivePort[] = [];
	for (const slot of add) {
		const have = kept.find((r) => r.name === slot.name);
		if (!have) {
			fresh.push(slot);
		} else if (have.port !== slot.port || have.proto !== slot.proto) {
			throw new QuickCHRError(
				"INVALID_RECEIVE_SPEC",
				`Machine "${machine.name}" already receives "${slot.name}" on ${have.port}/${have.proto}. Move it in one call: quickchr set ${shellQuote(machine.name)} --no-receive ${slot.name} --receive ${slot.name}:${slot.port}`,
			);
		}
	}
	validateReceivePorts(fresh, machine.name, machine.ports, kept, machines, machine.portBase);
	return [...kept, ...fresh];
}

function nextFreePort(from: number, taken: Map<number, PortOwner>): number {
	for (let p = from + 1; p <= 65535; p++) if (!taken.has(p)) return p;
	for (let p = from - 1; p >= 1024; p--) if (!taken.has(p)) return p;
	return from;
}
