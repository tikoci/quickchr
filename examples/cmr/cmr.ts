#!/usr/bin/env bun
import { QuickCHR } from "../../src/index.ts";
import { check, exampleMachineName, runExample } from "../lib.ts";
import { cancellation, command, createLab, labVersion, read, removeByPrefix, untracked, until, type Lab, type Row } from "./tool/lab.ts";
import { pairClient } from "./tool/pairing.ts";
import { probes } from "./tool/probes.ts";
import { STUDIES } from "./tool/studies.ts";

/**
 * Pair the three clients the way FINDINGS.md recommends, then label all four routers.
 * Returns how each pairing went, so a build that needed the half-pair repair shows in the report.
 */
export async function configureClients(lab: Lab): Promise<Row[]> {
	const { controller, transit, remote, local } = lab;
	await command(transit, "/cmr/client/set enabled=yes controller-addresses=192.0.2.1");
	await command(remote, "/cmr/client/set enabled=yes controller-addresses=10.255.0.1");
	// No CMR address or DHCP CMR option: this client must discover its L2 neighbor.
	await command(local, "/cmr/client/set enabled=yes");
	const pairing: Row[] = [];
	for (const [role, client] of [["transit", transit], ["remote", remote], ["local", local]] as const) {
		const { result, repaired } = await pairClient(controller, client);
		pairing.push({ role, strategy: result.strategy, pairStatus: result.pairStatus, settled: result.settled.verdict, repaired: String(repaired) });
	}
	for (const role of ["controller", "transit", "remote", "local"]) {
		await command(controller, `/cmr/device/set [find identity=cmr-${role}] labels=lab,${role}`);
	}
	await until("four managed devices", async () => (await read(controller, "/cmr/device")).filter(r => r.identity?.startsWith("cmr-")).length === 4);
	return pairing;
}

