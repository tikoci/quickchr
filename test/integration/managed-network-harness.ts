/**
 * Shared harness for the managed-network integration tests (#270): the CLI as a user
 * runs it, launchd and socket inspection, guest traffic checks, failure evidence, and
 * a cleanup that only removes what a test created. Not a test file itself (no
 * `.test.ts`), so the suite never runs it on its own.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { getDataDir } from "../../src/lib/state.ts";
import { MANAGED_HELPER_ROOT } from "../../src/lib/platform.ts";
import {
	MANAGED_LOG_DIR,
	findManagedNetwork,
	listManagedNetworks,
	managedNetworkLabel,
	planManagedNetwork,
	type ManagedNetworkSpec,
} from "../../src/lib/vmnet-service.ts";
import type { ChrInstance } from "../../src/lib/types.ts";

export const INTEGRATION = Boolean(process.env.QUICKCHR_INTEGRATION);
/** The hosts with a managed-network implementation. Linux/Windows: #263. */
export const MANAGED_HOST = process.platform === "darwin";
export const LIFECYCLE_OPTED_IN = process.env.GITHUB_ACTIONS === "true" || process.env.QUICKCHR_TEST_MANAGED_NETWORK === "1";

export const SHARED_MACHINE = "integration-managed-shared";
export const BRIDGED_MACHINE = "integration-managed-bridged";
export const UNAVAILABLE_MACHINE = "integration-managed-unavailable";
/** A DHCP lease and a gateway echo, from a guest whose NIC just came up. */
export const GUEST_NET_DEADLINE_MS = 90_000;
export const EVIDENCE_DIR = process.env.QUICKCHR_TEST_EVIDENCE_DIR || join(getDataDir(), "test-evidence");

// ── CLI and shell ──────────────────────────────────────────────────────────────

export interface CliResult {
	argv: string[];
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** Every CLI and shell call this file made, in order: the core of the failure evidence. */
export const transcript: CliResult[] = [];

export async function sh(argv: string[], env: Record<string, string> = {}): Promise<CliResult> {
	const proc = Bun.spawn(argv, {
		cwd: process.cwd(),
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
		env: { ...process.env, ...env },
	});
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const result = { argv, exitCode: await proc.exited, stdout, stderr };
	transcript.push(result);
	return result;
}

/** The real CLI, as a user runs it without a terminal: no prompts, no tips. */
export function quickchr(...args: string[]): Promise<CliResult> {
	return sh(["bun", "run", "src/cli/index.ts", ...args], { QUICKCHR_NO_PROMPT: "1", QUICKCHR_NO_TIPS: "1" });
}

export function show(r: CliResult): string {
	return `$ ${r.argv.join(" ")}\nexit ${r.exitCode}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`;
}

export function expectExit(r: CliResult, code: number): void {
	if (r.exitCode !== code) throw new Error(`expected exit ${code}\n${show(r)}`);
}

export interface StatusRow {
	specifier: string;
	label: string;
	plistPath: string;
	socketPath: string | null;
	logPath: string | null;
	loaded: boolean;
	running: boolean;
	pid: number | null;
	socket: { state: string } | null;
	ok: boolean;
	text: string;
}

export async function status(specifier: string): Promise<{ result: CliResult; row?: StatusRow }> {
	const result = await quickchr("networks", "status", specifier, "--json");
	const rows = JSON.parse(result.stdout) as StatusRow[];
	return { result, row: rows[0] };
}

/** `stat -f` as the shell prints it: "<owner> <group> <mode string>". */
export function ownership(path: string): string {
	const r = Bun.spawnSync(["stat", "-f", "%Su %Sg %Sp", path], { stdout: "pipe", stderr: "pipe" });
	return r.exitCode === 0 ? r.stdout.toString().trim() : `(stat failed: ${r.stderr.toString().trim()})`;
}

export function launchctlLoaded(label: string): boolean {
	return Bun.spawnSync(["launchctl", "print", `system/${label}`], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
}

export function qemuArgv(pid: number): string {
	return Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)], { stdout: "pipe" }).stdout.toString().trim();
}

