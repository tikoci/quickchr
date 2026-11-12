/**
 * CMR pairing, as measured. This module is the reference for anything that pairs a lab client
 * (quickchr's example, centrs' integration lab): which command sequences exist, how to tell
 * "paired" from the half-paired state, and how to prove a pairing was committed.
 *
 * Vocabulary (FINDINGS.md → Pairing):
 * - The client and the controller each have a `pairing-requirement` (none | password | confirm).
 *   7.26beta5 defaults: client `password`, controller per-device `confirm`.
 * - A row in `/cmr/device` is **paired** when `state` is empty and it is not pending. Only then
 *   does `run-script` select it.
 * - **half-paired**: the client says `paired,connected` but the row keeps
 *   `state="pair: device:ok, cmr:ok"`. `run-script` answers `no devices selected`.
 * - **committed**: the pairing survives a controller `/cmr` restart. A half-paired row comes back
 *   pending (`pair: device:ok, cmr:waiting confirmation`) after one.
 */
import type { ChrInstance } from "../../../src/index.ts";
import { check } from "../../lib.ts";
import { attempt, command, identityOf, loginOf, quote, read, until, type Row } from "./lab.ts";

export const HALF_PAIRED = "pair: device:ok, cmr:ok";

/**
 * Ways to pair one client from a fresh state. Each maps to a manual paragraph
 * (https://manual.mikrotik.com/docs/management-tools/cmr/ → Pairing).
 */
export const STRATEGIES = {
	/** The manual's single command for "server confirm, client password": the controller presents the client's login. */
	credentialed: "controller: /cmr/device/pair [find] username=<client user> password=<…>",
	/** Commit the controller's own approval first, then satisfy the client's password requirement. */
	"confirm-first": "controller: /cmr/device/pair [find], then the credentialed pair",
	/** Approve the client side locally (pair always approves its own side), then confirm on the controller. */
	"client-local": "client: /cmr/client/pair, then controller: /cmr/device/pair [find]",
	/** Client requirement `none`, then confirm on the controller. */
	"client-none": "client: pairing-requirement=none, then controller: /cmr/device/pair [find]",
} as const;
export type Strategy = keyof typeof STRATEGIES;
export const strategyNames = Object.keys(STRATEGIES) as Strategy[];

export type Verdict = "paired" | "half-paired" | "pending" | "absent" | "other";

export interface Observation {
	clientStatus?: string;
	pairingStatus?: string;
	row?: Row;
	verdict: Verdict;
}

const ROW_FIELDS = [".id", "identity", "connected", "pending", "remote-pending", "state", "pairing-requirement", "upgrade-rule", "channel"];

/** One read of both sides, reduced to the pairing-relevant fields. */
export async function observe(controller: ChrInstance, client: ChrInstance, identity?: string): Promise<Observation> {
	const name = identity ?? await identityOf(client);
	const clientRow = (await read(client, "/cmr/client"))[0] ?? {};
	const rows = (await read(controller, "/cmr/device")).filter(r => r.identity === name);
	// Several rows can exist briefly after a reconnect; the connected one is the live session.
	const full = rows.find(r => r.connected === "true") ?? rows[0];
	const row = full ? Object.fromEntries(ROW_FIELDS.filter(k => full[k] !== undefined).map(k => [k, full[k] as string])) : undefined;
	return { clientStatus: clientRow.status, pairingStatus: clientRow["pairing-status"], row, verdict: verdict(clientRow.status, row) };
}

export function verdict(clientStatus: string | undefined, row: Row | undefined): Verdict {
	if (!row) return "absent";
	if (row.state === HALF_PAIRED) return "half-paired";
	if (row.pending === "true" || row["remote-pending"] === "true" || row.state?.startsWith("pair:")) return "pending";
	if (clientStatus === "paired,connected" && row.connected === "true" && !row.state) return "paired";
	return "other";
}

