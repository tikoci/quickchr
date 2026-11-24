/**
 * Grounding studies: bounded experiments that each answer one CMR question on a fresh lab and
 * record raw RouterOS output. They do not assert expectations (a beta may change any of them);
 * they fail only when the lab itself breaks. FINDINGS.md is where the answers are kept, per build.
 *
 *   bun run cmr.ts --study pairing [--boots 3] [--trials 8] [--strategies credentialed,confirm-first]
 *   bun run cmr.ts --study policy
 *   bun run cmr.ts --study recheck
 *   bun run cmr.ts --study wire [--boots 1] [--trials 8] [--delays 0,5,30,75]
 *   bun run cmr.ts --study repair [--boots 2] [--trials 8]
 *
 * Add a study: write `async function <name>(context)` below, register it in STUDIES, and add
 * its question and result rows to FINDINGS.md.
 */
import { request } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { type ChrInstance, stripAnsi } from "../../../src/index.ts";
import { check } from "../../lib.ts";
import { attempt, command, createPairLab, identityOf, loginOf, operand, quote, read, removeByPrefix, until, type PairLab, type Row } from "./lab.ts";
import { lastPairStatus, type Observation, observe, pairClient, pairWith, rebootRouter, resetPairing, restartController, selectable, strategyNames, waitPending, waitStable, type Strategy } from "./pairing.ts";
import { CMR_PORT, wire as wireCapture } from "./wire.ts";

export interface StudyContext {
	version: string;
	/** Machine-name prefix the runner tears down by; each lab adds a suffix. */
	prefix: string;
	argv: string[];
	track: <T extends ChrInstance>(instance: T) => T;
	evidence: Record<string, unknown>;
}


/** An integer operand from 1 to 100, or the fallback when the flag is absent. */
function count(context: StudyContext, name: string, fallback: number): number {
	const value = Number(operand(context.argv, name) ?? fallback);
	check(Number.isInteger(value) && value >= 1 && value <= 100, `--${name} must be an integer from 1 to 100`);
	return value;
}

/** Boot a pair lab, run `body`, and remove the lab whatever happens. */
let labCount = 0;
async function withPairLab<T>(context: StudyContext, body: (lab: PairLab) => Promise<T>, enable = true): Promise<T> {
	const prefix = `${context.prefix}-${++labCount}`;
	try {
		const lab = await createPairLab(context.track, { version: context.version, prefix, enable });
		return await body(lab);
	} finally {
		await removeByPrefix(prefix);
	}
}

/**
 * Q: which pairing sequences leave the client half-paired, how often, and does it vary by boot?
 * Each trial starts from a fresh, never-seen client, runs one strategy, checks run-script
 * selection, then restarts the controller's CMR service to see whether the pairing was committed.
 */
async function pairing(context: StudyContext): Promise<void> {
	const boots = count(context, "boots", 2);
	const trials = count(context, "trials", 8);
	const strategies = (operand(context.argv, "strategies")?.split(",") ?? strategyNames) as Strategy[];
	for (const s of strategies) check(strategyNames.includes(s), `Unknown strategy ${s}; known: ${strategyNames.join(", ")}`);
	const results: Row[] = [];
	context.evidence.question = "Which pairing sequences leave a fresh client half-paired, and is it per boot?";
	context.evidence.parameters = { boots, trials, strategies };
	context.evidence.trials = results;
	const detail: unknown[] = [];
	context.evidence.detail = detail;
	for (let boot = 1; boot <= boots; boot++) {
		await withPairLab(context, async ({ controller, client }) => {
			const identity = await identityOf(client);
			const enabled = Date.now();
			await waitPending(controller, client, identity);
			const firstConnectSeconds = Math.round((Date.now() - enabled) / 1000);
			console.log(`Boot ${boot}: client pending ${firstConnectSeconds}s after the lab enabled it`);
			for (let trial = 1; trial <= trials; trial++) {
				const strategy = strategies[(trial - 1) % strategies.length] as Strategy;
				if (trial > 1) {
					await resetPairing(controller, client, identity);
					await waitPending(controller, client, identity);
				}
				const result = await pairWith(controller, client, identity, strategy);
				const selection = await selectable(controller, identity);
				const afterRestart = await restartController(controller, client, identity);
				let repairedAfterRestart: string | undefined;
				if (afterRestart.verdict !== "paired") {
					// The documented recovery: a bare pair supplies the approval that was never saved.
					const repair = await attempt(controller, `/cmr/device/pair [find identity=${quote(identity)}]`);
					await until("repair settles", async () => (await observe(controller, client, identity)).verdict !== "pending", 20_000).catch(() => undefined);
					repairedAfterRestart = `${(await observe(controller, client, identity)).verdict} (${repair.replaceAll("\r", "").trim().split("\n").at(-1)?.trim()})`;
				}
				const row = {
					boot: String(boot), trial: String(trial), strategy,
					pairStatus: result.pairStatus,
					settled: result.settled.verdict,
					selectable: String(selection.selected),
					afterRestart: afterRestart.verdict,
					afterRestartState: afterRestart.row?.state ?? "",
					...(repairedAfterRestart ? { repairedAfterRestart } : {}),
				};
				results.push(row as Row);
				detail.push({ boot, trial, firstConnectSeconds: trial === 1 ? firstConnectSeconds : undefined, result, selection, afterRestart });
				console.log(`  boot ${boot} trial ${trial} ${strategy.padEnd(13)} pair→${row.pairStatus.padEnd(18)} settled=${row.settled.padEnd(11)} run-script=${row.selectable.padEnd(5)} after restart=${row.afterRestart}${repairedAfterRestart ? `, bare pair → ${repairedAfterRestart}` : ""}`);
			}
		});
	}
	const summary: Record<string, Record<string, number>> = {};
	for (const r of results) {
		const key = `boot ${r.boot} ${r.strategy}`;
		summary[key] ??= {};
		const bucket = summary[key] as Record<string, number>;
		const outcome = r.afterRestart === "paired" && r.selectable === "true" ? "committed" : r.settled;
		bucket[outcome as string] = (bucket[outcome as string] ?? 0) + 1;
	}
	context.evidence.summary = summary;
	console.table(summary);
}

interface PolicyCase { id: string; policy: string; script: string; manual: string; verify?: (client: ChrInstance) => Promise<unknown> }

/**
 * Q: what can a `run-script` script do on the client, and which controller logins may send one?
 * Compares each case with the manual's permission table. Side effects are read back over REST.
 */