export function processUid(pid: number): number | undefined {
	const out = Bun.spawnSync(["ps", "-o", "uid=", "-p", String(pid)], { stdout: "pipe" }).stdout.toString().trim();
	return out ? Number(out) : undefined;
}

export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** The interface the host's default route leaves through: the one a bridged guest would reach the LAN on. */
export function defaultRouteInterface(): string | undefined {
	const out = Bun.spawnSync(["route", "-n", "get", "default"], { stdout: "pipe", stderr: "pipe" }).stdout.toString();
	return out.match(/^\s*interface:\s*(\S+)/m)?.[1];
}

// ── guest ──────────────────────────────────────────────────────────────────────

export interface GuestLease {
	address: string;
	gateway: string;
}

export async function guestLease(instance: ChrInstance, iface: string): Promise<GuestLease | undefined> {
	const out = (await instance.exec(`/ip/dhcp-client/print terse where interface=${iface} and status=bound`)).output;
	const address = out.match(/(?:^|\s)address=(\S+)/)?.[1];
	const gateway = out.match(/(?:^|\s)gateway=(\S+)/)?.[1];
	return address && gateway ? { address, gateway } : undefined;
}

/** Bound on `iface` and a clean echo from the gateway it leased, re-read each try: a
 *  socket that accepts is not a network that forwards (#270). Returns the lease that
 *  answered, or undefined at the deadline. */
export async function waitForGuestTraffic(instance: ChrInstance, iface: string): Promise<GuestLease | undefined> {
	let answered: GuestLease | undefined;
	await instance.waitFor(async () => {
		const lease = await guestLease(instance, iface);
		if (!lease) return false;
		const ping = (await instance.exec(`/ping ${lease.gateway} count=1 interface=${iface}`)).output;
		if (!ping.includes("packet-loss=0%")) return false;
		answered = lease;
		return true;
	}, GUEST_NET_DEADLINE_MS);
	return answered;
}

/** What the guest can do on its leased network, each part on its own: an ICMP echo
 *  from the gateway, the gateway's MAC learned by ARP (a unicast reply), and a DNS
 *  answer from the gateway (a UDP round trip). A bridged guest on the hosted arm64
 *  runner gets only the ARP reply (runs 43087917622, 43092868845), so callers choose
 *  what they require. */
export interface LanProbe {
	icmp: boolean;
	gatewayMac?: string;
	dns?: string;
	/** RouterOS says "dns server failure" both for an answer it rejects and after its
	 *  10 s timeout against a silent server (grounded on CHR 7.25.1), so how long the
	 *  query took is what tells them apart. */
	dnsMs?: number;
	errors: string[];
}

export async function probeLanFromGuest(instance: ChrInstance, lease: GuestLease, iface: string): Promise<LanProbe> {
	const probe: LanProbe = { icmp: false, errors: [] };
	const run = async (cmd: string) => (await instance.exec(cmd, { timeout: 30_000 })).output.trim();
	try {
		probe.icmp = (await run(`/ping ${lease.gateway} count=3 interface=${iface}`)).includes("received=3");
	} catch (e) {
		probe.errors.push(`ping: ${e instanceof Error ? e.message : String(e)}`);
	}
	try {
		const mac = await run(`:put [/ip/arp/get [find address=${lease.gateway} interface=${iface}] mac-address]`);
		if (/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/i.test(mac)) probe.gatewayMac = mac;
		else probe.errors.push(`arp: ${mac}`);
	} catch (e) {
		probe.errors.push(`arp: ${e instanceof Error ? e.message : String(e)}`);
	}
	const dnsStarted = Date.now();
	try {
		const answer = await run(`:put [:resolve domain-name=github.com server=${lease.gateway}]`);
		probe.dnsMs = Date.now() - dnsStarted;
		if (/^\d{1,3}(\.\d{1,3}){3}$/.test(answer)) probe.dns = answer;
		else probe.errors.push(`dns: ${answer}`);
	} catch (e) {
		probe.errors.push(`dns: ${e instanceof Error ? e.message : String(e)}`);
	}
	return probe;
}