export async function exercise(lab: Lab, keepWebhook?: (stop: () => Promise<void>) => void, extended = false, evidence: Record<string, unknown> = {}) {
	const { controller, local, version } = lab;
	let remote = lab.remote;
	Object.assign(evidence, { version, timestamp: new Date().toISOString() });
	evidence.pairing = await configureClients(lab);
	const service = (await read(controller, "/ip/service")).find(r => r.name === "cmr");
	check(service?.port === "54321", "CMR TCP service missing");
	evidence.service = service;
	evidence.remoteRoute = (await read(remote, "/routing/route")).filter(r => r["dst-address"] === "10.255.0.1/32");
	evidence.discovery = await read(local, "/cmr/client");
	check(!(evidence.discovery as Row[])[0]?.["controller-addresses"], "Discovery client has a configured controller address");
	check((await read(remote, "/cmr/client"))[0]?.["controller-address"] === "10.255.0.1", "Remote client did not use the routed loopback");
	console.log("OSPF route and CMR pairing verified; local client discovered controller without an address");

	await command(controller, `/cmr/upgrade/add name=lab-pinned labels=lab channel=${version} strategy=sequential fail-policy=stop`);
	await until("pinned rule selected", async () => (await read(controller, "/cmr/device")).every(r => r["upgrade-rule"] === "lab-pinned"));
	evidence.upgradeRules = await read(controller, "/cmr/upgrade");

	// These rules make a useful dashboard. Only deterministic conditions are triggered below.
	const alerts = [
		'name=lab-cpu labels=lab cpu-above=85 action.log="CPU [identity] [cpu-usage]" severity=high',
		'name=lab-memory labels=lab mem-above=80 action.log="MEM [identity] [mem-usage]" severity=high',
		'name=lab-disk labels=lab hdd-above=80 action.log="DISK [identity] [hdd-usage]" severity=high',
		'name=lab-reboot labels=lab rebooted=yes action.log="REBOOT [identity]"',
		'name=lab-interface labels=remote interface-type=bridge interface-change=added action.log="IFACE [identity] [iface-name]"',
		'name=lab-log labels=remote log-topics=warning log-regex=CMR-LAB-PROBE action.log="LOG [identity] [message]"',
		'name=lab-available labels=lab upgrade-available=yes action.log="VERSION [identity] [available-version]"',
		'name=lab-upgrade-done labels=lab upgrade-done=success action.log="UPGRADE [identity] [upgrade-state]"',
	];
	for (const rule of alerts) await command(controller, `/cmr/alert/add ${rule}`);

	const nonce = `cmr-${crypto.randomUUID().slice(0, 8)}`;
	const fanOut = await command(controller, `/cmr/device/run-script labels=lab script=":put \\"${nonce}\\""`);
	for (const role of ["controller", "transit", "remote", "local"]) {
		check(new RegExp(`^cmr-${role}(?:@\\S+)?\\s+success\\s+${nonce}\\s*$`, "m").test(fanOut.replaceAll("\r", "")), `Missing successful fan-out output: ${role}`);
	}
	evidence.fanOut = fanOut;
	await command(controller, "/cmr/layout/add name=lab");
	await command(controller, "/cmr/layout/add-devices [find name=lab] labels=lab");
	await command(controller, "/cmr/layout/rebuild-links [find name=lab]");
	const nodes = await read(controller, "/cmr/layout/node");
	check(nodes.length === 4, `Expected four layout nodes, got ${nodes.length}`);
	await until("three topology links", async () => {
		await command(controller, "/cmr/layout/rebuild-links [find name=lab]");
		return (await read(controller, "/cmr/layout/link")).length === 3;
	});
	evidence.layout = { nodes, links: await read(controller, "/cmr/layout/link") };
	// 7.26beta3 added /cmr/device/export; the rows carry ids and pairing-requirement, not live state.
	const deviceExport = await command(controller, "/cmr/device/export");
	check(/add identity=cmr-remote ids=/.test(deviceExport.replaceAll(/\\\r?\n\s*/g, "")), "Device export is missing the remote");
	const received: { body: string; contentType: string | null }[] = [];
	const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		received.push({ body: await request.text(), contentType: request.headers.get("content-type") });
		return new Response("ok");
	} });
	keepWebhook?.(() => listener.stop(true));
	try {
		const webhook = `action.http-url="http://${controller.hostGatewayIp}:${listener.port}/cmr" action.http-method=post action.http-headers="Content-Type: text/plain"`;
		await command(controller, `/cmr/alert/add name=lab-down labels=remote disconnected-more-than=10s action.log="DOWN [identity] [address]" ${webhook} action.http-body="DOWN [identity] [address]" severity=high`);
		await command(controller, `/cmr/alert/add name=lab-connected labels=remote connected=yes reset-on-disconnect=yes action.log="UP [identity] [address]" ${webhook} action.http-body="UP [identity] [address]"`);
		const fired = async (name: string) => Number((await read(controller, "/cmr/alert")).find(r => r.name === name)?.fired ?? 0);
		await until("initial connected webhook", async () => received.some(r => r.body.startsWith("UP cmr-remote")));
		
		await until("CMR managed log subscription", async () => (await read(remote, "/system/logging")).some(r => r.managed === "true" && r.action === "cmr" && r.regex === "CMR-LAB-PROBE"));
		await command(remote, '/log/warning message="CMR-LAB-PROBE"');
		await until("remote log alert", async () => await fired("lab-log") > 0);
		console.log("Remote log alert verified");
		await command(remote, "/interface/bridge/add name=cmr-lab-probe");
		await until("interface alert", async () => await fired("lab-interface") > 0);
		console.log("Remote interface alert verified");
		await command(remote, "/interface/bridge/remove [find name=cmr-lab-probe]");

		evidence.webhooks = received;
		if (extended) {
			// Attached before probing so a failed probe still reports what it observed.
			const probeEvidence: Record<string, unknown> = {};
			evidence.probes = probeEvidence;
			await probes(lab, true, probeEvidence);
			// The probes reboot the controller, which can fire these rules first; require new ones.
			const hooks = (prefix: string) => received.filter(r => r.body.startsWith(prefix)).length;
			const downBefore = await fired("lab-down");
			const downHooksBefore = hooks("DOWN cmr-remote");
			const upBefore = await fired("lab-connected");
			const upHooksBefore = hooks("UP cmr-remote");
			await remote.stop();
			await until("remote down alert and webhook", async () => await fired("lab-down") > downBefore && hooks("DOWN cmr-remote") > downHooksBefore, 120_000);
			console.log("Remote disconnect alert and webhook verified");
			remote = await QuickCHR.start({ name: remote.name });
			lab.remote = remote;
			lab.all[2] = remote;
			await until("remote reconnected without re-pairing", async () => (await read(remote, "/cmr/client"))[0]?.status === "paired,connected");
			await until("reconnected alert", async () => await fired("lab-connected") > upBefore && hooks("UP cmr-remote") > upHooksBefore, 120_000);
			evidence.automaticReconnect = true;
		}
		evidence.webhooks = received;
	} finally {
		if (!keepWebhook) await listener.stop(true);
	}

	evidence.devices = await read(controller, "/cmr/device");
	evidence.alerts = await read(controller, "/cmr/alert");
	check((evidence.alerts as Row[]).filter(r => r.name?.startsWith("lab-")).every(r => Number(r["action-failures"] ?? 0) === 0), "CMR action failures occurred");
	console.log("CMR demo verified: four-device fan-out, topology, log/interface alerts and HTTP webhook");
	return evidence;
}

