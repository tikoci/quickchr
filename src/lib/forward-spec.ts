/**
 * Parse a CLI `--forward` spec into one or more `PortMapping`s.
 *
 * Two grammars share this file:
 *
 * **Single port** — `parseForwardSpec`, grammar `name[:host[:guest]][/proto]`:
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
 * **Port range** — `expandForwardSpec`, grammar
 * `name:hostStart-hostEnd[:guestStart-guestEnd][/proto]`. Expands to one
 * `PortMapping` per port (QEMU `hostfwd` has no native range — each port needs
 * its own directive). Useful for L3 peer protocols with dynamic data ports
 * (e.g. RouterOS bandwidth-test allocates UDP ports at runtime). See the rules
 * on `expandForwardSpec` below. `expandForwardSpec` is the range-aware entry
 * point and delegates to `parseForwardSpec` for non-range specs, so callers can
 * always use `expandForwardSpec` (the CLI does).
 *
 * Both throw `QuickCHRError("INVALID_FORWARD_SPEC", ...)` with the original spec
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

/** Max ports a single range `--forward` may span, bounding the generated
 *  `hostfwd` string (one directive per port). */
export const FORWARD_RANGE_MAX = 64;

function parseRange(
	spec: string,
	raw: string,
	label: string,
): { start: number; end: number } {
	const dash = raw.indexOf("-");
	const startRaw = raw.slice(0, dash);
	const endRaw = raw.slice(dash + 1);
	const start = parsePort(spec, startRaw, `${label} range start`, false);
	const end = parsePort(spec, endRaw, `${label} range end`, false);
	if (end < start) {
		fail(spec, `${label} range end ${end} is below start ${start}`);
	}
	return { start, end };
}

/**
 * Range-aware front door for `--forward` specs. Returns a `PortMapping[]`.
 *
 * For a single-port spec (no `-` in the host/guest segment) this returns
 * `[parseForwardSpec(spec)]` unchanged. For a range spec
 * `name:hostStart-hostEnd[:guestStart-guestEnd][/proto]` it expands to one
 * `PortMapping` per port, named `\`${name}-${hostPort}\`` so each is a distinct
 * key in the machine's port map.
 *
 * Range rules:
 * - **Host range is required** — ranges are not auto-allocated. The per-instance
 *   port block (10 ports) can't guarantee a contiguous run, so range host ports
 *   must be explicit. They are then collision-checked like any explicit
 *   `extraPorts` host (`validateExplicitExtraPorts`).
 * - **Guest range is optional** — defaults to the same numbers as the host
 *   range. When given it must be the **same length** as the host range.
 * - **`proto`** defaults from the `WELL_KNOWN_GUEST_PORTS` registry (by `name`),
 *   else `tcp`; an explicit `/proto` suffix wins.
 * - Reversed ranges (end < start) and spans over {@link FORWARD_RANGE_MAX} ports
 *   throw `INVALID_FORWARD_SPEC`.
 *
 * @example
 * expandForwardSpec("btest:9200-9202:2000-2002/udp");
 * // → [{name:"btest-9200",host:9200,guest:2000,proto:"udp"}, … 9201/2001, 9202/2002]
 * @example
 * expandForwardSpec("smb"); // single port → [{name:"smb",host:0,guest:445,proto:"tcp"}]
 */
export function expandForwardSpec(spec: string): PortMapping[] {
	if (!spec?.trim()) {
		throw new QuickCHRError("INVALID_FORWARD_SPEC", "Empty --forward spec");
	}
	const trimmed = spec.trim();

	// Split off /proto suffix (so a range's "-" can't be confused with anything).
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
	const hasRange = Boolean(parts[1]?.includes("-") || parts[2]?.includes("-"));
	if (!hasRange) {
		return [parseForwardSpec(spec)];
	}

	if (parts.length > 3) {
		fail(spec, `too many ":" segments (expected name:hostStart-hostEnd[:guestStart-guestEnd])`);
	}
	const name = parts[0]?.trim() ?? "";
	if (!name) {
		fail(spec, "name is required");
	}

	const hostSegment = parts[1];
	if (!hostSegment?.includes("-")) {
		fail(
			spec,
			"a range --forward requires an explicit host range (e.g. 9200-9210); ranges are not auto-allocated",
		);
	}
	const hostRange = parseRange(spec, hostSegment, "host");

	const guestSegment = parts[2];
	let guestRange: { start: number; end: number };
	if (guestSegment !== undefined && guestSegment !== "") {
		if (!guestSegment.includes("-")) {
			fail(
				spec,
				`guest segment "${guestSegment}" must be a range matching the host range (e.g. 2000-2010), not a single port`,
			);
		}
		guestRange = parseRange(spec, guestSegment, "guest");
	} else {
		// guest range omitted → default to the host range's port numbers
		guestRange = { start: hostRange.start, end: hostRange.end };
	}

	const hostCount = hostRange.end - hostRange.start + 1;
	const guestCount = guestRange.end - guestRange.start + 1;
	if (hostCount !== guestCount) {
		fail(
			spec,
			`host range (${hostCount} ports) and guest range (${guestCount} ports) must be the same length`,
		);
	}
	if (hostCount > FORWARD_RANGE_MAX) {
		fail(spec, `range spans ${hostCount} ports, exceeding the ${FORWARD_RANGE_MAX}-port cap`);
	}

	const known = lookupGuestPort(name);
	const proto: "tcp" | "udp" = (protoStr as "tcp" | "udp" | undefined) ?? known?.proto ?? "tcp";

	const mappings: PortMapping[] = [];
	for (let i = 0; i < hostCount; i++) {
		const host = hostRange.start + i;
		mappings.push({ name: `${name}-${host}`, host, guest: guestRange.start + i, proto });
	}
	return mappings;
}