/** Bound on `iface` with a gateway, without requiring any traffic beyond DHCP. */
export async function waitForGuestLease(instance: ChrInstance, iface: string): Promise<GuestLease | undefined> {
	let lease: GuestLease | undefined;
	await instance.waitFor(async () => {
		lease = await guestLease(instance, iface);
		return lease !== undefined;
	}, GUEST_NET_DEADLINE_MS);
	return lease;
}

/** The host connecting out to the guest's www (`address:80`): the first line it
 *  answers, or why not. Evidence, not an assertion: whether the guest serves www there
 *  is RouterOS config, and an outgoing LAN connection is subject to host policy (macOS
 *  Local Network privacy). `ECONNREFUSED` still means frames reached the guest and it
 *  answered with a reset (hosted macOS runners, run 43091867317). */
export async function hostReachesGuest(address: string, timeoutMs = 5_000): Promise<{ answer?: string; error?: string }> {
	const { createConnection } = await import("node:net");
	return new Promise((resolve) => {
		const socket = createConnection({ host: address, port: 80 });
		let data = "";
		const done = (v: { answer?: string; error?: string }) => {
			clearTimeout(timer);
			socket.destroy();
			resolve(v);
		};
		const timer = setTimeout(() => done({ error: `no answer in ${timeoutMs} ms` }), timeoutMs);
		socket.once("connect", () => socket.write(`GET / HTTP/1.0\r\nHost: ${address}\r\n\r\n`));
		socket.on("data", (chunk) => {
			data += chunk.toString();
			const line = data.split("\r\n")[0];
			if (line && data.includes("\r\n")) done({ answer: line });
		});
		socket.once("error", (e: NodeJS.ErrnoException) => done({ error: `${e.code ?? ""} ${e.message}`.trim() }));
	});
}

/** The guest fetching from a listener on the host at `hostAddress`: TCP both ways over
 *  the network, initiated by the guest, so no host outbound policy is involved. Returns
 *  the body the guest read, or the error. */
export async function guestReachesHost(instance: ChrInstance, hostAddress: string): Promise<{ ok: boolean; detail: string }> {
	const token = `quickchr-270-${process.pid}`;
	const server = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: () => new Response(token) });
	try {
		const url = `http://${hostAddress}:${server.port}/`;
		const out = (await instance.exec(`:put ([/tool/fetch url="${url}" output=user as-value]->"data")`, { timeout: 30_000 })).output.trim();
		return { ok: out === token, detail: `${url} -> ${out}` };
	} catch (e) {
		return { ok: false, detail: e instanceof Error ? e.message : String(e) };
	} finally {
		server.stop(true);
	}
}

export async function guestEvidence(instance: ChrInstance | undefined): Promise<Record<string, string>> {
	if (!instance) return { note: "no instance" };
	const commands = [
		"/ip/dhcp-client/print detail",
		"/ip/address/print",
		"/interface/print stats",
		"/log/print where topics~\"dhcp|interface\"",
		"/ip/arp/print",
	];
	const out: Record<string, string> = {};
	for (const c of commands) {
		try {
			out[c] = (await instance.exec(c, { timeout: 15_000 })).output;
		} catch (e) {
			out[c] = `(failed: ${e instanceof Error ? e.message : String(e)})`;
		}
	}
	return out;
}

// ── evidence ───────────────────────────────────────────────────────────────────

