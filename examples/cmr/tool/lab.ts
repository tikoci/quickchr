import { join } from "node:path";
import { QuickCHR, type ChrInstance, type NetworkSpecifier } from "../../../src/index.ts";
import { check, exampleMachineName } from "../../lib.ts";

/**
 * The RouterOS build the lab boots. CMR exists only in 7.26 development builds and changes
 * between betas, so the lab pins one. `--version <v>` or `QUICKCHR_CMR_VERSION` reruns an
 * older or newer build; FINDINGS.md records which build each claim was measured on.
 */
export const DEFAULT_VERSION = "7.26beta5";
export function labVersion(argv = process.argv): string {
	return operand(argv, "version") ?? (process.env.QUICKCHR_CMR_VERSION?.trim() || DEFAULT_VERSION);
}

/** The runner's flags. An operand may not be one of them: `--report --probe` is a missing path. */
export const FLAGS = new Set(["--cli", "--hold", "--probe", "--first-bridge", "--version", "--report", "--study", "--boots", "--trials", "--strategies"]);

/**
 * The value after `--<name>`: undefined when the flag is absent, an error when it is present
 * without a value. Any other value is accepted, including a path that starts with `-`.
 */
export function operand(argv: string[], name: string): string | undefined {
	const index = argv.indexOf(`--${name}`);
	if (index < 0) return undefined;
	const value = argv[index + 1];
	check(value !== undefined && value !== "" && !FLAGS.has(value), `--${name} needs a value`);
	return value;
}

const cliMode = process.argv.includes("--cli");
async function cli(args: string[], inherit = false): Promise<string> {
	const invocation = process.env.QUICKCHR?.trim().split(/\s+/) ?? ["bun", "run", join(import.meta.dir, "../../../src/cli/index.ts")];
	const child = Bun.spawn([...invocation, ...args], { stdout: inherit ? "inherit" : "pipe", stderr: "inherit" });
	const output = inherit ? "" : await new Response(child.stdout).text();
	check(await child.exited === 0, `quickchr ${args[0]} failed`);
	return output;
}

/** Set on Ctrl-C: the next lab step throws, so the runner can tear down after any in-flight start. */
export const cancellation = { requested: false };
function checkCancelled(): void {
	if (cancellation.requested) throw new Error("Cancelled");
}

export type Row = Record<string, string>;
export function rows(value: unknown): Row[] {
	if (Array.isArray(value)) return value as Row[];
	return value && typeof value === "object" && Object.keys(value).length ? [value as Row] : [];
}

export async function read(chr: ChrInstance, path: string): Promise<Row[]> {
	checkCancelled();
	return rows(await chr.rest(path));
}

/**
 * RouterOS rejection text that `/rest/execute` returns with HTTP 200 (quickchr #142). The last
 * alternative is a `/cmr/device/run-script` row whose STATUS is `failed`
 * (`cmr-client@192.0.2.2  failed  not enough permissions (9) …`).
 */
export const REJECTED = /^(failure:|syntax error|bad command name|expected |input does not match|no such item|not enough permissions|\S+\s+failed\s)/m;

/** Run one console line; throw if RouterOS rejected it. */
export async function command(chr: ChrInstance, script: string): Promise<string> {
	checkCancelled();
	const output = cliMode ? await cli(["exec", chr.name, script]) : (await chr.exec(script)).output;
	check(!REJECTED.test(output), output);
	return output;
}

/** Run one console line and return whatever RouterOS printed, rejections included. */
export async function attempt(chr: ChrInstance, script: string, login?: { user: string; password: string }): Promise<string> {
	checkCancelled();
	return (await chr.exec(script, login ? { via: "rest", ...login } : undefined)).output;
}