/** Whether the controller's `run-script` selects the client: the property centrs depends on. */
export async function selectable(controller: ChrInstance, identity: string): Promise<{ selected: boolean; output: string }> {
	const nonce = `select-${crypto.randomUUID().slice(0, 6)}`;
	const output = await attempt(controller, `/cmr/device/run-script [find identity=${quote(identity)}] script=":put ${nonce}"`);
	return { selected: new RegExp(`success\\s+${nonce}`).test(output), output: output.replaceAll("\r", "").trim() };
}

/** The final STATUS cell the `pair` command printed (its last progress table). */
export function lastPairStatus(output: string): string {
	const lines = output.replaceAll("\r", "").split("\n").map(l => l.trim()).filter(Boolean);
	const last = lines.at(-1) ?? "";
	return last.replace(/^\S+\s+/, "");
}

/** Return the client to a fresh, unpaired state that the controller has never seen. */
export async function resetPairing(controller: ChrInstance, client: ChrInstance, identity: string): Promise<void> {
	await command(client, "/cmr/client/set enabled=no");
	await command(client, "/cmr/client/forget");
	await command(client, "/cmr/client/set !pairing-requirement");
	await command(controller, `/cmr/device/remove [find identity=${quote(identity)}]`);
	await command(client, "/cmr/client/set enabled=yes");
}

/**
 * Wait until the controller lists the client as a pending device. On a fresh boot this can take
 * well over a minute (FINDINGS.md → first-connect latency), so the timeout is generous.
 */
export async function waitPending(controller: ChrInstance, client: ChrInstance, identity: string, timeout = 180_000): Promise<Observation> {
	let last: Observation | undefined;
	await until(`${identity} pending on the controller`, async () => {
		last = await observe(controller, client, identity);
		return last.verdict === "pending" && last.row?.connected === "true";
	}, timeout);
	return last as Observation;
}

export interface PairResult {
	strategy: Strategy;
	/** RouterOS output of each command, in order. */
	outputs: { on: "controller" | "client"; command: string; output: string }[];
	/** Final STATUS of the last controller `pair` command. */
	pairStatus: string;
	/** State after up to `settleMs`. */
	settled: Observation;
	settleMs: number;
}

