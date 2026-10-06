import { QuickCHR, type ChrInstance, type NetworkSpecifier } from "../../../src/index.ts";
import { check, exampleMachineName } from "../../lib.ts";

const cliMode = process.argv.includes("--cli");
async function cli(args: string[], inherit = false): Promise<string> {
	const invocation = process.env.QUICKCHR?.trim().split(/\s+/) ?? ["bun", "run", new URL("../../../src/cli/index.ts", import.meta.url).pathname];
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

export async function command(chr: ChrInstance, script: string): Promise<string> {
	checkCancelled();
	const output = cliMode ? await cli(["exec", chr.name, script]) : (await chr.exec(script)).output;
	check(!/^(failure:|syntax error|bad command name|expected |input does not match|no such item)/m.test(output), output);
	return output;
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

export async function createLab(track: <T extends ChrInstance>(instance: T) => T, version = "7.26beta1", initialBridge = true, prefix = exampleMachineName("cmr")) {
	const link = (suffix: string): NetworkSpecifier => ({ type: "socket", name: `${prefix}-${suffix}` });
	const boot = async (role: string, networks: NetworkSpecifier[], packages: string[] = []) => {
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
		await command(chr, `/system/identity/set name=cmr-${role}`);
		await command(chr, '/system/note/set note="Disposable quickchr CMR lab"');
		if (initialBridge) await command(chr, "/interface/bridge/add name=cmr-lab-loopback");
		await command(chr, "/ip/firewall/filter/add chain=input in-interface=ether1 protocol=tcp dst-port=54321 action=drop comment=cmr-lab-isolation");
		// While OSPF has no route to the controller, a CMR connect follows the DHCP default route out
		// ether1. Its SYN keeps the 10.0.2.15 source after OSPF recovers, and every user-mode NIC is
		// 10.0.2.15, so it can never complete. Reset it at once so the client retries over the topology.
		await command(chr, "/ip/firewall/filter/add chain=output out-interface=ether1 protocol=tcp dst-port=54321 action=reject reject-with=tcp-reset comment=cmr-lab-isolation");
		return chr;
	};
	const controller = await boot("controller", [link("core"), link("local")], ["cmr"]);
	const transit = await boot("transit", [link("core"), link("remote")]);
	const remote = await boot("remote", [link("remote")]);
	const local = await boot("local", [link("local")]);
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
	return { controller, transit, remote, local, all, version };
}

export type Lab = Awaited<ReturnType<typeof createLab>>;

export async function pair(controller: ChrInstance, client: ChrInstance): Promise<void> {
	const identity = (await read(client, "/system/identity"))[0]?.name;
	check(identity, "Client identity missing");
	await until(`controller sees ${identity}`, async () => (await read(controller, "/cmr/device")).some(r => r.identity === identity));
	const endpoint = (await client.descriptor()).services["rest-api"];
	check(endpoint.available && typeof endpoint.auth?.password === "string", "Managed client credentials missing");
	const quote = (s: string) => `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$")}"`;
	await command(controller, `/cmr/device/pair [find identity=${quote(identity)}] username=${quote(endpoint.auth.username)} password=${quote(endpoint.auth.password)}`);
	await until(`${identity} paired`, async () => (await read(client, "/cmr/client"))[0]?.status === "paired,connected");
}

export async function configureClients(lab: Lab): Promise<void> {
	const { controller, transit, remote, local } = lab;
	await command(transit, "/cmr/client/set enabled=yes controller-addresses=192.0.2.1");
	await command(remote, "/cmr/client/set enabled=yes controller-addresses=10.255.0.1");
	// No CMR address or DHCP CMR option: this client must discover its L2 neighbor.
	await command(local, "/cmr/client/set enabled=yes");
	for (const client of [transit, remote, local]) await pair(controller, client);
	for (const role of ["controller", "transit", "remote", "local"]) {
		await command(controller, `/cmr/device/set [find identity=cmr-${role}] labels=lab,${role}`);
	}
	await until("four managed devices", async () => (await read(controller, "/cmr/device")).filter(r => r.identity?.startsWith("cmr-")).length === 4);
}