if (import.meta.main) {
	const webhookStops: (() => Promise<void>)[] = [];
	const prefix = exampleMachineName("cmr");
	// Remove by name, not by handle: --probe restarts the remote, and only a fresh lookup
	// carries the restarted QEMU's PID. Also catches a VM whose start failed after spawning.
	// Study labs are named <prefix>-<n>-<role>, so this prefix covers them too.
	const removeLab = async () => removeByPrefix(prefix);
	let releaseHold: (() => void) | undefined;
	const onSignal = () => {
		if (releaseHold) return releaseHold();
		if (!cancellation.requested) {
			// Let in-flight starts finish; the next lab step throws and the finally below removes the VMs.
			cancellation.requested = true;
			console.log("\nCancelling; removing the lab VMs after the current step (Ctrl-C again to force)");
			return;
		}
		void removeLab().finally(() => process.exit(130));
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	try {
		// Teardown is by name prefix (removeLab), not runExample's handle tracking: --probe restarts
		// the remote under a new PID, and studies boot several labs.
		await runExample(async () => {
			try {
				const studyIndex = process.argv.indexOf("--study");
				if (studyIndex >= 0) await runStudy(untracked, process.argv[studyIndex + 1]);
				else await runLab(untracked);
			} finally {
				await removeLab();
			}
		});
	} finally {
		for (const stop of webhookStops) await stop();
	}

	async function writeReport(evidence: Record<string, unknown>) {
		const reportIndex = process.argv.indexOf("--report");
		if (reportIndex < 0) return;
		const reportPath = process.argv[reportIndex + 1];
		check(reportPath, "--report needs a path");
		await Bun.write(reportPath, `${JSON.stringify(evidence, null, 2)}\n`);
		console.log(`Report written to ${reportPath}`);
	}

	async function runStudy(track: typeof untracked, name: string | undefined) {
		const study = name ? STUDIES[name] : undefined;
		check(study, `--study needs one of: ${Object.keys(STUDIES).join(", ")}`);
		const version = labVersion();
		const evidence: Record<string, unknown> = { study: name, version, timestamp: new Date().toISOString(), arch: "x86", host: `${process.platform}/${process.arch}` };
		try {
			await study({ version, prefix, argv: process.argv, track, evidence });
			console.log(`Study ${name} finished on ${version}`);
		} catch (error) {
			evidence.failure = String(error);
			throw error;
		} finally {
			await writeReport(evidence);
		}
	}

	async function runLab(track: typeof untracked) {
		const lab = await createLab(track, { initialBridge: !process.argv.includes("--first-bridge"), prefix });
		const hold = process.argv.includes("--hold");
		const evidence: Record<string, unknown> = {};
		let failure: unknown;
		try {
			await exercise(lab, hold ? stop => webhookStops.push(stop) : undefined, process.argv.includes("--probe"), evidence);
		} catch (error) {
			failure = error;
			evidence.failure = String(error);
			const state: Record<string, unknown> = {};
			for (const path of ["/cmr/client", "/routing/ospf/neighbor", "/routing/route", "/log"]) {
				try {
					const data = await read(lab.remote, path);
					state[path] = path === "/log" ? data.filter(r => r.topics?.includes("cmr")).slice(-20) : data;
				} catch (readError) { state[path] = String(readError); }
			}
			evidence.failureState = state;
		}
		await writeReport(evidence);
		if (failure) throw failure;
		if (hold) {
			console.log("Lab is running; open the controller in WinBox 4. Ctrl-C removes all four VMs.");
			for (const chr of lab.all) console.log(`${chr.name} WinBox port ${chr.ports.winbox}`);
			await new Promise<void>(resolve => { releaseHold = resolve; });
		}
	}
}