async function policy(context: StudyContext): Promise<void> {
	context.evidence.question = "What may a CMR run-script do on a client, and which controller logins may dispatch it?";
	await withPairLab(context, async ({ controller, client }) => {
		await pairClient(controller, client);
		const identity = await identityOf(client);
		const find = `[find identity=${quote(identity)}]`;
		const named = (path: string, name: string) => async (chr: ChrInstance) => (await read(chr, path)).find(r => r.name === name) ?? null;

		// Controller logins first: the client cases run once per login that may send run-script.
		await command(controller, '/cmr/alert/add name=policy-test labels=all rebooted=yes action.log="policy test [identity]"');
		const groups: Record<string, string> = {
			"cmr-read": "read,test,api,rest-api",
			"cmr-write": "read,write,test,api,rest-api",
			"cmr-reboot": "read,reboot,test,api,rest-api",
			"cmr-write-reboot": "read,write,reboot,test,api,rest-api",
		};
		const logins: Record<string, { user: string; password: string }> = {};
		const controllerCases: Row[] = [];
		context.evidence.controllerLogins = controllerCases;
		for (const [group, policies] of Object.entries(groups)) {
			await command(controller, `/user/group/add name=${group} policy=${policies}`);
			const password = `Cmr-${crypto.randomUUID().slice(0, 12)}`;
			await command(controller, `/user/add name=${group} group=${group} password=${quote(password)}`);
			logins[group] = { user: group, password };
			const nonce = `pol-${crypto.randomUUID().slice(0, 6)}`;
			const raw: Record<string, string> = {};
			const run = async (key: string, line: string) => {
				let output: string;
				try {
					output = (await attempt(controller, line, logins[group])).replaceAll("\r", "").trim();
				} catch (error) { output = `error: ${error instanceof Error ? error.message : String(error)}`; }
				raw[key] = output;
				return output.split("\n").at(-1)?.trim() ?? "";
			};
			const row: Row = {
				group, policies,
				inventory: await run("inventory", ":put [:len [/cmr/device/find]]"),
				runScript: await run("runScript", `/cmr/device/run-script ${find} script=":put ${nonce}"`),
				alertTest: await run("alertTest", "/cmr/alert/test [find name=policy-test]"),
			};
			row.output = JSON.stringify(raw);
			controllerCases.push(row);
			console.log(`  ${group.padEnd(17)} run-script: ${row.runScript} | alert test: ${row.alertTest}`);
		}

		// Client cases, sent by the full admin login and by the least login that may send run-script.
		// The question is whether the client side is bounded by the sender's policy (e.g. `policy`).
		const cases = (tag: string): PolicyCase[] => {
			const n = `cmr-${tag}`;
			return [
				{ id: "read-identity", policy: "read", script: ":put [/system/identity/get name]", manual: "ok" },
				{ id: "read-export", policy: "read", script: `/export file=${n}-export`, manual: "ok (export works; sensitive values left out)", verify: named("/file", `${n}-export.rsc`) },
				{ id: "write-file", policy: "write", script: `/file/add name=${n}.txt contents=x`, manual: "ok", verify: named("/file", `${n}.txt`) },
				{ id: "write-script", policy: "write", script: `/system/script/add name=${n} source=":put 1" policy=read,write,test,reboot,policy,sensitive`, manual: "ok, saved policy=reboot,read,write,test owner *sys", verify: named("/system/script", n) },
				{ id: "test-ping", policy: "test", script: "/ping 192.0.2.1 count=1", manual: "ok" },
				{ id: "policy-user-add", policy: "policy", script: `/user/add name=${n} group=read password=Cmr-Policy-12345`, manual: "fail: not enough permissions (9)", verify: named("/user", n) },
				{ id: "policy-user-add-full", policy: "policy", script: `/user/add name=${n}-full group=full password=Cmr-Policy-12345`, manual: "fail: not enough permissions (9)", verify: named("/user", `${n}-full`) },
				{ id: "policy-group-add", policy: "policy", script: `/user/group/add name=${n} policy=read`, manual: "fail: not enough permissions (9)", verify: named("/user/group", n) },
				{ id: "sensitive-set", policy: "write", script: `/ppp/secret/add name=${n} password=abc`, manual: "ok (sensitive values can be set)", verify: named("/ppp/secret", n) },
				{ id: "sensitive-get", policy: "sensitive", script: `:put [/ppp/secret/get ${n} password]`, manual: "shows *" },
				{ id: "client-local-id", policy: "sensitive?", script: ":put [/cmr/client/get local-id]", manual: "not documented" },
				{ id: "sniff", policy: "sniff", script: "/tool/sniffer/start", manual: "fail: not enough permissions (9)" },
				{ id: "backup-save", policy: "sensitive/ftp?", script: `/system/backup/save name=${n} dont-encrypt=yes`, manual: "fail: not enough permissions (9)", verify: named("/file", `${n}.backup`) },
			];
		};
		const senders: [string, { user: string; password: string } | undefined][] = [["admin", undefined], ["cmr-write-reboot", logins["cmr-write-reboot"]]];
		const clientCases: Row[] = [];
		context.evidence.client = clientCases;
		for (const [sender, login] of senders) {
			for (const c of cases(sender === "admin" ? "policy" : "wr")) {
				let output: string;
				try {
					output = (await attempt(controller, `/cmr/device/run-script ${find} script=${quote(c.script)}`, login)).replaceAll("\r", "");
				} catch (error) { output = `error: ${error instanceof Error ? error.message : String(error)}`; }
				const result = output.trim().split("\n").at(-1)?.trim().replace(/^\S+\s+/, "") ?? "";
				const sideEffect = c.verify ? await c.verify(client) : undefined;
				clientCases.push({ sender, id: c.id, policy: c.policy, script: c.script, manual: c.manual, result, output: output.trim(), ...(sideEffect !== undefined ? { sideEffect: JSON.stringify(sideEffect) } : {}) });
				console.log(`  ${sender.padEnd(17)} ${c.id.padEnd(21)} ${result}${c.verify ? (sideEffect ? "  [created]" : "  [not created]") : ""}`);
			}
			await attempt(client, "/tool/sniffer/stop");
		}
	});
}

/**
 * Q: are the 7.26beta1 findings (SUPPORT-REPORTS.md) still true on this build?
 * Each check records the raw output; FINDINGS.md compares it with beta1.
 */