export async function hostEvidence(spec: ManagedNetworkSpec, qemuPid?: number): Promise<Record<string, unknown>> {
	const label = managedNetworkLabel(spec);
	const plan = planManagedNetwork(spec);
	const read = async (path: string) => {
		try {
			return await Bun.file(path).text();
		} catch (e) {
			return `(unreadable: ${e instanceof Error ? e.message : String(e)})`;
		}
	};
	const run = (argv: string[]) => {
		const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
		return `exit ${r.exitCode}\n${r.stdout.toString()}${r.stderr.toString()}`;
	};
	return {
		plist: await read(plan.plistPath),
		launchctlPrint: run(["launchctl", "print", `system/${label}`]),
		helperLog: await read(plan.logPath),
		ls: run(["ls", "-l", plan.plistPath, plan.socketPath, plan.helperPath, MANAGED_LOG_DIR]),
		idGroups: run(["id"]),
		qemuArgv: qemuPid ? qemuArgv(qemuPid) : null,
		qemuUid: qemuPid ? processUid(qemuPid) : null,
		ifconfig: run(["ifconfig", "-a"]),
		arp: run(["arp", "-an"]),
		// Stealth mode drops ICMP echo to the host, which is the shared network's gateway.
		firewall: run(["/usr/libexec/ApplicationFirewall/socketfilterfw", "--getglobalstate", "--getstealthmode"]),
		pf: run(["sudo", "-n", "pfctl", "-s", "info"]),
	};
}

