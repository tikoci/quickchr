/**
 * Parse a CLI `--forward` spec into a `PortMapping`.
 *
 * Grammar: `name[:host[:guest]][/proto]`
 *
 * - `name` — required. If it matches a key/alias in `WELL_KNOWN_GUEST_PORTS`,
 *   missing `guest` and `proto` are filled from the registry. The original
 *   spelling (alias or canonical) is preserved as `name` so users see the
 *   label they typed in `quickchr list` / state.
 * - `host` — optional. When omitted (or 0), `buildPortMappings` auto-allocates
 *   a host port from the machine's port block.
 * - `guest` — optional only when `name` resolves in the registry; otherwise
 *   required.
 * - `proto` — optional. Defaults from registry, else `tcp`. Must be `tcp` or
 *   `udp`.
 *
 * Throws `QuickCHRError("INVALID_FORWARD_SPEC", ...)` with the original spec
 * embedded in the message on any parse error.
 */

import { lookupGuestPort } from "./guest-ports.ts";
import { type PortMapping, QuickCHRError } from "./types.ts";

function fail(spec: string, reason: string): never {
	throw new QuickCHRError(
		"INVALID_FORWARD_SPEC",
		`Invalid --forward spec "${spec}": ${reason}`,
	);
}

function parsePort(spec: string, raw: string, label: string, allowZero: boolean): number {
	if (!/^\d+$/.test(raw)) {
		fail(spec, `${label} port "${raw}" is not a number`);
	}
	const n = Number(raw);
	const min = allowZero ? 0 : 1;
	if (n < min || n > 65535) {
		fail(spec, `${label} port ${n} out of range (${min}-65535)`);
	}
	return n;
}

export function parseForwardSpec(spec: string): PortMapping {
	if (!spec?.trim()) {
		throw new QuickCHRError(
			"INVALID_FORWARD_SPEC",
			"Empty --forward spec",
		);
	}
	const trimmed = spec.trim();

	// Split off /proto suffix
	let body = trimmed;
	let protoStr: string | undefined;
	const slash = trimmed.lastIndexOf("/");
	if (slash !== -1) {
		body = trimmed.slice(0, slash);
		protoStr = trimmed.slice(slash + 1).toLowerCase();
		if (protoStr !== "tcp" && protoStr !== "udp") {
			fail(spec, `protocol must be "tcp" or "udp", got "${protoStr}"`);
		}
	}

	const parts = body.split(":");
	if (parts.length > 3) {
		fail(spec, `too many ":" segments (expected name[:host[:guest]])`);
	}
	const name = parts[0]?.trim() ?? "";
	if (!name) {
		fail(spec, "name is required");
	}

	const known = lookupGuestPort(name);

	let host = 0;
	if (parts.length >= 2 && parts[1] !== "" && parts[1] !== undefined) {
		host = parsePort(spec, parts[1], "host", true);
	}

	let guest: number;
	if (parts.length >= 3 && parts[2] !== "" && parts[2] !== undefined) {
		guest = parsePort(spec, parts[2], "guest", false);
	} else if (known) {
		guest = known.guest;
	} else {
		fail(spec, `guest port required for unknown service "${name}"`);
	}

	const proto: "tcp" | "udp" = (protoStr as "tcp" | "udp" | undefined) ?? known?.proto ?? "tcp";

	return { name, host, guest, proto };
}