async function recheck(context: StudyContext): Promise<void> {
	context.evidence.question = "Do the 7.26beta1 lab findings still hold on this build?";
	await withPairLab(context, async ({ controller, client }) => {
		await pairClient(controller, client);
		const identity = await identityOf(client);
		const find = `[find identity=${quote(identity)}]`;
		const results: Record<string, unknown> = {};
		context.evidence.checks = results;

		// 1. Export of controller settings and device labels (beta3 changelog: fixed).
		await command(controller, "/file/add type=directory name=cmr-lab-packages");
		results.directoryWithoutSlash = await attempt(controller, "/cmr/set packages-directory=cmr-lab-packages");
		await command(controller, "/cmr/set packages-directory=cmr-lab-packages/ track-topology=yes fetch-comments=no auto-labels=identity,model");
		await until("client back after directory change", async () => (await observe(controller, client, identity)).verdict === "paired");
		await command(controller, `/cmr/device/set ${find} labels=lab,recheck`);
		const exported = await command(controller, "/cmr/export");
		results.export = exported.replaceAll("\r", "");
		results.exportHasServerSettings = /packages-directory=cmr-lab-packages\//.test(exported);
		results.exportHasDeviceLabels = /labels=lab,recheck/.test(exported);
		results.cmrPrint = await attempt(controller, "/cmr/print");
		results.cmrGet = (await read(controller, "/cmr"))[0];
		results.clientPrint = await attempt(client, "/cmr/client/print");

		// 2. First interface-change=added on a bridge-free device (beta3 changelog: fixed).
		check(!(await read(client, "/interface/bridge")).length, "Recheck client must start with no bridges");
		await command(controller, `/cmr/alert/add name=first-bridge labels=${identity} interface-type=bridge interface-change=added action.log="IFACE [identity] [iface-name]"`);
		// Give the rule time to cover the device before the first event, so a miss is not a startup window.
		// Coverage is read from the snapshot taken just before the event: a rule that did not cover the
		// client then cannot miss it, so firstBridgeFired is null (inconclusive) rather than false.
		await until("bridge rule covers the client", async () => Number((await read(controller, "/cmr/alert")).find(r => r.name === "first-bridge")?.devices ?? 0) > 0, 30_000).catch(() => undefined);
		await Bun.sleep(30_000);
		const ruleBefore = (await read(controller, "/cmr/alert")).find(r => r.name === "first-bridge");
		const ruleCovered = Number(ruleBefore?.devices ?? 0) > 0;
		results.firstBridgeRuleBefore = ruleBefore;
		results.ruleCovered = ruleCovered;
		await command(client, "/interface/bridge/add name=first-probe");
		const fired = async () => Number((await read(controller, "/cmr/alert")).find(r => r.name === "first-bridge")?.fired ?? 0);
		const firstBridgeObserved = await until("first bridge alert", async () => await fired() > 0, 60_000).then(() => true, () => false);
		results.firstBridgeFired = ruleCovered ? firstBridgeObserved : null;
		const firstBridgeAlertCount = await fired();
		results.firstBridgeAlertCount = firstBridgeAlertCount;
		await command(client, "/interface/bridge/add name=second-probe");
		results.secondBridgeFired = await until("second bridge alert", async () => await fired() > firstBridgeAlertCount, 60_000).then(() => true, () => false);
		results.bridgeAlertFired = await fired();

		// 3. Identity sync both ways (beta3 changelog: fixed).
		await command(controller, `/cmr/device/set ${find} identity=cmr-renamed`);
		results.identityFromController = await until("client renamed", async () => (await read(client, "/system/identity"))[0]?.name === "cmr-renamed", 30_000).then(() => true, () => false);
		await command(client, `/system/identity/set name=${identity}`);
		results.identityFromClient = await until("row renamed back", async () => (await read(controller, "/cmr/device")).some(r => r.identity === identity), 30_000).then(() => true, () => false);

		// 4. Default upgrade rule against a development build (vendor: intended).
		results.upgradeRules = await read(controller, "/cmr/upgrade");
		await until("version check", async () => !!(await read(controller, "/cmr/device")).find(r => r.identity === identity)?.["available-version"], 60_000).catch(() => undefined);
		results.deviceUpgradeView = (await read(controller, "/cmr/device")).map(r => ({ identity: r.identity, version: r.version, channel: r.channel, "available-version": r["available-version"], "upgrade-available": r["upgrade-available"], "upgrade-rule": r["upgrade-rule"] }));
		results.defaultRuleEdit = await attempt(controller, "/cmr/upgrade/set [find name=default] channel=development");

		// 5. Client pairing-requirement=confirm (beta1: syntax error; vendor: frozen before release).
		// Changing the requirement makes the client renegotiate, so this runs after the paired checks.
		results.clientConfirm = await attempt(client, "/cmr/client/set pairing-requirement=confirm");
		await Bun.sleep(5000);
		results.afterClientConfirm = await observe(controller, client, identity);
		// Back to the default (password) requirement, then pair again the recommended way.
		await command(client, "/cmr/client/set !pairing-requirement");
		await pairClient(controller, client);
		results.afterConfirmRestored = await observe(controller, client, identity);

		// 6. Client disable/enable (vendor: clearing the pairing is intended).
		await command(client, "/cmr/client/set enabled=no");
		await command(client, "/cmr/client/set enabled=yes");
		await until("client reconnects after enable", async () => (await observe(controller, client, identity)).clientStatus?.endsWith(",connected") === true, 120_000).catch(() => undefined);
		await Bun.sleep(5000);
		results.afterDisableEnable = await observe(controller, client, identity);
		for (const [key, value] of Object.entries(results)) {
			if (value === null || typeof value !== "object") console.log(`  ${key}: ${String(value).replaceAll("\r", "").trim().split("\n").at(-1)}`);
		}
	});
}

/**
 * Q: what crosses the link while a client finds the controller and pairs? Does MNDP carry CMR
 * state, does the way the client finds the controller (a configured address, or MNDP discovery
 * with no address) change the half-pair, and is the 85 s first connect caused by enabling the
 * client too soon after the controller?
 *
 * Every trial: controller CMR off, client reset to never-seen; set the method; enable the
 * controller; wait `delay`; enable the client; time the connect on the wire; pair with the single
 * credentialed `pair` (the sequence that half-pairs); then watch 25 s for the controller's polls.
 * Trials rotate method fastest, then delay, so the default 8 trials cover every combination. The
 * first trial on each boot also measures the fresh-boot first connect. Always captures (--sniff).
 */