/** Run one strategy from a pending state. No repair: this records what RouterOS did. */
export async function pairWith(controller: ChrInstance, client: ChrInstance, identity: string, strategy: Strategy, settleMs = 10_000): Promise<PairResult> {
	const login = await loginOf(client);
	const credentialed = `/cmr/device/pair [find identity=${quote(identity)}] username=${quote(login.user)} password=${quote(login.password)}`;
	const bare = `/cmr/device/pair [find identity=${quote(identity)}]`;
	const steps: [ChrInstance, "controller" | "client", string][] =
		strategy === "credentialed" ? [[controller, "controller", credentialed]]
		: strategy === "confirm-first" ? [[controller, "controller", bare], [controller, "controller", credentialed]]
		: strategy === "client-local" ? [[client, "client", "/cmr/client/pair"], [controller, "controller", bare]]
		: [[client, "client", "/cmr/client/set pairing-requirement=none"], [controller, "controller", bare]];
	const outputs: PairResult["outputs"] = [];
	const record = (on: "controller" | "client", line: string, output: string) =>
		// Never record the client's password, only that one was sent.
		outputs.push({ on, command: line.replace(/password="[^"]*"/, 'password="…"'), output: output.replaceAll("\r", "") });
	if (strategy === "client-local") {
		// A bare /cmr/client/pair blocks until the controller approves (a sequential call times
		// out), so the controller's bare pair has to run while it waits.
		const [, , clientLine] = steps[0] as [ChrInstance, "client", string];
		const [, , controllerLine] = steps[1] as [ChrInstance, "controller", string];
		const waiting = client.exec(clientLine, { via: "rest", timeout: 60_000 }).then(r => r.output, (error: unknown) => `error: ${error instanceof Error ? error.message : String(error)}`);
		await Bun.sleep(3000);
		const controllerOutput = await command(controller, controllerLine);
		record("client", clientLine, await waiting);
		record("controller", controllerLine, controllerOutput);
	} else if (strategy === "client-none") {
		const [[, , clientLine], [, , controllerLine]] = steps as [[ChrInstance, "client", string], [ChrInstance, "controller", string]];
		record("client", clientLine, await command(client, clientLine));
		// The client renegotiates after a requirement change. A pair sent before the row shows
		// `device:ok` selects nothing and prints nothing.
		await until(`${identity} renegotiated`, async () => {
			const seen = await observe(controller, client, identity);
			return seen.row?.connected === "true" && (seen.row.state?.includes("device:ok") ?? false);
		}, 60_000);
		record("controller", controllerLine, await command(controller, controllerLine));
	} else {
		for (const [chr, on, line] of steps) record(on, line, await command(chr, line));
	}
	const pairStatus = lastPairStatus(outputs.filter(o => o.on === "controller").at(-1)?.output ?? "");
	const started = Date.now();
	let settled = await observe(controller, client, identity);
	while (settled.verdict !== "paired" && Date.now() - started < settleMs) {
		await Bun.sleep(1000);
		settled = await observe(controller, client, identity);
	}
	return { strategy, outputs, pairStatus, settled, settleMs: Date.now() - started };
}

/**
 * The commit test: restart the controller's CMR service (`/cmr` disable, enable), which drops
 * every session, and report the row once the client is back. A committed pairing returns
 * `paired`; a half-paired one returns as `pair: device:ok, cmr:waiting confirmation`.
 *
 * Why not a client-side kick: a tcp-reset rule on the client only fires when the client sends,
 * and a half-paired session is idle (0 packets in 60 s), so it never disconnects. Client
 * disable/enable clears the pairing by design. Note this restarts CMR for every client.
 */
export async function restartController(controller: ChrInstance, client: ChrInstance, identity: string): Promise<Observation> {
	await command(controller, "/cmr/set enabled=no");
	await command(controller, "/cmr/set enabled=yes");
	await until(`${identity} disconnected`, async () => !(await read(client, "/cmr/client"))[0]?.status?.endsWith(",connected"), 30_000)
		.catch(() => undefined); // A fast reconnect can hide the disconnect from a 1 s poll.
	// The client logs `paired,connected` and can flip to `waiting-for-pairing` a moment later:
	// require two equal reads 3 s apart.
	let previous = "";
	let last: Observation | undefined;
	await until(`${identity} reconnected and stable`, async () => {
		last = await observe(controller, client, identity);
		const key = JSON.stringify([last.clientStatus, last.row?.state, last.row?.connected]);
		const stable = key === previous && last.clientStatus?.endsWith(",connected") === true && last.row?.connected === "true";
		previous = key;
		if (!stable) await Bun.sleep(2000);
		return stable;
	}, 180_000);
	return last as Observation;
}

/**
 * Pair a lab client so that `run-script` selects it, and say how it got there.
 *
 * Uses `confirm-first` (the controller's approval is committed before the credentialed pair),
 * then verifies the row. If a build still leaves it half-paired, one bare `pair` finishes it and
 * the result records `repaired: true`, so a lab never hides the RouterOS behaviour it worked around.
 */
export async function pairClient(controller: ChrInstance, client: ChrInstance, strategy: Strategy = "confirm-first"): Promise<{ result: PairResult; repaired: boolean }> {
	const identity = await identityOf(client);
	await waitPending(controller, client, identity);
	const result = await pairWith(controller, client, identity, strategy);
	let repaired = false;
	if (result.settled.verdict === "half-paired") {
		await command(controller, `/cmr/device/pair [find identity=${quote(identity)}]`);
		repaired = true;
	}
	await until(`${identity} paired`, async () => (await observe(controller, client, identity)).verdict === "paired");
	const selection = await selectable(controller, identity);
	check(selection.selected, `${identity} paired but run-script does not select it:\n${selection.output}`);
	if (repaired || result.settled.verdict !== "paired") console.log(`${identity}: ${strategy} pair ended ${result.settled.verdict}${repaired ? "; finished with a bare pair" : ""}`);
	return { result, repaired };
}
