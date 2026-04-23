/**
 * Well-known guest port registry.
 *
 * Maps a canonical service name (e.g. "smb", "winbox") to its guest-side port
 * and protocol. Used to power short-form `--forward <name>` CLI flags so users
 * don't have to remember exact port numbers.
 *
 * Pure data + lookup. No side effects, no imports from the rest of the codebase.
 */

export interface GuestPortDef {
	/** Canonical lowercase name, e.g. "smb". */
	name: string;
	/** Guest-side port number (1..65535). */
	guest: number;
	/** Transport protocol. */
	proto: "tcp" | "udp";
	/** Optional alternate names that resolve to this entry, e.g. ["cifs"] for "smb". */
	aliases?: string[];
	/** Brief, factual notes. May reference RouterOS package or subsystem. */
	notes?: string;
}

export const WELL_KNOWN_GUEST_PORTS: readonly GuestPortDef[] = [
	// --- RouterOS services (defaults from /ip/service) ---
	{ name: "ftp", guest: 21, proto: "tcp", notes: "RouterOS /ip/service ftp" },
	{ name: "ssh", guest: 22, proto: "tcp", notes: "RouterOS /ip/service ssh" },
	{ name: "telnet", guest: 23, proto: "tcp", notes: "RouterOS /ip/service telnet" },
	{ name: "http", guest: 80, proto: "tcp", aliases: ["www", "webfig"], notes: "RouterOS /ip/service www (WebFig + REST)" },
	{ name: "https", guest: 443, proto: "tcp", aliases: ["www-ssl", "webfig-ssl"], notes: "RouterOS /ip/service www-ssl (WebFig + REST over TLS)" },
	{ name: "snmp", guest: 161, proto: "udp", notes: "RouterOS /snmp" },
	{ name: "bandwidth-test", guest: 2000, proto: "tcp", aliases: ["btest"], notes: "RouterOS /tool/bandwidth-server" },
	{ name: "dude", guest: 2210, proto: "tcp", notes: "RouterOS dude package server (legacy)" },
	{ name: "dude-secure", guest: 2211, proto: "tcp", notes: "RouterOS dude package server (TLS)" },
	{ name: "upnp", guest: 2828, proto: "tcp", notes: "RouterOS /ip/upnp" },
	{ name: "winbox", guest: 8291, proto: "tcp", notes: "RouterOS /ip/service winbox (also used by Dude client and MikroTik mobile app)" },
	{ name: "api", guest: 8728, proto: "tcp", notes: "RouterOS /ip/service api (native API)" },
	{ name: "api-ssl", guest: 8729, proto: "tcp", notes: "RouterOS /ip/service api-ssl" },
	{ name: "socks", guest: 1080, proto: "tcp", notes: "RouterOS /ip/socks" },

	// --- Common services often forwarded for container / userspace use ---
	{ name: "dns", guest: 53, proto: "udp", notes: "DNS resolver (UDP)" },
	{ name: "dns-tcp", guest: 53, proto: "tcp", notes: "DNS resolver (TCP, used for large responses and zone transfers)" },
	{ name: "ntp", guest: 123, proto: "udp", notes: "Network Time Protocol" },
	{ name: "smb", guest: 445, proto: "tcp", aliases: ["cifs"], notes: "SMB/CIFS file sharing" },
	{ name: "syslog", guest: 514, proto: "udp", notes: "Syslog (UDP)" },
	{ name: "mqtt", guest: 1883, proto: "tcp", notes: "MQTT broker (plaintext)" },
	{ name: "winrm", guest: 5985, proto: "tcp", notes: "Windows Remote Management (HTTP)" },
	{ name: "winrm-https", guest: 5986, proto: "tcp", notes: "Windows Remote Management (HTTPS)" },
	{ name: "http-alt", guest: 8080, proto: "tcp", notes: "Alternate HTTP, common for containerized web apps" },
	{ name: "https-alt", guest: 8443, proto: "tcp", notes: "Alternate HTTPS, common for containerized web apps" },
	{ name: "mqtts", guest: 8883, proto: "tcp", notes: "MQTT broker (TLS)" },
];

/**
 * Look up a guest port definition by canonical name or alias.
 * Case-insensitive. Returns `undefined` if not found.
 */
export function lookupGuestPort(nameOrAlias: string): GuestPortDef | undefined {
	if (!nameOrAlias) return undefined;
	const key = nameOrAlias.toLowerCase();
	for (const entry of WELL_KNOWN_GUEST_PORTS) {
		if (entry.name === key) return entry;
		if (entry.aliases?.some((a) => a.toLowerCase() === key)) return entry;
	}
	return undefined;
}