async function wire(context: StudyContext): Promise<void> {
	const capture = wireCapture.capture;
	check(capture, "The wire study needs the capture the runner creates");
	const boots = count(context, "boots", 1);
	const trials = count(context, "trials", 8);
	const delays = (operand(context.argv, "delays") ?? "0,5,30,75").split(",").map(Number);
	for (const d of delays) check(Number.isInteger(d) && d >= 0 && d <= 600, "--delays must be integers from 0 to 600 (seconds)");
	const methods = ["address", "discovery"] as const;
	const results: Row[] = [];
	const detail: unknown[] = [];
	context.evidence.question = "What crosses the link while a client connects and pairs, and do discovery method or enable timing change the first connect or the half-pair?";
	context.evidence.parameters = { boots, trials, delays, methods, pair: "credentialed" };
	context.evidence.trials = results;
	context.evidence.detail = detail;
	for (let boot = 1; boot <= boots; boot++) {
		await withPairLab(context, async ({ controller, client }) => {
			const identity = await identityOf(client);
			const controllerIdentity = await identityOf(controller);
			for (let trial = 1; trial <= trials; trial++) {
				const method = methods[(trial - 1) % methods.length] as (typeof methods)[number];
				const delay = delays[Math.floor((trial - 1) / methods.length) % delays.length] as number;
				const label = `trial ${boot}.${trial} ${method} delay=${delay}s`;
				if (trial > 1) {
					capture.mark(`${label}: reset`);
					await command(client, "/cmr/client/set enabled=no");
					await command(client, "/cmr/client/forget");
					await command(client, "/cmr/client/set !pairing-requirement");
					await attempt(controller, `/cmr/device/remove [find identity=${quote(identity)}]`);
					await command(controller, "/cmr/set enabled=no");
				}
				await command(client, `/cmr/client/set controller-addresses=${method === "address" ? "192.0.2.1" : '""'}`);
				capture.mark(`${label}: controller enable`);
				await command(controller, "/cmr/set enabled=yes");
				if (delay) await Bun.sleep(delay * 1000);
				// What a discovering client can know: its neighbor row and the last announcement heard.
				const neighbor = (await read(client, "/ip/neighbor")).find(r => r.identity === controllerIdentity);
				const clientEnabled = capture.now();
				const announcement = capture.lastMndp(controllerIdentity, clientEnabled);
				capture.mark(`${label}: client enable`);
				await command(client, "/cmr/client/set enabled=yes");
				// Only the deadline is a result ("timeout"); a REST failure or Ctrl-C must fail the study.
				const pending = await waitPending(controller, client, identity, 240_000).catch((error: unknown) => {
					if (error instanceof Error && error.message.startsWith("Timed out")) return undefined;
					throw error;
				});
				const pendingAt = capture.now();
				const connect = capture.cmrBetween(clientEnabled, pendingAt);
				const syns = connect.filter(s => s.packet.flags === "S");
				const established = connect.find(s => s.packet.flags === "SA");
				const row: Row = {
					boot: String(boot), trial: String(trial), method, delaySeconds: String(delay), freshBoot: String(trial === 1),
					neighborRunning: neighbor ? (neighbor.running ?? "") : "no neighbor row",
					mndpRunning: announcement?.packet.mndp?.fields.running ?? "none heard",
					mndpAgeMs: announcement ? String(clientEnabled - announcement.t) : "",
					firstSynMs: syns[0] ? String(syns[0].t - clientEnabled) : "none",
					// The fresh-boot 85 s first connect was a SYN sourced from ether1's 10.0.2.15.
					firstSynFrom: syns[0]?.packet.src ?? "",
					syns: String(syns.length),
					resets: String(connect.filter(s => s.packet.flags?.includes("R")).length),
					establishedMs: established ? String(established.t - clientEnabled) : "none",
					pendingMs: pending ? String(pendingAt - clientEnabled) : "timeout",
				};
				let result: Awaited<ReturnType<typeof pairWith>> | undefined;
				if (pending) {
					const pairStart = capture.now();
					result = await pairWith(controller, client, identity, "credentialed");
					const pairDone = capture.now();
					// The pairing messages, "<" from the controller and ">" from the client, payload bytes,
					// from the start of the pair command until pairWith() settled (paired, or 10 s). On
					// 7.26beta5 the client's reply to the third controller message matched the outcome:
					// one 108 B segment half-paired, 71 B + 66 B paired (FINDINGS.md → Wire).
					const exchange = capture.cmrBetween(pairStart, pairDone).filter(s => s.packet.length > 0)
						.map(s => `${s.packet.srcPort === CMR_PORT ? "<" : ">"}${s.packet.length}`).join(" ");
					await Bun.sleep(25_000);
					const after = capture.cmrBetween(pairDone).filter(s => s.packet.srcPort === CMR_PORT && s.packet.length > 0);
					Object.assign(row, {
						pairStatus: result.pairStatus,
						exchange,
						exchangeWindowMs: String(pairDone - pairStart),
						verdict: (await observe(controller, client, identity)).verdict,
						controllerSegmentsAfterPair: String(after.length),
						controllerBytesAfterPair: String(after.reduce((sum, s) => sum + s.packet.length, 0)),
					});
				}
				results.push(row);
				detail.push({ boot, trial, method, delay, connect: connect.map(s => [s.t - clientEnabled, s.packet.srcPort === CMR_PORT ? "<" : ">", s.packet.flags, s.packet.length]), pending, result });
				console.log(`  ${label}: first SYN ${row.firstSynMs} ms, pending ${row.pendingMs} ms, pair→${row.pairStatus ?? "-"}, ${row.verdict ?? "-"}, controller sent ${row.controllerBytesAfterPair ?? "-"} B after pair`);
			}
			// Unfiltered neighbor rows, to tie MNDP TLVs to the fields RouterOS shows for them.
			detail.push({ boot, neighbors: { controller: await read(controller, "/ip/neighbor"), client: await read(client, "/ip/neighbor") } });
		}, false);
	}
}

/**
 * Q: what fixes a half-paired client, and does the fix hold? Each trial pairs a fresh client with
 * the credentialed `pair` until it half-pairs (up to 6 tries), then applies one action: nothing
 * (`bare-pair`), a controller CMR restart, a client reboot or a controller reboot. It records what
 * the action left, finishes with one bare `pair` if the client is still not paired, and then runs
 * the commit test (a controller CMR restart) on the result.
 */
