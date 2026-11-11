/**
 * quickchr-managed macOS networks (#256).
 *
 * Every vmnet mode needs root. quickchr puts that root in one place, once: a
 * LaunchDaemon per network that runs a pinned upstream socket_vmnet. Machines then
 * attach unprivileged with `-netdev stream` to the daemon's socket (network.ts).
 *
 * This module plans and inspects. It never runs anything as root: the CLI shows the
 * plan, asks, and runs the one privileged script through `sudo`. Status needs no
 * privilege (`launchctl print system/<label>` and a connect to the socket).
 *
 * A network is named by the specifier machines already use: `shared` or
 * `bridged:<iface>`. Its launchd label, socket and log are derived from that name.
 */

import { existsSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { QuickCHRError, type MachineState, type SocketVmnetProbe } from "./types.ts";
import { MANAGED_HELPER_ROOT, managedSocketPath, resolveInterfaceAlias } from "./platform.ts";
import { probeSocketVmnet } from "./network.ts";
import { downloadToFile } from "./download.ts";
import { createLogger } from "./log.ts";

/** The upstream socket_vmnet release quickchr installs: lima-vm/socket_vmnet's own
 *  release tarballs, not Homebrew. Both the tarball and the extracted binary are
 *  pinned, so a matching installed helper is reused without a download, and the root
 *  script can check the bytes it installed. */
export const SOCKET_VMNET_RELEASE = {
	version: "1.2.2",
	assets: {
		x64: {
			file: "socket_vmnet-1.2.2-x86_64.tar.gz",
			sha256: "2968a82c97e692c2d36f87230152e8018e00589c1b598e8257775adfe83800a1",
			binarySha256: "526086c810df74a2465da6fd841a6e7a9a6a74679029dc76eee9dee2291b4929",
		},
		arm64: {
			file: "socket_vmnet-1.2.2-arm64.tar.gz",
			sha256: "c7bf62308fbcfdc29bdfb8373c9b1951f7ac2396446e4390919796a94972e6dc",
			binarySha256: "b8a72a62237312f2f756027dea504a844edeb40014702d4a320292c026d282b0",
		},
	},
} as const;

export type SocketVmnetAsset = (typeof SOCKET_VMNET_RELEASE.assets)[keyof typeof SOCKET_VMNET_RELEASE.assets];

export const MANAGED_LABEL_PREFIX = "dev.tikoci.quickchr.net.";
export const MANAGED_LOG_DIR = "/var/log/quickchr";
export const LAUNCH_DAEMONS_DIR = "/Library/LaunchDaemons";
/** socket_vmnet's own default, and the macOS group every local user is in. */
export const MANAGED_SOCKET_GROUP = "staff";

export type ManagedNetworkSpec = { mode: "shared" } | { mode: "bridged"; iface: string };

export function socketVmnetAsset(arch: string = process.arch): SocketVmnetAsset {
	if (arch === "x64") return SOCKET_VMNET_RELEASE.assets.x64;
	if (arch === "arm64") return SOCKET_VMNET_RELEASE.assets.arm64;
	throw new QuickCHRError("NETWORK_UNAVAILABLE", `socket_vmnet has no release for host arch ${arch}`);
}

export function socketVmnetAssetUrl(asset: SocketVmnetAsset): string {
	return `https://github.com/lima-vm/socket_vmnet/releases/download/v${SOCKET_VMNET_RELEASE.version}/${asset.file}`;
}

export function managedHelperPath(version: string = SOCKET_VMNET_RELEASE.version): string {
	return `${MANAGED_HELPER_ROOT}/${version}/bin/socket_vmnet`;
}

/** Interface names become path segments, a launchd label and a shell word. */
const IFACE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

/** `shared`, `bridged:<iface>` or `bridged:<alias>` (wifi/ethernet/auto). An alias is
 *  resolved now, because the service binds one real interface. */
export function parseManagedNetworkSpec(text: string): ManagedNetworkSpec {
	if (text === "shared") return { mode: "shared" };
	const bridged = text.match(/^bridged:(.+)$/);
	if (bridged?.[1]) {
		const iface = resolveInterfaceAlias(bridged[1]);
		if (!IFACE_RE.test(iface)) {
			throw new QuickCHRError("INVALID_NETWORK", `Not a usable interface name: "${iface}"`);
		}
		return { mode: "bridged", iface };
	}
	throw new QuickCHRError(
		"INVALID_NETWORK",
		`Unknown managed network "${text}" — expected shared or bridged:<iface> (for example bridged:en0)`,
	);
}

export function managedNetworkSlug(spec: ManagedNetworkSpec): string {
	return spec.mode === "shared" ? "shared" : `bridged-${spec.iface}`;
}

export function managedNetworkSpecifier(spec: ManagedNetworkSpec): string {
	return spec.mode === "shared" ? "shared" : `bridged:${spec.iface}`;
}

export function managedNetworkLabel(spec: ManagedNetworkSpec): string {
	return `${MANAGED_LABEL_PREFIX}${managedNetworkSlug(spec)}`;
}

/** A managed network as installed: read back from its plist. */
export interface ManagedNetwork {
	spec: ManagedNetworkSpec;
	label: string;
	plistPath: string;
	programArguments: string[];
	helperPath?: string;
	socketPath?: string;
	interfaceId?: string;
}

function argValue(args: string[], name: string): string | undefined {
	const prefix = `--${name}=`;
	return args.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

/** Interpret one plist (as `plutil -convert json` prints it). Undefined for a plist
 *  that is not a quickchr network service. */
export function parseManagedPlist(plistPath: string, plist: { Label?: unknown; ProgramArguments?: unknown }): ManagedNetwork | undefined {
	const label = typeof plist.Label === "string" ? plist.Label : undefined;
	const args = Array.isArray(plist.ProgramArguments) ? plist.ProgramArguments.filter((a): a is string => typeof a === "string") : [];
	if (!label?.startsWith(MANAGED_LABEL_PREFIX) || args.length === 0) return undefined;
	const mode = argValue(args, "vmnet-mode") ?? "shared";
	const iface = argValue(args, "vmnet-interface");
	let spec: ManagedNetworkSpec;
	if (mode === "shared") spec = { mode: "shared" };
	else if (mode === "bridged" && iface) spec = { mode: "bridged", iface };
	else return undefined;
	const last = args[args.length - 1];
	return {
		spec,
		label,
		plistPath,
		programArguments: args,
		helperPath: args[0],
		socketPath: last && !last.startsWith("-") && last !== args[0] ? last : undefined,
		interfaceId: argValue(args, "vmnet-interface-id"),
	};
}

/** Every quickchr network service installed on this host, including one set up by hand
 *  under a quickchr label before quickchr could do it (Morpheus's bridged-en0). */
export function listManagedNetworks(dir: string = LAUNCH_DAEMONS_DIR): ManagedNetwork[] {
	if (process.platform !== "darwin" || !existsSync(dir)) return [];
	const networks: ManagedNetwork[] = [];
	for (const entry of readdirSync(dir).sort()) {
		if (!entry.startsWith(MANAGED_LABEL_PREFIX) || !entry.endsWith(".plist")) continue;
		const path = join(dir, entry);
		const result = Bun.spawnSync(["plutil", "-convert", "json", "-o", "-", path], { stdout: "pipe", stderr: "pipe" });
		if (result.exitCode !== 0) continue;
		try {
			const net = parseManagedPlist(path, JSON.parse(new TextDecoder().decode(result.stdout)));
			if (net) networks.push(net);
		} catch {
			// not JSON-convertible; not ours to interpret
		}
	}
	return networks;
}

export function findManagedNetwork(spec: ManagedNetworkSpec, dir?: string): ManagedNetwork | undefined {
	const label = managedNetworkLabel(spec);
	return listManagedNetworks(dir).find((n) => n.label === label);
}

const INTERFACE_ALIASES = new Set(["auto", "wifi", "ethernet"]);
const LEGACY_WRAPPER_NETDEV = /-netdev socket,id=[^,\s]+,fd=\d/;

/** Whether a machine uses a managed network, for the `remove` guard and the warnings.
 *
 *  A running machine is judged by what it actually attached to: `liveArgs` is its QEMU
 *  command line, which names the socket; when it is readable, a miss is a "no". The stored specifier is not enough, because
 *  `bridged:auto` re-resolves by link state, so a VM that started on en0 can resolve
 *  elsewhere later. Without `liveArgs` (stopped, or `ps` failed), a running machine with
 *  an alias counts as attached to every bridged network, erring toward requiring
 *  `--force`; otherwise the alias is resolved now. */
export function machineUsesManagedNetwork(
	machine: Pick<MachineState, "networks" | "status">,
	spec: ManagedNetworkSpec,
	opts: { socketPath?: string; liveArgs?: string; resolveAlias?: (alias: string) => string } = {},
): boolean {
	if (opts.liveArgs !== undefined && opts.socketPath) {
		if (opts.liveArgs.includes(opts.socketPath)) return true;
		// The argv names every `-netdev stream` socket, so a miss is a real "not on this
		// network". Except under the pre-0.5.7 `socket_vmnet_client` wrapper: its QEMU got
		// the connection as an fd, and the argv carries no path, so use the stored config.
		if (!LEGACY_WRAPPER_NETDEV.test(opts.liveArgs)) return false;
	}
	const runningBlind = machine.status === "running" && opts.liveArgs === undefined;
	const resolve = opts.resolveAlias ?? resolveInterfaceAlias;
	return (machine.networks ?? []).some((n) => {
		if (spec.mode === "shared") return n.specifier === "shared";
		if (typeof n.specifier !== "object" || n.specifier.type !== "bridged") return false;
		if (!INTERFACE_ALIASES.has(n.specifier.iface)) return n.specifier.iface === spec.iface;
		if (runningBlind) return true;
		try {
			return resolve(n.specifier.iface) === spec.iface;
		} catch {
			return false;
		}
	});
}

/** What `create` will install. Everything here is disclosed before the sudo prompt. */
export interface ManagedNetworkPlan {
	spec: ManagedNetworkSpec;
	specifier: string;
	label: string;
	plistPath: string;
	socketPath: string;
	logPath: string;
	helperPath: string;
	helperVersion: string;
	asset: SocketVmnetAsset;
	assetUrl: string;
	interfaceId: string;
	programArguments: string[];
	/** The service this replaces, when one with the same label exists. */
	replaces?: ManagedNetwork;
}

export function planManagedNetwork(spec: ManagedNetworkSpec, existing?: ManagedNetwork, arch?: string): ManagedNetworkPlan {
	const slug = managedNetworkSlug(spec);
	const label = managedNetworkLabel(spec);
	const socketPath = managedSocketPath(slug);
	const logPath = `${MANAGED_LOG_DIR}/net-${slug}.log`;
	const helperPath = managedHelperPath();
	const asset = socketVmnetAsset(arch);
	// Kept across re-creates: vmnet derives the host-side interface MAC from it, and a
	// new one per restart would change it every time (research doc, bridged en0 lab).
	const interfaceId = existing?.interfaceId ?? randomUUID().toUpperCase();
	const programArguments = [
		helperPath,
		`--vmnet-mode=${spec.mode}`,
		...(spec.mode === "bridged" ? [`--vmnet-interface=${spec.iface}`] : []),
		`--vmnet-interface-id=${interfaceId}`,
		`--socket-group=${MANAGED_SOCKET_GROUP}`,
		socketPath,
	];
	return {
		spec,
		specifier: managedNetworkSpecifier(spec),
		label,
		plistPath: `${LAUNCH_DAEMONS_DIR}/${label}.plist`,
		socketPath,
		logPath,
		helperPath,
		helperVersion: SOCKET_VMNET_RELEASE.version,
		asset,
		assetUrl: socketVmnetAssetUrl(asset),
		interfaceId,
		programArguments,
		replaces: existing,
	};
}

function xmlEscape(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildLaunchdPlist(plan: Pick<ManagedNetworkPlan, "label" | "programArguments" | "logPath">): string {
	const args = plan.programArguments.map((a) => `\t\t<string>${xmlEscape(a)}</string>`).join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${xmlEscape(plan.label)}</string>
	<key>ProgramArguments</key>
	<array>
${args}
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>${xmlEscape(plan.logPath)}</string>
	<key>StandardErrorPath</key>
	<string>${xmlEscape(plan.logPath)}</string>
</dict>
</plist>
`;
}

export function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Unload a label and wait until launchd no longer has it. An immediate bootstrap after
 *  bootout can fail with an I/O error, and an unload that never finishes must stop the
 *  script before it deletes or replaces anything: otherwise `remove` reports success
 *  with the root service still running (Codex review of #264). `bootout`'s own exit
 *  status is not used: it also fails for a label that is already unloaded, so the
 *  `launchctl print` afterwards is what decides. */
function unloadLabel(label: string): string[] {
	const target = shellQuote(`system/${label}`);
	return [
		`launchctl bootout ${target} 2>/dev/null || true`,
		`i=0; while launchctl print ${target} >/dev/null 2>&1 && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done`,
		`if launchctl print ${target} >/dev/null 2>&1; then echo ${shellQuote(`quickchr: ${label} is still loaded after bootout; its plist and socket were left in place`)} >&2; exit 1; fi`,
	];
}

/** Shell lines that stop the root script unless every path is a real (not symlinked),
 *  root-owned, not group- or world-writable file or directory. The helper and its
 *  directories are what a root LaunchDaemon executes, so a user-writable link anywhere
 *  on the way would let the user swap the binary after its hash check (DESIGN.md:
 *  "a plist always names a root-owned real path"). Missing paths are skipped. */
export function rootOwnedChecks(paths: string[]): string[] {
	const q = shellQuote;
	return [
		`for p in ${paths.map(q).join(" ")}; do`,
		`	if [ -L "$p" ]; then echo "quickchr: $p is a symlink; refusing to use it as root" >&2; exit 1; fi`,
		`	[ -e "$p" ] || continue`,
		`	[ "$(stat -f %u "$p")" = 0 ] || { echo "quickchr: $p is not owned by root" >&2; exit 1; }`,
		`	case "$(stat -f %Sp "$p")" in ?????w????|????????w?) echo "quickchr: $p is group- or world-writable" >&2; exit 1;; esac`,
		"done",
	];
}

/** Every path from `/opt` down to the helper, which the service will execute. */
function helperPathChain(helperPath: string): string[] {
	const parts = helperPath.split("/").filter(Boolean);
	return parts.map((_, i) => `/${parts.slice(0, i + 1).join("/")}`);
}

/** The one privileged step of `create`. `stagedHelper` is undefined when the pinned
 *  helper is already installed with the pinned hash.
 *
 *  Nothing root acts on is taken from a user-writable file without a check: the helper
 *  is copied and then hash-checked in its root-owned place, and the plist is written by
 *  the script itself from content embedded in it. A staged plist file could be swapped
 *  by any process running as the user while sudo waits for the password. */
export function buildCreateScript(plan: ManagedNetworkPlan, stagedHelper?: string): string {
	const q = shellQuote;
	const helperDir = plan.helperPath.slice(0, plan.helperPath.lastIndexOf("/"));
	const staleSockets = [plan.socketPath, ...(plan.replaces?.socketPath && plan.replaces.socketPath !== plan.socketPath ? [plan.replaces.socketPath] : [])];
	const dirs = [...helperPathChain(helperDir), MANAGED_LOG_DIR];
	const hashCheck = (path: string, shown: string) =>
		`test "$(shasum -a 256 ${path} | cut -d ' ' -f 1)" = ${q(plan.asset.binarySha256)} || { echo ${q(`quickchr: ${shown} does not match the pinned sha256`)} >&2; exit 1; }`;
	return [
		"set -eu",
		"umask 022",
		// Temp files root creates: removed on any exit before they are moved into place,
		// so a failure leaves neither unverified bytes nor a stray plist behind.
		`new=""; tmp=""`,
		`trap '[ -z "$new" ] || rm -f "$new"; [ -z "$tmp" ] || rm -f "$tmp"' EXIT`,
		// Checked before `install -d` too: it follows a symlinked directory and would
		// chown/chmod the link's target before the check after it could refuse.
		...rootOwnedChecks(dirs),
		`install -d -o root -g wheel -m 755 ${q(helperDir)} ${q(MANAGED_LOG_DIR)}`,
		...rootOwnedChecks(dirs),
		// The staged copy is user-owned and could change while sudo waits: copy it into the
		// root-owned directory, verify that copy, and only then rename it over the live
		// helper (atomic in one directory). A mismatch leaves the old helper untouched.
		...(stagedHelper
			? [
				`new=$(mktemp ${q(`${helperDir}/.socket_vmnet.XXXXXX`)})`,
				`install -o root -g wheel -m 755 ${q(stagedHelper)} "$new"`,
				hashCheck(`"$new"`, `the staged ${stagedHelper}`),
				`mv -f "$new" ${q(plan.helperPath)}`,
				`new=""`,
			]
			: []),
		// launchd opens the log as root for StandardOutPath/StandardErrorPath, so an
		// existing log file gets the same check as the helper.
		...rootOwnedChecks([plan.helperPath, plan.logPath]),
		hashCheck(q(plan.helperPath), plan.helperPath),
		...unloadLabel(plan.label),
		`rm -f ${staleSockets.map(q).join(" ")}`,
		`tmp=$(mktemp ${q(`${LAUNCH_DAEMONS_DIR}/.quickchr.XXXXXX`)})`,
		`printf '%s' ${q(buildLaunchdPlist(plan))} > "$tmp"`,
		`chown root:wheel "$tmp"`,
		`chmod 644 "$tmp"`,
		`mv -f "$tmp" ${q(plan.plistPath)}`,
		`launchctl bootstrap system ${q(plan.plistPath)}`,
	].join("\n");
}

export function buildRemoveScript(net: ManagedNetwork): string {
	const q = shellQuote;
	return [
		"set -eu",
		...unloadLabel(net.label),
		`rm -f ${[net.plistPath, ...(net.socketPath ? [net.socketPath] : [])].map(q).join(" ")}`,
	].join("\n");
}

/** Restart, and load the job first when launchd does not have it (a failed bootstrap,
 *  or an admin's `bootout`): `kickstart` alone cannot start an unloaded job. */
export function buildRestartScript(net: ManagedNetwork): string {
	const q = shellQuote;
	const target = q(`system/${net.label}`);
	return [
		"set -eu",
		`launchctl print ${target} >/dev/null 2>&1 || launchctl bootstrap system ${q(net.plistPath)}`,
		`launchctl kickstart -k ${target}`,
	].join("\n");
}

/** sha256 of a file, hex. */
export async function sha256File(path: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(await Bun.file(path).arrayBuffer());
	return hasher.digest("hex");
}

/** True when the pinned helper is already installed with the pinned bytes. */
export async function helperInstalled(plan: ManagedNetworkPlan): Promise<boolean> {
	return existsSync(plan.helperPath) && (await sha256File(plan.helperPath)) === plan.asset.binarySha256;
}

/** Download the pinned release into `stageDir` (owned by the user), check both pinned
 *  hashes, and return the extracted helper's path. Nothing here needs root. */
export async function stageSocketVmnetHelper(plan: ManagedNetworkPlan, stageDir: string): Promise<string> {
	const tarball = join(stageDir, plan.asset.file);
	// Quiet: a 20 KB transfer needs no progress lines; failures still throw.
	await downloadToFile(plan.assetUrl, tarball, { logger: createLogger(() => {}) });
	const tarSha = await sha256File(tarball);
	if (tarSha !== plan.asset.sha256) {
		throw new QuickCHRError(
			"DOWNLOAD_FAILED",
			`${plan.asset.file} sha256 ${tarSha} does not match the pinned ${plan.asset.sha256}`,
		);
	}
	const member = "opt/socket_vmnet/bin/socket_vmnet";
	const tar = Bun.spawnSync(["tar", "-xzf", tarball, "-C", stageDir, member], { stdout: "pipe", stderr: "pipe" });
	if (tar.exitCode !== 0) {
		throw new QuickCHRError("DOWNLOAD_FAILED", `Could not extract ${member} from ${plan.asset.file}: ${new TextDecoder().decode(tar.stderr).trim()}`);
	}
	const helper = join(stageDir, member);
	const binSha = await sha256File(helper);
	if (binSha !== plan.asset.binarySha256) {
		throw new QuickCHRError(
			"DOWNLOAD_FAILED",
			`Extracted socket_vmnet sha256 ${binSha} does not match the pinned ${plan.asset.binarySha256}`,
		);
	}
	return helper;
}

/** Service plus socket. The three failure states #256 asks status to tell apart are
 *  "no service" (no plist: absent from `listManagedNetworks`), "service down" (not
 *  loaded or not running) and "socket dead" (running, socket not accepting). */
export interface ManagedNetworkStatus {
	loaded: boolean;
	running: boolean;
	pid?: number;
	lastExit?: string;
	socket?: SocketVmnetProbe;
}

/** Read `launchctl print` output. Only top-level (one-tab) keys: nested blocks repeat
 *  `state =` for endpoints. */
export function parseLaunchctlPrint(output: string): Pick<ManagedNetworkStatus, "running" | "pid" | "lastExit"> {
	const state = output.match(/^\tstate = (\S+)/m)?.[1];
	const pid = output.match(/^\tpid = (\d+)/m)?.[1];
	const lastExit = output.match(/^\tlast exit code = (.+)$/m)?.[1]?.trim();
	return { running: state === "running", pid: pid ? Number(pid) : undefined, lastExit };
}

export async function managedNetworkStatus(net: ManagedNetwork): Promise<ManagedNetworkStatus> {
	const print = Bun.spawnSync(["launchctl", "print", `system/${net.label}`], { stdout: "pipe", stderr: "pipe" });
	const socket = net.socketPath ? await probeSocketVmnet(net.socketPath) : undefined;
	if (print.exitCode !== 0) return { loaded: false, running: false, socket };
	return { loaded: true, ...parseLaunchctlPrint(new TextDecoder().decode(print.stdout)), socket };
}

/** One line for `networks status`. */
export function describeManagedNetworkStatus(status: ManagedNetworkStatus): { ok: boolean; text: string } {
	if (!status.loaded) return { ok: false, text: "service not loaded (plist present; launchd has not started it)" };
	if (!status.running) return { ok: false, text: `service not running${status.lastExit ? ` (last exit ${status.lastExit})` : ""}` };
	if (!status.socket) return { ok: false, text: `running (pid ${status.pid}), no socket in its arguments` };
	if (status.socket.state !== "accepting") return { ok: false, text: `running (pid ${status.pid}), but its socket is ${status.socket.state}` };
	return { ok: true, text: `running (pid ${status.pid}), socket accepting` };
}
