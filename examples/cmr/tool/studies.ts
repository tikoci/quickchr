/**
 * Grounding studies: bounded experiments that each answer one CMR question on a fresh lab and
 * record raw RouterOS output. They do not assert expectations (a beta may change any of them);
 * they fail only when the lab itself breaks. FINDINGS.md is where the answers are kept, per build.
 *
 *   bun run cmr.ts --study pairing [--boots 3] [--trials 8] [--strategies credentialed,confirm-first]
 *   bun run cmr.ts --study policy
 *   bun run cmr.ts --study recheck
 *
 * Add a study: write `async function <name>(context)` below, register it in STUDIES, and add
 * its question and result rows to FINDINGS.md.
 */
import type { ChrInstance } from "../../../src/index.ts";
import { check } from "../../lib.ts";
import { attempt, command, createPairLab, identityOf, operand, quote, read, removeByPrefix, until, type PairLab, type Row } from "./lab.ts";
import { observe, pairClient, pairWith, resetPairing, restartController, selectable, strategyNames, waitPending, type Strategy } from "./pairing.ts";

export interface StudyContext {
	version: string;
	/** Machine-name prefix the runner tears down by; each lab adds a suffix. */
	prefix: string;
	argv: string[];
	track: <T extends ChrInstance>(instance: T) => T;
	evidence: Record<string, unknown>;
}


/** Boot a pair lab, run `body`, and remove the lab whatever happens. */
let labCount = 0;
async function withPairLab<T>(context: StudyContext, body: (lab: PairLab) => Promise<T>): Promise<T> {
	const prefix = `${context.prefix}-${++labCount}`;
	try {
		const lab = await createPairLab(context.track, { version: context.version, prefix });
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
	const count = (name: string, fallback: number) => {
		const value = Number(operand(context.argv, name) ?? fallback);
		check(Number.isInteger(value) && value >= 1 && value <= 100, `--${name} must be an integer from 1 to 100`);
		return value;
	};
	const boots = count("boots", 2);
	const trials = count("trials", 8);
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
		await until("bridge rule covers the client", async () => Number((await read(controller, "/cmr/alert")).find(r => r.name === "first-bridge")?.devices ?? 0) > 0, 30_000).catch(() => undefined);
		await Bun.sleep(30_000);
		const ruleBefore = (await read(controller, "/cmr/alert")).find(r => r.name === "first-bridge");
		results.firstBridgeRuleBefore = ruleBefore;
		results.ruleCovered = Number(ruleBefore?.devices ?? 0) > 0;
		await command(client, "/interface/bridge/add name=first-probe");
		const fired = async () => Number((await read(controller, "/cmr/alert")).find(r => r.name === "first-bridge")?.fired ?? 0);
		const firstBridgeObserved = await until("first bridge alert", async () => await fired() > 0, 60_000).then(() => true, () => false);
		results.firstBridgeFired = results.ruleCovered ? firstBridgeObserved : null;
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
			if (typeof value !== "object") console.log(`  ${key}: ${String(value).replaceAll("\r", "").trim().split("\n").at(-1)}`);
		}
	});
}

export const STUDIES: Record<string, (context: StudyContext) => Promise<void>> = { pairing, policy, recheck };