const REPAIR_ACTIONS = ["bare-pair", "cmr-restart", "client-reboot", "controller-reboot"] as const;
async function repair(context: StudyContext): Promise<void> {
	const boots = count(context, "boots", 2);
	const trials = count(context, "trials", 8);
	const results: Row[] = [];
	const detail: unknown[] = [];
	context.evidence.question = "Does a reboot or a CMR restart fix a half-paired client, and does a bare-pair repair survive a controller CMR restart?";
	context.evidence.parameters = { boots, trials, actions: REPAIR_ACTIONS, halfPairBy: "credentialed", maxTries: 6 };
	context.evidence.trials = results;
	context.evidence.detail = detail;
	for (let boot = 1; boot <= boots; boot++) {
		await withPairLab(context, async ({ controller, client }) => {
			const identity = await identityOf(client);
			await waitPending(controller, client, identity);
			for (let trial = 1; trial <= trials; trial++) {
				const action = REPAIR_ACTIONS[(trial - 1) % REPAIR_ACTIONS.length] as (typeof REPAIR_ACTIONS)[number];
				let tries = 0;
				let result: Awaited<ReturnType<typeof pairWith>> | undefined;
				while (tries < 6 && result?.settled.verdict !== "half-paired") {
					if (trial > 1 || tries > 0) {
						await resetPairing(controller, client, identity);
						await waitPending(controller, client, identity);
					}
					result = await pairWith(controller, client, identity, "credentialed");
					tries++;
				}
				const row: Row = { boot: String(boot), trial: String(trial), action, tries: String(tries) };
				if (result?.settled.verdict !== "half-paired") {
					row.reached = "no";
					results.push(row);
					console.log(`  boot ${boot} trial ${trial} ${action}: no half-pair in ${tries} tries`);
					continue;
				}
				const settle = async (description: string, wait: () => Promise<Observation>): Promise<Observation & { timedOut?: boolean }> => {
					try { return await wait(); } catch (error) {
						// Only a stability deadline (`until`) is an observation; a failed command or REST call fails the study.
						if (!(error instanceof Error && error.message.startsWith("Timed out:"))) throw error;
						console.log(`  ${description}: ${error.message}`);
						return { ...(await observe(controller, client, identity)), timedOut: true };
					}
				};
				let afterAction: (Observation & { timedOut?: boolean }) | undefined;
				const started = Date.now();
				if (action === "cmr-restart") afterAction = await settle("after CMR restart", () => restartController(controller, client, identity));
				if (action === "client-reboot" || action === "controller-reboot") {
					row.rebootSeconds = String(await rebootRouter(action === "client-reboot" ? client : controller));
					afterAction = await settle("after reboot", () => waitStable(controller, client, identity));
				}
				if (afterAction) {
					row.actionSeconds = String(Math.round((Date.now() - started) / 1000));
					row.afterAction = `${afterAction.verdict}${afterAction.timedOut ? " (not stable)" : ""}`;
					row.afterActionState = afterAction.row?.state ?? "";
					row.afterActionClient = afterAction.clientStatus ?? "";
					row.afterActionSelectable = String((await selectable(controller, identity)).selected);
				}
				if (afterAction?.verdict !== "paired") {
					const output = await attempt(controller, `/cmr/device/pair [find identity=${quote(identity)}]`);
					row.repairStatus = output.replaceAll("\r", "").trim().split("\n").at(-1)?.trim() ?? "";
					await until("repair settles", async () => (await observe(controller, client, identity)).verdict === "paired", 20_000).catch(() => undefined);
				}
				const afterRepair = await observe(controller, client, identity);
				row.afterRepair = afterRepair.verdict;
				row.afterRepairSelectable = String((await selectable(controller, identity)).selected);
				const commit = await settle("commit test", () => restartController(controller, client, identity));
				row.afterCommitTest = `${commit.verdict}${commit.timedOut ? " (not stable)" : ""}`;
				row.afterCommitTestState = commit.row?.state ?? "";
				results.push(row);
				detail.push({ boot, trial, action, result, afterAction, afterRepair, commit });
				console.log(`  boot ${boot} trial ${trial} ${action.padEnd(17)} tries=${tries} after action=${row.afterAction ?? "-"} ${row.afterActionState ?? ""} | bare pair=${row.repairStatus ?? "-"} → ${row.afterRepair} | after commit test=${row.afterCommitTest} ${row.afterCommitTestState}`);
			}
		});
	}
	const summary: Record<string, Record<string, number>> = {};
	for (const r of results.filter(r => r.reached !== "no")) {
		summary[r.action as string] ??= {};
		const bucket = summary[r.action as string] as Record<string, number>;
		for (const key of [`after action: ${r.afterAction ?? "(none)"}`, `after commit test: ${r.afterCommitTest}`]) bucket[key] = (bucket[key] ?? 0) + 1;
	}
	context.evidence.summary = summary;
	console.log(JSON.stringify(summary, null, 2));
}

/**
 * Q: do the three CMR lines in the 7.26beta7 changelog hold, and what did the same steps do
 * before? ("add VRF support for the CMR client"; "do not fail an upgrade when the device is
 * already on the requested version"; "fix import failing with duplicate device ids after
 * exporting CMR settings".) Runs on any build, so an older one is the baseline.
 *
 * 1. VRF: move the client's link (ether2) into a VRF. Without `vrf=` the client can only reach
 *    the controller through `main`, where the lab resets tcp/54321 on ether1. Then set
 *    `/cmr/client vrf=` and see whether it reconnects, still paired. Then undo both.
 * 2. Upgrade to the running version: `/cmr/device/upgrade` with `channel=<running version>`.
 * 3. Export, then import on the same controller: as-is, after removing the client's row, and
 *    after removing every row; the last two ask whether an import restores a pairing.
 */