export async function writeEvidence(name: string, body: unknown): Promise<string> {
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	const path = join(EVIDENCE_DIR, `managed-network-${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
	await Bun.write(path, `${JSON.stringify(body, null, 2)}\n`);
	return path;
}

// ── setup and cleanup ──────────────────────────────────────────────────────────

/** Refuse a test machine name that already exists: the test removes what it creates,
 *  and must never stop or delete a machine it did not create (a developer running the
 *  opt-in locally may have one). */
export async function assertMachineAbsent(name: string): Promise<void> {
	const { QuickCHR } = await import("../../src/lib/quickchr.ts");
	if (QuickCHR.get(name)) {
		throw new Error(`A machine named ${name} already exists in ${getDataDir()}. This test creates and removes its own and will not touch one it did not create. Remove it first (quickchr remove ${name}).`);
	}
}

/** Stop and remove a machine this test created. Failures are returned, not swallowed,
 *  and the machine has to be gone afterwards for cleanup to count as clean. */
export async function cleanupMachine(name: string): Promise<string[]> {
	const { QuickCHR } = await import("../../src/lib/quickchr.ts");
	const problems: string[] = [];
	const existing = QuickCHR.get(name);
	if (!existing) return problems;
	try { await existing.stop(); } catch (e) { problems.push(`stop ${name}: ${e instanceof Error ? e.message : String(e)}`); }
	try { await existing.remove(); } catch (e) { problems.push(`remove ${name}: ${e instanceof Error ? e.message : String(e)}`); }
	if (QuickCHR.get(name)) problems.push(`${name} still exists after cleanup`);
	return problems;
}

/** What existed before the test, so cleanup removes only what this run created. */
export interface HostBaseline {
	helper: boolean;
	log: boolean;
	/** Directories on the way to the helper and the log that did not exist yet,
	 *  deepest first: removed afterwards only if empty. */
	newDirs: string[];
}

export const OPT_DIR = dirname(MANAGED_HELPER_ROOT);

/** Every directory from `/opt/quickchr` down to `path`'s parent, deepest first. */
function dirChain(path: string, top: string): string[] {
	const dirs: string[] = [];
	for (let d = dirname(path); d.startsWith(top); d = dirname(d)) dirs.push(d);
	return dirs;
}

/** Passwordless sudo, no existing managed network of this kind, and no machine with
 *  any of the test's names. Records what exists, so cleanup leaves the rest alone. */
export async function preflight(spec: ManagedNetworkSpec, machines: string[]): Promise<HostBaseline> {
	const sudo = await sh(["sudo", "-n", "true"]);
	if (sudo.exitCode !== 0) {
		throw new Error(`The managed-network lifecycle needs passwordless sudo (sudo -n), which this host does not grant. Hosted macOS runners do; locally, run 'sudo -v' first.\n${show(sudo)}`);
	}
	const existing = findManagedNetwork(spec);
	if (existing) {
		throw new Error(`A managed network ${existing.label} already exists (${existing.plistPath}). This test installs and removes its own and will not touch one it did not create: it is host-wide and may carry other machines. Remove it first (quickchr networks remove …) or run on a clean host.`);
	}
	for (const name of machines) await assertMachineAbsent(name);
	const plan = planManagedNetwork(spec);
	const dirs = [...dirChain(plan.helperPath, OPT_DIR), MANAGED_LOG_DIR];
	return {
		helper: existsSync(plan.helperPath),
		log: existsSync(plan.logPath),
		newDirs: dirs.filter((d) => !existsSync(d)),
	};
}

/** Remove the service through the CLI, and by hand if that fails; then what this run
 *  added to the host: its log, the helper if it installed it and no managed network
 *  still uses one, and directories it created, only once empty (`rmdir`). Errors are
 *  collected, not thrown, so cleanup of one thing never stops cleanup of the next. */
export async function cleanupService(spec: ManagedNetworkSpec, baseline: HostBaseline | undefined, specifier: string): Promise<string[]> {
	// No baseline means preflight refused, possibly because the network already existed:
	// then it is not ours, and cleanup must not remove it.
	if (!baseline) return [];
	const problems: string[] = [];
	const label = managedNetworkLabel(spec);
	const plan = planManagedNetwork(spec);
	if (findManagedNetwork(spec) || launchctlLoaded(label)) {
		const r = await quickchr("networks", "remove", specifier, "--yes", "--force");
		if (r.exitCode !== 0) {
			problems.push(`quickchr networks remove failed:\n${show(r)}`);
			await sh(["sudo", "-n", "launchctl", "bootout", `system/${label}`]);
			await sh(["sudo", "-n", "rm", "-f", plan.plistPath, plan.socketPath]);
		}
	}
	if (!baseline.log) await sh(["sudo", "-n", "rm", "-f", plan.logPath]);
	if (!baseline.helper && listManagedNetworks().length === 0) await sh(["sudo", "-n", "rm", "-f", plan.helperPath]);
	for (const dir of baseline.newDirs) await sh(["sudo", "-n", "rmdir", dir]);
	if (launchctlLoaded(label)) problems.push(`${label} is still loaded after cleanup`);
	if (existsSync(plan.plistPath)) problems.push(`${plan.plistPath} still exists after cleanup`);
	return problems;
}

/** Run `body`, then `cleanup` whatever happened. A cleanup failure never replaces the
 *  body's own failure (both are reported), and cleanup that leaves state behind fails
 *  an otherwise green test: a leftover root service is not a pass. */
export async function withCleanup(body: () => Promise<void>, cleanup: () => Promise<string[]>): Promise<void> {
	let failure: unknown;
	try {
		await body();
	} catch (e) {
		failure = e;
	}
	const problems = await cleanup().catch((e: unknown) => [`cleanup threw: ${e instanceof Error ? e.message : String(e)}`]);
	if (failure) {
		if (problems.length > 0 && failure instanceof Error) failure.message += `\n\ncleanup also left state behind:\n${problems.join("\n")}`;
		throw failure;
	}
	if (problems.length > 0) throw new Error(`cleanup left state behind:\n${problems.join("\n")}`);
}

/** Run one named phase; a failure is rethrown with the phase name and with the
 *  evidence written next to it. */
export async function phase<T>(
	record: Record<string, unknown>,
	name: string,
	evidence: () => Promise<Record<string, unknown>>,
	fn: () => Promise<T>,
): Promise<T> {
	const started = Date.now();
	try {
		const value = await fn();
		record[name] = { ok: true, ms: Date.now() - started };
		return value;
	} catch (e) {
		record[name] = { ok: false, ms: Date.now() - started, error: e instanceof Error ? e.message : String(e) };
		let where = "(evidence could not be written)";
		try {
			where = await writeEvidence(`failure-${name}`, { phase: name, record, evidence: await evidence(), transcript });
		} catch { /* keep the original failure */ }
		throw new Error(`phase "${name}" failed (evidence: ${where}):\n${e instanceof Error ? e.message : String(e)}`);
	}
}

// ── the bridged probe (suite on arm64, lab anywhere) ───────────────────────────

/** Everything one bridged run found. Written to the evidence dir either way. */
export interface BridgedProbeResult {
	iface: string;
	created: CliResult;
	status?: StatusRow;
	qemuArgv?: string;
	lease?: GuestLease;
	lan?: LanProbe;
	record: Record<string, unknown>;
}

/** Create `bridged:<iface>` on the default-route interface, attach a CHR, take a lease
 *  and probe the LAN from the guest; then remove the machine and the service. The
 *  phases that must hold anywhere (create serves, QEMU attaches to the managed socket,
 *  a lease) throw; what the LAN allows beyond that is returned for the caller to judge. */
export async function runBridgedProbe(machine: string, imageOpts: Record<string, unknown>): Promise<BridgedProbeResult> {
	const { QuickCHR } = await import("../../src/lib/quickchr.ts");
	const { loadMachine } = await import("../../src/lib/state.ts");
	const { managedSocketPath } = await import("../../src/lib/platform.ts");
	const iface = defaultRouteInterface();
	if (!iface) throw new Error("no default route: cannot pick an interface to bridge");
	const spec: ManagedNetworkSpec = { mode: "bridged", iface };
	const specifier = `bridged:${iface}`;
	const record: Record<string, unknown> = { host: { arch: process.arch }, iface };
	const result: Partial<BridgedProbeResult> & { record: Record<string, unknown> } = { iface, record };
	let baseline: HostBaseline | undefined;
	let instance: ChrInstance | undefined;
	let qemuPid: number | undefined;
	const evidence = async () => ({ ...(await hostEvidence(spec, qemuPid)), guest: await guestEvidence(instance) });

	await withCleanup(async () => {
		baseline = await phase(record, "preflight", evidence, () => preflight(spec, [machine]));
		await phase(record, "create", evidence, async () => {
			result.created = await quickchr("networks", "create", specifier, "--yes");
			expectExit(result.created, 0);
			const st = await status(specifier);
			result.status = st.row;
			if (!st.row?.ok) throw new Error(`status after create is not ok:\n${show(st.result)}`);
		});
		await phase(record, "attach", evidence, async () => {
			instance = await QuickCHR.start({ ...imageOpts, background: true, name: machine, networks: ["user", { type: "bridged", iface }] });
			qemuPid = loadMachine(machine)?.pid;
			result.qemuArgv = qemuArgv(qemuPid as number);
			const socket = managedSocketPath(`bridged-${iface}`);
			if (!result.qemuArgv.includes(`addr.path=${socket}`)) throw new Error(`QEMU is not on ${socket}:\n${result.qemuArgv}`);
			await instance.exec("/ip/dhcp-client/add interface=ether2 add-default-route=no");
			result.lease = await waitForGuestLease(instance, "ether2");
			record.lease = result.lease ?? null;
			if (!result.lease) throw new Error(`no DHCP lease on ether2 (${specifier})`);
			result.lan = await probeLanFromGuest(instance, result.lease, "ether2");
			record.lan = result.lan;
			record.guest = await guestEvidence(instance);
		});
	}, async () => {
		const problems = baseline ? [...(await cleanupMachine(machine)), ...(await cleanupService(spec, baseline, specifier))] : [];
		record.cleanup = problems.length === 0 ? "clean" : problems;
		const where = await writeEvidence("bridged-probe", { record, transcript });
		console.log(`managed-network bridged probe (${where}):\n${JSON.stringify(record, null, 2)}`);
		return problems;
	});
	return result as BridgedProbeResult;
}