export function quote(s: string): string {
	return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$")}"`;
}

export async function until(description: string, predicate: () => Promise<boolean>, timeout = 90_000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		checkCancelled();
		if (await predicate()) return;
		await Bun.sleep(1000);
	}
	throw new Error(`Timed out: ${description}`);
}

export async function identityOf(chr: ChrInstance): Promise<string> {
	const identity = (await read(chr, "/system/identity"))[0]?.name;
	check(identity, `${chr.name}: identity missing`);
	return identity;
}

/** The login quickchr generated for a machine (`--secure-login`). */
export async function loginOf(chr: ChrInstance): Promise<{ user: string; password: string }> {
	const endpoint = (await chr.descriptor()).services["rest-api"];
	check(endpoint.available && endpoint.auth && typeof endpoint.auth.password === "string", `${chr.name}: managed credentials missing`);
	return { user: endpoint.auth.username, password: endpoint.auth.password };
}

interface BootOptions {
	prefix: string;
	version: string;
	track: <T extends ChrInstance>(instance: T) => T;
	initialBridge: boolean;
}

/**
 * Boot one lab router: a user-mode `ether1` for host management plus named socket links.
 * tcp/54321 is dropped inbound and reset outbound on `ether1`, so CMR only uses the topology.
 */
async function bootRouter(options: BootOptions, role: string, networks: NetworkSpecifier[], packages: string[] = []): Promise<ChrInstance> {
	const { prefix, version, track } = options;
	checkCancelled();
	console.log(`Booting ${role} on ${version}`);
	const name = `${prefix}-${role}`;
	let chr: ChrInstance;
	if (cliMode) {
		const args = ["start", name, "--version", version, "--arch", "x86", "--secure-login", "--mem", "512", "--add-network", "user"];
		for (const network of networks) {
			check(typeof network === "object" && network.type === "socket", "Expected named socket");
			args.push("--add-network", `socket::${network.name}`);
		}
		for (const pkg of packages) args.push("--add-package", pkg);
		try {
			await cli(args, true);
		} catch (error) {
			await QuickCHR.get(name)?.remove();
			throw error;
		}
		const instance = QuickCHR.get(name);
		check(instance, "CLI machine missing");
		chr = track(instance);
	} else {
		try {
			chr = track(await QuickCHR.start({ name, version, arch: "x86", mem: 512, secureLogin: true,
				networks: ["user", ...networks], packages }));
		} catch (error) {
			// Provisioning (e.g. the cmr package upload) can fail after QEMU is already running.
			await QuickCHR.get(name)?.remove();
			throw error;
		}
	}
	const running = (await read(chr, "/system/resource"))[0]?.version?.split(" ")[0];
	check(running === version, `${name}: expected RouterOS ${version}, got ${running}`);
	await command(chr, `/system/identity/set name=cmr-${role}`);
	await command(chr, '/system/note/set note="Disposable quickchr CMR lab"');
	if (options.initialBridge) await command(chr, "/interface/bridge/add name=cmr-lab-loopback");
	await command(chr, "/ip/firewall/filter/add chain=input in-interface=ether1 protocol=tcp dst-port=54321 action=drop comment=cmr-lab-isolation");
	// While OSPF has no route to the controller, a CMR connect follows the DHCP default route out
	// ether1. Its SYN keeps the 10.0.2.15 source after OSPF recovers, and every user-mode NIC is
	// 10.0.2.15, so it can never complete. Reset it at once so the client retries over the topology.
	await command(chr, "/ip/firewall/filter/add chain=output out-interface=ether1 protocol=tcp dst-port=54321 action=reject reject-with=tcp-reset comment=cmr-lab-isolation");
	return chr;
}

export interface LabOptions {
	version?: string;
	/** Put each loopback on a bridge created before CMR starts (FINDINGS.md: first-interface alert). */
	initialBridge?: boolean;
	prefix?: string;
}

/**
 * The fleet lab: controller—transit—remote plus controller—local, four CHRs.
 * OSPF carries the controller loopback to the remote; the local client finds the controller
 * without an address. Clients are enabled but not paired; see configureClients().
 */
export async function createLab(track: BootOptions["track"], options: LabOptions = {}) {
	const prefix = options.prefix ?? exampleMachineName("cmr");
	const version = options.version ?? labVersion();
	const initialBridge = options.initialBridge ?? true;
	const boot = { prefix, version, track, initialBridge };
	const link = (suffix: string): NetworkSpecifier => ({ type: "socket", name: `${prefix}-${suffix}` });
	const controller = await bootRouter(boot, "controller", [link("core"), link("local")], ["cmr"]);
	const transit = await bootRouter(boot, "transit", [link("core"), link("remote")]);
	const remote = await bootRouter(boot, "remote", [link("remote")]);
	const local = await bootRouter(boot, "local", [link("local")]);
	const all = [controller, transit, remote, local];
	const addresses = [
		["192.0.2.1/30 ether2", "203.0.113.1/30 ether3"],
		["192.0.2.2/30 ether2", "198.51.100.1/30 ether3"],
		["198.51.100.2/30 ether2"],
		["203.0.113.2/30 ether2"],
	];
	for (const [index, chr] of all.entries()) {
		const loopback = initialBridge ? "cmr-lab-loopback" : "lo";
		await command(chr, `/ip/address/add address=10.255.0.${index + 1}/32 interface=${loopback}`);
		for (const item of addresses[index] ?? []) {
			const [address, iface] = item.split(" ");
			await command(chr, `/ip/address/add address=${address} interface=${iface}`);
		}
		await command(chr, `/routing/ospf/instance/add name=lab router-id=10.255.0.${index + 1}`);
		await command(chr, "/routing/ospf/area/add name=backbone instance=lab area-id=0.0.0.0");
		await command(chr, "/routing/ospf/interface-template/add area=backbone interfaces=ether2 type=ptp");
		if (index < 2) await command(chr, "/routing/ospf/interface-template/add area=backbone interfaces=ether3 type=ptp");
		await command(chr, `/routing/ospf/interface-template/add area=backbone interfaces=${loopback} passive`);
	}
	await until("OSPF remote route to controller", async () => (await read(remote, "/routing/route")).some(
		r => r["dst-address"] === "10.255.0.1/32" && r.ospf === "true" && r.active === "true"));
	await command(controller, "/cmr/set enabled=yes track-topology=yes fetch-comments=yes auto-labels=all");
	return { controller, transit, remote, local, all, version, prefix };
}

export type Lab = Awaited<ReturnType<typeof createLab>>;

/**
 * The pair lab: a controller and one client on a single socket link (192.0.2.0/30), the
 * smallest topology that grounds pairing and run-script. Studies boot it repeatedly because
 * some CMR behaviour varies by boot. The client is enabled with `controller-addresses` and
 * left unpaired.
 */
export async function createPairLab(track: BootOptions["track"], options: LabOptions = {}) {
	const prefix = options.prefix ?? exampleMachineName("cmr");
	const version = options.version ?? labVersion();
	const boot = { prefix, version, track, initialBridge: options.initialBridge ?? false };
	const link: NetworkSpecifier = { type: "socket", name: `${prefix}-link` };
	const controller = await bootRouter(boot, "controller", [link], ["cmr"]);
	const client = await bootRouter(boot, "client", [link]);
	await command(controller, "/ip/address/add address=192.0.2.1/30 interface=ether2");
	await command(client, "/ip/address/add address=192.0.2.2/30 interface=ether2");
	await command(controller, "/cmr/set enabled=yes");
	await command(client, "/cmr/client/set enabled=yes controller-addresses=192.0.2.1");
	return { controller, client, all: [controller, client], version, prefix };
}

export type PairLab = Awaited<ReturnType<typeof createPairLab>>;

/**
 * Remove every machine whose name starts with `<prefix>-`, by name: a VM restarted by a probe
 * has a new PID that the original handle does not know. A failed removal is printed and fails
 * the run (#145), but the remaining machines are still removed.
 */
export async function removeByPrefix(prefix: string): Promise<void> {
	for (const machine of QuickCHR.list().filter(m => m.name.startsWith(`${prefix}-`))) {
		try {
			await QuickCHR.get(machine.name)?.remove();
		} catch (error) {
			console.error(`✗ teardown failed for ${machine.name}: ${error instanceof Error ? error.message : String(error)} — clear it with: quickchr remove ${machine.name}`);
			process.exitCode = 1;
		}
	}
}

/**
 * The lab removes its machines by prefix, so runExample() must not also remove them by handle.
 * Pass this as `track` to boot functions.
 */
export const untracked = <T extends ChrInstance>(instance: T): T => instance;