async function beta7(context: StudyContext): Promise<void> {
	context.evidence.question = "Do the 7.26beta7 CMR changelog lines (client VRF, upgrade to the running version, import after export) hold?";
	await withPairLab(context, async ({ controller, client }) => {
		await pairClient(controller, client);
		const identity = await identityOf(client);
		const find = `[find identity=${quote(identity)}]`;
		const results: Record<string, unknown> = {};
		context.evidence.checks = results;
		const settle = async (description: string, predicate: (o: Observation) => boolean, timeout = 90_000) => {
			const started = Date.now();
			let last = await observe(controller, client, identity);
			const reached = await until(description, async () => {
				last = await observe(controller, client, identity);
				return predicate(last);
			}, timeout).then(() => true, (error: unknown) => {
				// Only the deadline is a result; a failed REST read or Ctrl-C must fail the study.
				if (error instanceof Error && error.message.startsWith("Timed out:")) return false;
				throw error;
			});
			return { reached, seconds: Math.round((Date.now() - started) / 1000), ...last };
		};
		const connected = (o: Observation) => o.clientStatus?.endsWith(",connected") === true;

		// 1. VRF.
		results.clientBefore = (await read(client, "/cmr/client"))[0];
		results.vrfMainSet = (await attempt(client, "/cmr/client/set vrf=main")).trim();
		await command(client, "/ip/vrf/add name=cmr-vrf interfaces=ether2");
		results.inVrfWithoutSetting = await settle("client drops after its link moves into a VRF", o => !connected(o), 60_000);
		await Bun.sleep(30_000); // Long enough for retries; it must still be down.
		results.inVrfWithoutSetting30s = await observe(controller, client, identity);
		results.vrfSet = (await attempt(client, "/cmr/client/set vrf=cmr-vrf")).trim();
		results.clientWithVrf = (await read(client, "/cmr/client"))[0];
		results.inVrfWithSetting = await settle("client reconnects through its VRF", o => o.verdict === "paired", 120_000);
		results.inVrfSelectable = (await selectable(controller, identity)).selected;
		results.controllerRowInVrf = (await read(controller, "/cmr/device")).find(r => r.identity === identity);
		await attempt(client, "/cmr/client/set vrf=main");
		await command(client, "/ip/vrf/remove [find name=cmr-vrf]");
		results.backInMain = await settle("client back in main, paired", o => o.verdict === "paired", 120_000);

		// 2. Upgrade to the version the client already runs. The client must not reboot.
		const uptime = async () => (await read(client, "/system/resource"))[0]?.uptime;
		const uptimeBefore = await uptime();
		let upgradeOutput: string;
		try {
			upgradeOutput = (await controller.exec(`/cmr/device/upgrade ${find} channel=${context.version}`, { timeout: 120_000 })).output;
		} catch (error) { upgradeOutput = `error: ${error instanceof Error ? error.message : String(error)}`; }
		results.sameVersionUpgrade = upgradeOutput.replaceAll("\r", "").trim();
		await Bun.sleep(30_000);
		results.upgradeJobs = await read(controller, "/cmr/upgrade/job");
		results.deviceAfterUpgrade = (await read(controller, "/cmr/device")).find(r => r.identity === identity);
		results.clientVersionAfterUpgrade = (await read(client, "/system/resource"))[0]?.version;
		results.clientUptime = { before: uptimeBefore, after: await uptime() };
		results.afterUpgrade = await observe(controller, client, identity);

		// 3. Export, then import on the same controller.
		await command(controller, `/cmr/device/set ${find} labels=lab,import`);
		await command(controller, "/cmr/export file=cmr-lab-export");
		await until("export file", async () => (await read(controller, "/file")).some(r => r.name === "cmr-lab-export.rsc"), 20_000);
		results.export = (await command(controller, "/cmr/export")).replaceAll("\r", "");
		const rowsOf = async () => (await read(controller, "/cmr/device")).map(r => ({ identity: r.identity, ids: r.ids, labels: r.labels, "pairing-requirement": r["pairing-requirement"], connected: r.connected, state: r.state }));
		results.rowsBeforeImport = await rowsOf();
		results.importAsIs = (await attempt(controller, "/import file-name=cmr-lab-export.rsc")).replaceAll("\r", "").trim();
		results.rowsAfterImportAsIs = await rowsOf();
		results.afterImportAsIs = await observe(controller, client, identity);
		await command(controller, `/cmr/device/remove ${find}`);
		results.afterRemove = await settle("client row gone or pending again", o => o.verdict !== "paired", 60_000);
		results.importAfterRemove = (await attempt(controller, "/import file-name=cmr-lab-export.rsc")).replaceAll("\r", "").trim();
		results.rowsAfterImportAfterRemove = await rowsOf();
		results.afterImportAfterRemove = await settle("client paired from the imported row", o => o.verdict === "paired", 60_000);
		// The export's first `add` is the controller's own row, which always exists on the
		// controller; an import aborts at the first failing line. Remove every row, then import.
		results.removeAll = (await attempt(controller, "/cmr/device/remove [find]")).replaceAll("\r", "").trim();
		results.rowsAfterRemoveAll = await rowsOf();
		results.importAfterRemoveAll = (await attempt(controller, "/import file-name=cmr-lab-export.rsc")).replaceAll("\r", "").trim();
		results.rowsAfterImportAfterRemoveAll = await rowsOf();
		results.afterImportAfterRemoveAll = await settle("client paired from the imported row", o => o.verdict === "paired", 120_000);
		results.selectableAfterImport = (await selectable(controller, identity)).selected;

		for (const [key, value] of Object.entries(results)) {
			const text = typeof value === "object" && value !== null ? JSON.stringify("verdict" in value ? { verdict: (value as Observation).verdict, client: (value as Observation).clientStatus, state: (value as Observation).row?.state } : value) : String(value);
			console.log(`  ${key}: ${text.replaceAll("\n", " ⏎ ").slice(0, 300)}`);
		}
	});
}

/**
 * POST JSON over `node:http` with `agent: false`, so each request gets a fresh connection. Bun's
 * `fetch()` pools sockets per host and port, and the controller restarts between requests. This is
 * what quickchr's internal `restPost()` does; the examples import only the public entry point.
 */
function postNoPool(url: string, authorization: string, body: Record<string, unknown>, timeoutMs: number): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const payload = Buffer.from(JSON.stringify(body));
		const req = request(url, {
			method: "POST",
			agent: false,
			headers: { authorization, "content-type": "application/json", "content-length": payload.length },
			timeout: timeoutMs,
		}, response => {
			const chunks: Buffer[] = [];
			response.on("data", (chunk: Buffer) => chunks.push(chunk));
			response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
			response.on("error", reject);
		});
		req.on("timeout", () => req.destroy(new Error(`POST timed out after ${timeoutMs} ms`)));
		req.on("error", reject);
		req.end(payload);
	});
}

/**
 * Type one line on the serial console the way a person would, with nothing typed ahead, and
 * return what the terminal showed until the prompt came back. `chr.exec(…, { via: "console" })`
 * sends an end-of-reply sentinel line right behind the command; an interactive view such as
 * `/cmr/device/pair` (`-- [Q quit|D dump|C-z pause]`) reads that sentinel as keys, and its `Q`
 * quits the view. Logs in through `exec` first: the serial session stays logged in. Unix only.
 */
async function typed(chr: ChrInstance, line: string, timeout = 120_000): Promise<{ output: string; timedOut: boolean }> {
	await chr.exec(":put ready", { via: "console", timeout: 30_000 });
	const socket = connect({ path: join(chr.state.machineDir, "serial.sock") });
	let buffer = "";
	let lastData = Date.now();
	socket.on("data", (data: Buffer) => { buffer += data.toString(); lastData = Date.now(); });
	try {
		await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
		// The prompt has returned when "] > " follows the echoed line and the terminal has been quiet for 2 s.
		const settled = async (from: number, ms: number) => {
			const deadline = Date.now() + ms;
			while (Date.now() < deadline) {
				const echoEnd = buffer.indexOf("\n", from);
				if (echoEnd >= 0 && buffer.indexOf("] > ", echoEnd) >= 0 && Date.now() - lastData > 2000) return true;
				await Bun.sleep(200);
			}
			return false;
		};
		socket.write("\r");
		await settled(0, 15_000);
		const start = buffer.length;
		socket.write(`${line}\r`);
		const done = await settled(start, timeout);
		if (!done) {
			socket.write("q");
			await settled(start, 15_000);
		}
		// The first line is the terminal's echo of the typed line, redrawn as it wraps, so it can
		// hold fragments of any password in it. Keep only what the command printed after it.
		const text = stripAnsi(buffer.slice(start)).replaceAll("\r", "");
		const firstNewline = text.indexOf("\n");
		return { output: firstNewline >= 0 ? text.slice(firstNewline + 1) : "", timedOut: !done };
	} finally {
		socket.destroy();
	}
}

/**
 * Q (control): is the half-pair an artifact of the lab's harness? Every other study sends `pair`
 * over REST `/rest/execute` (a non-interactive script) and reads state over REST, both through the
 * user-mode (SLiRP) `ether1`. Here, for each trial, `ether1` is disabled on both routers (`--down`
 * rotates `both`, `controller`, `client`, `none`; default `both`), the
 * credentialed `pair` is typed on the controller's serial console (the interactive CLI, `typed()`), and the
 * outcome and the commit test (a controller CMR restart) are read on the serial console too.
 * `ether1` comes back only after that, to reset the next trial over REST.
 */
const DOWN = ["both", "controller", "client", "none"] as const;
type Down = (typeof DOWN)[number];
async function isolated(context: StudyContext): Promise<void> {
	const boots = count(context, "boots", 1);
	const trials = count(context, "trials", 6);
	const downs = (operand(context.argv, "down")?.split(",") ?? ["both"]) as Down[];
	for (const d of downs) check(DOWN.includes(d), `Unknown --down ${d}; known: ${DOWN.join(", ")}`);
	const results: Row[] = [];
	const detail: unknown[] = [];
	context.evidence.question = "Does the single credentialed pair, typed on the serial console, still half-pair when ether1 (the user-mode management NIC) is down on both routers, one, or neither?";
	context.evidence.parameters = { boots, trials, transport: "console", ether1Down: downs };
	context.evidence.trials = results;
	context.evidence.detail = detail;
	const con = async (chr: ChrInstance, line: string, timeout = 60_000) => (await chr.exec(line, { via: "console", timeout })).output.replaceAll("\r", "");
	for (let boot = 1; boot <= boots; boot++) {
		await withPairLab(context, async ({ controller, client }) => {
			const identity = await identityOf(client);
			const login = await loginOf(client);
			const find = `[find identity=${quote(identity)}]`;
			await waitPending(controller, client, identity);
			for (let trial = 1; trial <= trials; trial++) {
				if (trial > 1) {
					await resetPairing(controller, client, identity);
					await waitPending(controller, client, identity);
				}
				const down = downs[(trial - 1) % downs.length] as Down;
				const isolatedRouters = down === "both" ? [controller, client] : down === "controller" ? [controller] : down === "client" ? [client] : [];
				for (const chr of isolatedRouters) await con(chr, "/interface/disable ether1");
				const rowText = async () => con(controller, `/cmr/device/print detail without-paging where identity=${quote(identity)}`);
				const pair = await typed(controller, `/cmr/device/pair ${find} username=${quote(login.user)} password=${quote(login.password)}`);
				const pairOutput = pair.output;
				await Bun.sleep(10_000);
				const rowAfterPair = await rowText();
				const clientAfterPair = await con(client, ":put [/cmr/client/get status]");
				const nonce = `iso-${crypto.randomUUID().slice(0, 6)}`;
				const runScript = (await typed(controller, `/cmr/device/run-script ${find} script=":put ${nonce}"`, 60_000)).output;
				await con(controller, "/cmr/set enabled=no");
				await con(controller, "/cmr/set enabled=yes");
				let clientAfterRestart = "";
				const deadline = Date.now() + 120_000;
				while (Date.now() < deadline) {
					await Bun.sleep(5000);
					clientAfterRestart = (await con(client, ":put [/cmr/client/get status]")).trim();
					if (clientAfterRestart.endsWith(",connected")) break;
				}
				await Bun.sleep(5000);
				const rowAfterRestart = await rowText();
				for (const chr of isolatedRouters) await con(chr, "/interface/enable ether1");
				await until("REST back on both routers", async () => {
					try { await read(controller, "/system/identity"); await read(client, "/system/identity"); return true; } catch { return false; }
				}, 120_000);
				const afterRestart = await observe(controller, client, identity);
				const row: Row = {
					boot: String(boot), trial: String(trial), ether1Down: down,
					pairStatus: pair.timedOut ? "timed out" : lastPairStatus(pairOutput.split("\n").filter(l => !l.includes("] > ")).join("\n")),
					halfPairedAfterPair: String(/device:ok, cmr:ok/.test(rowAfterPair)),
					clientAfterPair: clientAfterPair.trim(),
					selectable: String(new RegExp(`success\\s+${nonce}`).test(runScript)),
					clientAfterRestart,
					afterRestart: afterRestart.verdict,
					afterRestartState: afterRestart.row?.state ?? "",
				};
				if (afterRestart.verdict !== "paired") {
					await attempt(controller, `/cmr/device/pair ${find}`);
					await until("repair settles", async () => (await observe(controller, client, identity)).verdict === "paired", 30_000).catch(() => undefined);
					row.repaired = (await observe(controller, client, identity)).verdict;
				}
				results.push(row);
				detail.push({ boot, trial, pairOutput: pairOutput.replaceAll(login.password, "…"), pairTimedOut: pair.timedOut, rowAfterPair, runScript, rowAfterRestart });
				console.log(`  boot ${boot} trial ${trial} down=${down.padEnd(10)} pair→${(row.pairStatus ?? "").padEnd(18)} half-paired=${(row.halfPairedAfterPair ?? "").padEnd(5)} run-script=${(row.selectable ?? "").padEnd(5)} after restart=${row.afterRestart} ${row.afterRestartState}${row.repaired ? `, bare pair → ${row.repaired}` : ""}`);
			}
		});
	}
}

/**
 * Q (control): does the way the controller's `pair` is invoked change the half-pair? Every trial
 * runs the single credentialed `pair` from a fresh pending client, rotating the invocation:
 * - `execute`: REST `/rest/execute` with the CLI line as a script (what the lab and quickchr use);
 * - `rest`: REST `POST /rest/cmr/device/pair` with JSON arguments (a direct HTTP call on a fresh connection; 120 s timeout);
 * - `console`: typed on the controller's serial console (the interactive CLI), nothing typed ahead (`typed()`);
 * - `execute-30s`, `rest-30s`: the first two with `duration=30s`, so the command's progress view
 *   stays open 30 s instead of returning after its first refresh.
 * `--transports` picks and orders them (default: all five, rotating).
 * Then the usual checks: settled verdict, run-script selection, the commit test.
 */
const TRANSPORTS = ["execute", "rest", "console", "execute-30s", "rest-30s"] as const;
type Transport = (typeof TRANSPORTS)[number];
async function transport(context: StudyContext): Promise<void> {
	const boots = count(context, "boots", 2);
	const trials = count(context, "trials", 10);
	const transports = (operand(context.argv, "transports")?.split(",") ?? [...TRANSPORTS]) as Transport[];
	for (const t of transports) check(TRANSPORTS.includes(t), `Unknown transport ${t}; known: ${TRANSPORTS.join(", ")}`);
	const results: Row[] = [];
	const detail: unknown[] = [];
	context.evidence.question = "Does invoking the credentialed pair via /rest/execute, a direct REST command, or the serial console, with or without duration=30s, change the half-pair?";
	context.evidence.parameters = { boots, trials, transports };
	context.evidence.trials = results;
	context.evidence.detail = detail;
	for (let boot = 1; boot <= boots; boot++) {
		await withPairLab(context, async ({ controller, client }) => {
			const identity = await identityOf(client);
			const login = await loginOf(client);
			const endpoint = (await controller.descriptor()).services["rest-api"];
			check(endpoint.available && endpoint.auth?.password !== undefined, "Controller REST login missing");
			// The descriptor's rest-api url already ends in /rest.
			const base = endpoint.url ?? `http://${endpoint.host}:${endpoint.port}/rest`;
			const authorization = `Basic ${btoa(`${endpoint.auth.username}:${endpoint.auth.password}`)}`;
			await waitPending(controller, client, identity);
			for (let trial = 1; trial <= trials; trial++) {
				const via = transports[(trial - 1) % transports.length] as Transport;
				if (trial > 1) {
					await resetPairing(controller, client, identity);
					await waitPending(controller, client, identity);
				}
				const id = (await read(controller, "/cmr/device")).find(r => r.identity === identity)?.[".id"];
				check(id, `${identity}: no row to pair`);
				const duration = via.endsWith("-30s") ? " duration=30s" : "";
				const line = `/cmr/device/pair [find identity=${quote(identity)}] username=${quote(login.user)} password=${quote(login.password)}${duration}`;
				let output: string;
				const started = Date.now();
				try {
					if (via.startsWith("execute")) output = (await controller.exec(line, { via: "rest", timeout: 120_000 })).output;
					else if (via === "console") {
						const result = await typed(controller, line);
						output = `${result.output.split("\n").filter(l => !l.includes("] > ")).join("\n")}${result.timedOut ? "\ntimed out" : ""}`;
					}
					else {
						const response = await postNoPool(`${base}/cmr/device/pair`, authorization, { numbers: id, username: login.user, password: login.password, ...(duration ? { duration: "30s" } : {}) }, 120_000);
						output = `HTTP ${response.status} ${response.body}`;
					}
				} catch (error) { output = `error: ${error instanceof Error ? error.message : String(error)}`; }
				const commandMs = Date.now() - started;
				let settled = await observe(controller, client, identity);
				const settleStart = Date.now();
				while (settled.verdict !== "paired" && Date.now() - settleStart < 10_000) {
					await Bun.sleep(1000);
					settled = await observe(controller, client, identity);
				}
				const selection = await selectable(controller, identity);
				const afterRestart = await restartController(controller, client, identity);
				const row: Row = {
					boot: String(boot), trial: String(trial), via,
					commandMs: String(commandMs),
					output: output.replaceAll("\r", "").trim().split("\n").filter(Boolean).at(-1)?.trim() ?? "",
					settled: settled.verdict,
					selectable: String(selection.selected),
					afterRestart: afterRestart.verdict,
					afterRestartState: afterRestart.row?.state ?? "",
				};
				if (afterRestart.verdict !== "paired") {
					await attempt(controller, `/cmr/device/pair [find identity=${quote(identity)}]`);
					await until("repair settles", async () => (await observe(controller, client, identity)).verdict === "paired", 30_000).catch(() => undefined);
					row.repaired = (await observe(controller, client, identity)).verdict;
				}
				results.push(row);
				detail.push({ boot, trial, via, output: output.replaceAll(login.password, "…"), settled, selection, afterRestart });
				console.log(`  boot ${boot} trial ${trial} ${via.padEnd(11)} ${String(commandMs).padStart(6)} ms  last="${row.output}"  settled=${row.settled} run-script=${row.selectable} after restart=${row.afterRestart}`);
			}
		});
	}
	const summary: Record<string, Record<string, number>> = {};
	for (const r of results) {
		summary[r.via as string] ??= {};
		const bucket = summary[r.via as string] as Record<string, number>;
		const outcome = r.afterRestart === "paired" && r.selectable === "true" ? "committed" : r.settled as string;
		bucket[outcome] = (bucket[outcome] ?? 0) + 1;
	}
	context.evidence.summary = summary;
	console.table(summary);
}

export const STUDIES: Record<string, (context: StudyContext) => Promise<void>> = { pairing, policy, recheck, wire, repair, beta7, isolated, transport };
