/**
 * Boot / channel failure forensics.
 *
 * Exists because the `ci:slow-platform-flake` series (#76 #79 #80 #91) kept
 * producing failures that carried no evidence: `waitForBoot()` returns a bare
 * boolean, and both BOOT_TIMEOUT call sites `stop()` + `remove()` the machine
 * before throwing, so the only surviving artefact was `qemu.log.slice(-1200)` —
 * which on every recorded failure contained nothing but the cleanup SIGTERM.
 *
 * Two things are captured here:
 *
 *   1. **What the REST probe saw.** A boot that never becomes REST-ready is
 *      ambiguous: connection-refused for the whole window means the hostfwd
 *      never bound (a host-side / QEMU-args problem), while socket hangs or
 *      resets mean the guest is answering at TCP level but RouterOS is not up.
 *      `BootProbeStats` keeps that distinction instead of collapsing it to
 *      `false`.
 *
 *   2. **The machine's state at the moment of failure**, before cleanup runs —
 *      full qemu.log, monitor `info status` (a paused/io-error guest is an
 *      instant answer), QEMU liveness, a direct TCP probe of the forwarded
 *      port, the argv, and the machine-dir listing.
 *
 *   3. **Where the drop happened**, added for #105 because (1) and (2) proved
 *      only *that* #79's boot went silent. Three instruments, in increasing
 *      order of invasiveness: per-port slirp classification
 *      ({@link probeForwardedPorts}), a read-only guest snapshot over the
 *      serial console (guest-snapshot.ts), and — opt-in — the counting-rule
 *      probe that says whether the guest received the SYNs at all.
 *
 * All of it is best-effort and must never turn a diagnostic problem into a
 * thrown error: every capture path swallows its own failures and records them
 * as text.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import {
	captureGuestSnapshot,
	deepBootDiagnosticsEnabled,
	runCountingRuleProbe,
	type CountingRuleProbe,
	type GuestExec,
	type GuestSnapshot,
} from "./guest-snapshot.ts";
import type { PortMapping } from "./types.ts";

/** Classification of a single REST readiness probe. */
export type BootProbeOutcome =
	/** TCP connect refused — nothing is listening on the forwarded host port. */
	| "refused"
	/** Connection reset by peer — something accepted then dropped us. */
	| "reset"
	/** Connect or response exceeded the per-probe budget — socket hung. */
	| "probe-timeout"
	/** 401/403 — REST answered; auth layer is up. */
	| "unauthorized"
	/** 2xx but not the expected `board-name` singleton — REST still initializing. */
	| "wrong-body"
	/** Any other HTTP status. */
	| "http-error"
	/** 2xx with the expected body. */
	| "ready"
	/** Anything unclassified — `detail` carries the raw text. */
	| "other";

export interface BootProbeStats {
	/** Total probe attempts made. */
	attempts: number;
	/** Attempt count per outcome. */
	counts: Partial<Record<BootProbeOutcome, number>>;
	/** ms from the start of the wait to the first probe that produced any HTTP
	 *  status at all (i.e. the forwarded port was live). Null if never. */
	firstHttpAtMs: number | null;
	/** Outcome + detail of the very first probe. */
	first: { atMs: number; outcome: BootProbeOutcome; detail?: string } | null;
	/** Outcome + detail of the most recent probe. */
	last: { atMs: number; outcome: BootProbeOutcome; detail?: string } | null;
}

export function newBootProbeStats(): BootProbeStats {
	return { attempts: 0, counts: {}, firstHttpAtMs: null, first: null, last: null };
}

/** Map a thrown probe error to an outcome. Keep in sync with restGet()'s
 *  rejection paths: node errno codes, plus its own "restGet timeout" message. */
export function classifyProbeError(err: unknown): { outcome: BootProbeOutcome; detail: string } {
	const code = (err as NodeJS.ErrnoException | undefined)?.code;
	const message = err instanceof Error ? err.message : String(err);
	if (code === "ECONNREFUSED") return { outcome: "refused", detail: code };
	if (code === "ECONNRESET" || code === "EPIPE") return { outcome: "reset", detail: code };
	if (code === "ETIMEDOUT" || message.includes("restGet timeout")) {
		return { outcome: "probe-timeout", detail: code ?? "probe deadline" };
	}
	return { outcome: "other", detail: code ? `${code}: ${message}` : message };
}

export function recordBootProbe(
	stats: BootProbeStats | undefined,
	elapsedMs: number,
	outcome: BootProbeOutcome,
	detail?: string,
): void {
	if (!stats) return;
	stats.attempts++;
	stats.counts[outcome] = (stats.counts[outcome] ?? 0) + 1;
	const entry = { atMs: elapsedMs, outcome, ...(detail ? { detail } : {}) };
	stats.first ??= entry;
	stats.last = entry;
	const sawHttp = outcome === "unauthorized" || outcome === "wrong-body" || outcome === "http-error" || outcome === "ready";
	if (sawHttp && stats.firstHttpAtMs === null) stats.firstHttpAtMs = elapsedMs;
}

/** One-line human summary — this is what makes a BOOT_TIMEOUT actionable.
 *  `probe-timeout` throughout means slirp accepted but nothing behind it answered
 *  (guest-side); `refused` means QEMU never bound the port at all (host-side);
 *  `reset` / `wrong-body` mean the guest answered and RouterOS is still settling.
 *  See probeTcpPort() for why `refused` is rarer than intuition suggests. */
export function summarizeBootProbe(stats: BootProbeStats): string {
	if (stats.attempts === 0) return "no probes recorded";
	const tally = Object.entries(stats.counts)
		.sort((a, b) => b[1] - a[1])
		.map(([k, v]) => `${k}=${v}`)
		.join(" ");
	const reachedHttp = stats.firstHttpAtMs === null
		? "forwarded port never produced an HTTP response"
		: `first HTTP response at ${Math.round(stats.firstHttpAtMs / 1000)}s`;
	const last = stats.last
		? `last: ${stats.last.outcome}${stats.last.detail ? ` (${stats.last.detail})` : ""} at ${Math.round(stats.last.atMs / 1000)}s`
		: "";
	return `${stats.attempts} probes [${tally}] — ${reachedHttp}; ${last}`;
}

/** True when failure paths should keep the machine directory instead of
 *  removing it — for poking at a wedged machine by hand (`quickchr console`,
 *  the disk image, the sockets).
 *
 *  A local debugging aid, **not** how evidence reaches CI: `captureBootFailure()`
 *  writes its report outside the machine dir and embeds the logs, so the report
 *  survives cleanup either way. CI therefore leaves this unset — stranded
 *  machines hold ~130-190 MB and a port block each, which risks tripping
 *  test/preload.ts's storage preflight on a full matrix. */
export function preserveOnFailure(): boolean {
	return process.env.QUICKCHR_PRESERVE_ON_FAILURE === "1";
}

/** True when QEMU should tee the serial console to `<machineDir>/serial.log`.
 *  Opt-in: serial-console provisioning types the generated user password in
 *  cleartext, so the log is secret-bearing (see provision.ts provisionViaConsole). */
export function serialLogEnabled(): boolean {
	return process.env.QUICKCHR_SERIAL_LOG === "1";
}

/** Is a TCP port on localhost accepting connections right now?
 *
 *  Useful mainly in the negative. Under the default `user` (slirp) network mode
 *  QEMU's hostfwd listens for the whole life of the process and accepts before it
 *  ever tries to reach the guest, so a completely dead guest still reports
 *  "accepting" — verified locally 2026-07-27 with a deliberately 32 MB CHR.
 *  A refusal, though, means QEMU itself is gone or never bound the port. */
export async function probeTcpPort(port: number, timeoutMs = 2000): Promise<string> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (result: string) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(result);
		};
		const socket = connect(port, "127.0.0.1");
		socket.setTimeout(timeoutMs);
		socket.on("connect", () => finish("accepting"));
		socket.on("timeout", () => finish("connect timed out"));
		socket.on("error", (err) => finish((err as NodeJS.ErrnoException).code ?? err.message));
	});
}

// --- Per-port slirp classification ---

/** One row of QEMU's `info usernet` table:
 *
 *  ```text
 *    Protocol[State]    FD  Source Address  Port   Dest. Address  Port RecvQ SendQ
 *    TCP[HOST_FORWARD]  21               *  9170       10.0.2.15    80     0     0
 *    TCP[SYN_SENT]     103       127.0.0.1  9100       10.0.2.15    80     0     0
 *    UDP[223 sec]      168       10.0.2.15  5678 255.255.255.255  5678     0     0
 *  ```
 *
 *  The bracketed state can contain a space (UDP rows carry a TTL, `[223 sec]`),
 *  so it is matched as "anything but `]`" rather than a word. */
export interface UsernetRow {
	proto: string;
	state: string;
	fd: number;
	srcAddr: string;
	srcPort: number;
	dstAddr: string;
	dstPort: number;
	recvQ: number;
	sendQ: number;
}

const USERNET_ROW_RE =
	/^\s*(TCP|UDP)\[([^\]]*)\]\s+(\d+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/;

export function parseUsernetTable(text: string): UsernetRow[] {
	const rows: UsernetRow[] = [];
	for (const line of text.split(/\r?\n/)) {
		const m = USERNET_ROW_RE.exec(line);
		if (!m) continue;
		rows.push({
			proto: String(m[1]),
			state: String(m[2]),
			fd: Number(m[3]),
			srcAddr: String(m[4]),
			srcPort: Number(m[5]),
			dstAddr: String(m[6]),
			dstPort: Number(m[7]),
			recvQ: Number(m[8]),
			sendQ: Number(m[9]),
		});
	}
	return rows;
}

/** What a probe of one forwarded port revealed about the guest behind it.
 *
 *  Grounded on a healthy local 7.21.5 CHR (x86/HVF), four probes per condition
 *  — see tikoci/quickchr#79 (comment 5109767102) and #105:
 *
 *  | guest condition                     | `info usernet` after probing |
 *  |-------------------------------------|------------------------------|
 *  | serving (`www` enabled)             | `TIME_WAIT` rows             |
 *  | nothing listening (service off)     | **no rows at all** — the guest RSTs and slirp discards the entry |
 *  | silently dropped (`action=drop`)    | `SYN_SENT` rows, persisting  |
 *
 *  A host-side TCP connect reads "accepting" in all three cases (slirp's
 *  hostfwd accepts regardless of guest state), which is why `hostfwd.tcpConnect`
 *  in the report is not evidence and this table is. */
export type ForwardOutcome =
	/** Connection completed — something in the guest answered on this port. */
	| "served"
	/** No lingering row: the guest sent an RST, so nothing is listening on that
	 *  port — but the guest itself is alive and answering. */
	| "refused"
	/** `SYN_SENT` persisting: the SYNs are being silently dropped. */
	| "dropped"
	/** No `HOST_FORWARD` row — QEMU never bound this forward. */
	| "not-forwarded"
	/** Rows exist but in no state we classify. */
	| "unknown";

export interface ForwardClassification {
	name: string;
	hostPort: number;
	guestPort: number;
	proto: string;
	outcome: ForwardOutcome;
	/** Non-`HOST_FORWARD` states seen for this guest port, e.g. `["SYN_SENT×15"]`. */
	states: string[];
	/** Result of the host-side TCP connect, kept for completeness. */
	hostConnect: string;
}

const SERVED_STATES = ["ESTABLISHED", "TIME_WAIT", "FIN_WAIT_1", "FIN_WAIT_2", "CLOSE_WAIT", "LAST_ACK", "CLOSING"];

export function classifyForwardedPorts(
	rows: UsernetRow[],
	forwards: { name: string; host: number; guest: number; proto: string }[],
	hostConnect: Record<string, string> = {},
): ForwardClassification[] {
	// Two forwards may target the same guest port from different host ports, so the
	// guest port alone cannot attribute a row. slirp reports the *host* forward
	// port as a forwarded connection's source port, not the client's ephemeral one
	// — verified on captured output, where every live row sat at
	// `127.0.0.1:<hostPort> -> 10.0.2.15:<guestPort>`, and the same shape appears
	// in #79's CI dumps. Confirm that convention holds in this dump before relying
	// on it: if it ever stops, classification degrades to guest-port matching
	// rather than silently reporting every port as `refused`.
	const liveRowsCarryHostPort = rows.some(
		(r) => r.state !== "HOST_FORWARD" && forwards.some((f) => f.host === r.srcPort),
	);

	return forwards.map((fwd) => {
		const byGuestPort = rows.filter((r) => r.proto.toUpperCase() === fwd.proto.toUpperCase() && r.dstPort === fwd.guest);
		const forwarded = byGuestPort.some((r) => r.state === "HOST_FORWARD" && r.srcPort === fwd.host);
		const liveRows = byGuestPort.filter((r) => r.state !== "HOST_FORWARD");
		const live = liveRowsCarryHostPort ? liveRows.filter((r) => r.srcPort === fwd.host) : liveRows;

		const tally = new Map<string, number>();
		for (const r of live) tally.set(r.state, (tally.get(r.state) ?? 0) + 1);
		const states = [...tally].map(([state, n]) => (n > 1 ? `${state}×${n}` : state));

		let outcome: ForwardOutcome;
		if (!forwarded) outcome = "not-forwarded";
		else if (live.some((r) => r.state === "SYN_SENT")) outcome = "dropped";
		else if (live.length === 0) outcome = "refused";
		else if (live.some((r) => SERVED_STATES.includes(r.state))) outcome = "served";
		else outcome = "unknown";

		return {
			name: fwd.name,
			hostPort: fwd.host,
			guestPort: fwd.guest,
			proto: fwd.proto,
			outcome,
			states,
			hostConnect: hostConnect[fwd.name] ?? "not probed",
		};
	});
}

/** Read the classification table as one sentence. All ports dropping points at
 *  the RX path (nothing the guest exposes is reachable); a single dropped port
 *  next to healthy ones points at that one service. */
export function summarizeForwardOutcomes(ports: ForwardClassification[]): string {
	if (ports.length === 0) return "no TCP forwards to classify";
	const dropped = ports.filter((p) => p.outcome === "dropped");
	const table = ports.map((p) => `${p.name}:${p.guestPort}=${p.outcome}`).join(" ");
	if (dropped.length === 0) return `${table} — no silent drop observed`;
	if (dropped.length === ports.length) {
		return `${table} — EVERY forwarded port is silently dropped: whole-stack silence, points at the guest RX path`;
	}
	return `${table} — ${dropped.map((p) => p.name).join(",")} silently dropped while others are not: service-specific`;
}

export interface ForwardProbeResult {
	probesPerPort: number;
	ports: ForwardClassification[];
	/** Raw `info usernet` taken *after* the probes — the classification input. */
	usernetAfterProbe: string;
	summary: string;
}

/**
 * Probe every forwarded TCP port and classify what slirp saw.
 *
 * The probes are what make the table meaningful: a `refused` verdict only means
 * "nothing listening" because a probe was sent and left no row behind. Fired in
 * parallel — rows are attributed by destination port, not by time.
 */
export async function probeForwardedPorts(
	forwards: { name: string; host: number; guest: number; proto: string }[],
	monitorQuery: (command: string) => Promise<string>,
	opts: { probesPerPort?: number; settleMs?: number } = {},
): Promise<ForwardProbeResult> {
	const probesPerPort = opts.probesPerPort ?? 2;
	const tcp = forwards.filter((f) => f.proto.toLowerCase() === "tcp");

	const hostConnect: Record<string, string> = {};
	await Promise.all(
		tcp.map(async (fwd) => {
			let last = "not probed";
			for (let i = 0; i < probesPerPort; i++) last = await probeTcpPort(fwd.host);
			hostConnect[fwd.name] = last;
		}),
	);

	// Let the guest's RSTs land (which removes `refused` rows) before sampling;
	// `SYN_SENT` and `TIME_WAIT` both persist well past this.
	await Bun.sleep(opts.settleMs ?? 1000);

	let usernet: string;
	try {
		usernet = await monitorQuery("info usernet");
	} catch (e) {
		usernet = `<failed: ${e instanceof Error ? e.message : String(e)}>`;
	}

	const ports = classifyForwardedPorts(parseUsernetTable(usernet), tcp, hostConnect);
	return { probesPerPort, ports, usernetAfterProbe: usernet, summary: summarizeForwardOutcomes(ports) };
}

function isProcessAlive(pid: number | undefined): string {
	if (pid === undefined) return "unknown (no pid recorded)";
	try {
		process.kill(pid, 0);
		return `alive (pid ${pid})`;
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === "EPERM") return `alive but not signalable (pid ${pid})`;
		return `not running (pid ${pid})`;
	}
}

function listMachineDir(machineDir: string): { name: string; bytes: number }[] {
	try {
		return readdirSync(machineDir).map((name) => {
			try {
				return { name, bytes: statSync(join(machineDir, name)).size };
			} catch {
				return { name, bytes: -1 };
			}
		});
	} catch {
		return [];
	}
}

/** Cap on embedded log text. A wedged QEMU can emit megabytes of repeated
 *  warnings; the tail is what matters and the report has to stay artifact-sized. */
const MAX_EMBEDDED_LOG_BYTES = 256 * 1024;

function readIfPresent(path: string): string | null {
	try {
		if (!existsSync(path)) return null;
		const text = readFileSync(path, "utf-8");
		return text.length > MAX_EMBEDDED_LOG_BYTES
			? `<truncated to last ${MAX_EMBEDDED_LOG_BYTES} bytes of ${text.length}>\n${text.slice(-MAX_EMBEDDED_LOG_BYTES)}`
			: text;
	} catch {
		return null;
	}
}

/** Keep only the newest N reports in a failures directory.
 *
 *  Each report embeds up to 2 × 256 KB of log text, and a flaky-boot loop can
 *  produce one per attempt, so this directory would otherwise grow without
 *  bound — the image cache has `autoPruneIfOverCap`, this had nothing.
 *  Best-effort: never throws. */
export const MAX_BOOT_FAILURE_REPORTS = 20;

/** Report filename prefixes, one per capture kind. The cap is on the *directory*,
 *  not per prefix: a machine that fails post-readiness is exactly as likely to be
 *  retried in a loop as one that fails to boot, and two independent 20-file caps
 *  in one directory is a 40-file directory nobody chose. Adding a kind here is
 *  what keeps it prunable — a prefix absent from this list grows without bound. */
export const FAILURE_REPORT_PREFIXES = ["boot-failure-", "post-readiness-failure-"] as const;

/** The ISO-8601 stamp `captureBootFailure()` appends, with `:` and `.` replaced
 *  by `-`. Ordering is by this, not by the whole filename: sorting whole names
 *  was chronological only while every report shared one prefix, and would now
 *  rank every `post-readiness-failure-` above every `boot-failure-` regardless
 *  of age — silently pruning the newer of the two kinds. */
const REPORT_STAMP = /(\d{4}-\d{2}-\d{2}T[\d-]+Z)\.json$/;

export function pruneBootFailureReports(dir: string, keep = MAX_BOOT_FAILURE_REPORTS): void {
	try {
		const reports = readdirSync(dir)
			.filter((name) => FAILURE_REPORT_PREFIXES.some((p) => name.startsWith(p)) && name.endsWith(".json"))
			// Unstamped names sort last and are pruned first: this function only
			// ever sees names it wrote, so one without a stamp is unrecognized, and
			// keeping it in preference to a dated report would be a guess.
			.sort((a, b) => (REPORT_STAMP.exec(a)?.[1] ?? "").localeCompare(REPORT_STAMP.exec(b)?.[1] ?? ""))
			.reverse();
		for (const stale of reports.slice(keep)) {
			try { unlinkSync(join(dir, stale)); } catch { /* ignore */ }
		}
	} catch { /* ignore */ }
}

/**
 * Worst-case wall clock `captureBootFailure()` may consume, in ms.
 *
 * It runs *after* a boot budget has already been spent, so anything waiting on
 * that call — most importantly a test's own timeout — has to allow for it, or
 * the forensics are killed before they can be written and the failure is
 * evidence-free again (tikoci/quickchr#106). Sum of the bounded parts: forward
 * probe ≤ 20 s, guest snapshot ≤ 60 s (GUEST_SNAPSHOT_BUDGET_MS), counting-rule
 * probe ≤ 90 s, report write and cleanup the rest.
 */
export const BOOT_FORENSICS_BUDGET_MS = 180_000;

/**
 * Why the capture ran, when the trigger was *not* a boot timeout.
 *
 * Boot-timeout captures explain themselves: `BootProbeStats` says what every
 * readiness probe saw, and the whole window is the evidence. A failure *after*
 * readiness has no such record — `restProbe` is null, the machine booted fine,
 * and the interesting facts are which single request died and what state change
 * immediately preceded it. That is #69: a connection accepted and reset on the
 * first request following a credential transition. Without this field the report
 * would show a healthy machine and never say what was being asked of it.
 */
export interface FailureTrigger {
	/** The operation that failed, e.g. `GET /rest/system/resource`. */
	operation: string;
	/** The error as thrown, message and code. */
	error: string;
	/** ms from REST-ready to the failure, when derivable. Distinguishes a reset
	 *  seconds after boot from one many operations later. */
	sinceReadyMs?: number;
	/** The credential/database change immediately preceding the failed request —
	 *  #69's suspected precondition. Free text, e.g.
	 *  `createUser(testuser) then auth as testuser`. Callers state what they did;
	 *  nothing here infers it. */
	credentialTransition?: string;
}

export interface BootFailureContext {
	name: string;
	machineDir: string;
	arch: string;
	accel: string;
	/** Omitted by non-boot captures, which have no boot budget to report. */
	bootTimeoutMs?: number;
	pid?: number;
	httpPort?: number;
	portBase?: number;
	qemuArgs?: string[];
	probe?: BootProbeStats;
	/** Free-text marker for which call path failed, e.g. "start" / "_launchExisting". */
	phase: string;
	/** Set by post-readiness captures. See {@link FailureTrigger}. */
	trigger?: FailureTrigger;
	/** Durable directory for the report, OUTSIDE the machine directory.
	 *
	 *  It must outlive the machine: integration tests wrap their bodies in
	 *  `finally { cleanupMachine(name) }`, which calls `remove()` and deletes the
	 *  machine dir — so a report written next to qemu.log is gone before CI can
	 *  upload it, whether or not QUICKCHR_PRESERVE_ON_FAILURE is set. The report
	 *  embeds the log contents rather than pointing at them, so it stands alone.
	 *  Defaults to the machine dir when omitted. */
	reportDir?: string;
	/** Runs `info status` / `info block` against the QEMU monitor. Injected so
	 *  this module stays free of a channels.ts import cycle. */
	monitorQuery?: (command: string) => Promise<string>;
	/** The machine's port forwards, for per-port slirp classification. Without
	 *  them the report can only say *that* the drop happened, not *where*. */
	forwards?: PortMapping[];
	/** Runs one RouterOS command over the serial console. Injected (console.ts)
	 *  so this module keeps no channel dependency. Omit to skip guest-side
	 *  capture entirely — e.g. when no serial channel exists. */
	guestExec?: GuestExec;
	/** Account `guestExec` logs in as. Recorded in the report only. */
	guestUser?: string;
}

export interface BootFailureReport {
	/** Compact multi-line text suitable for embedding in the thrown error. */
	summary: string;
	/** Path of the written JSON report, if the machine dir was writable. */
	reportPath: string | null;
	/** Whether the caller should skip removing the machine directory. */
	preserved: boolean;
}

/**
 * Snapshot everything that explains a boot failure, *before* the caller tears
 * the machine down. Never throws.
 */
export async function captureBootFailure(ctx: BootFailureContext): Promise<BootFailureReport> {
	const qemuLog = readIfPresent(join(ctx.machineDir, "qemu.log"));
	const serialLog = readIfPresent(join(ctx.machineDir, "serial.log"));

	const monitor: Record<string, string> = {};
	if (ctx.monitorQuery) {
		// `info usernet` dumps slirp's VLAN state and hostfwd table. It is the one
		// query that separates "the guest is up but unreachable" from "the guest is
		// down": under user-mode networking the host port always accepts (see
		// probeTcpPort), so the forwarding table is the only host-side view of
		// whether slirp can actually deliver to the guest.
		for (const command of ["info status", "info block", "info chardev", "info usernet", "info network"]) {
			try {
				monitor[command] = await ctx.monitorQuery(command);
			} catch (e) {
				monitor[command] = `<failed: ${e instanceof Error ? e.message : String(e)}>`;
			}
		}
	}

	// Host-side localization: probe every forwarded port and read slirp's own
	// view of what happened to each. This is the only host-side instrument that
	// distinguishes "nothing listening" from "silently dropped" — see
	// ForwardOutcome.
	let forwardProbe: ForwardProbeResult | null = null;
	if (ctx.monitorQuery && ctx.forwards?.length) {
		try {
			forwardProbe = await probeForwardedPorts(ctx.forwards, ctx.monitorQuery);
		} catch (e) {
			forwardProbe = {
				probesPerPort: 0,
				ports: [],
				usernetAfterProbe: "",
				summary: `<forward probe failed: ${e instanceof Error ? e.message : String(e)}>`,
			};
		}
	}

	// Guest-side: read-only, and reachable even when REST is dead.
	let guest: GuestSnapshot | null = null;
	if (ctx.guestExec) {
		try {
			guest = await captureGuestSnapshot(ctx.guestExec, ctx.guestUser);
		} catch { /* captureGuestSnapshot swallows its own failures; belt and braces */ }
	}

	// The discriminator, opt-in because it writes to the guest. Skipped when the
	// caller wants the machine preserved — that flag means "leave the state alone".
	let countingRule: CountingRuleProbe | null = null;
	if (ctx.guestExec && ctx.httpPort !== undefined) {
		if (guest && !guest.consoleReachable) {
			countingRule = { ran: false, skipped: "serial console unreachable", detail: "" };
		} else if (!deepBootDiagnosticsEnabled()) {
			countingRule = { ran: false, skipped: "QUICKCHR_DEEP_BOOT_DIAGNOSTICS is not 1", detail: "" };
		} else if (preserveOnFailure()) {
			countingRule = { ran: false, skipped: "QUICKCHR_PRESERVE_ON_FAILURE=1 — guest left untouched", detail: "" };
		} else {
			const httpGuestPort = ctx.forwards?.find((f) => f.host === ctx.httpPort)?.guest ?? 80;
			try {
				countingRule = await runCountingRuleProbe(ctx.guestExec, probeTcpPort, {
					guestPort: httpGuestPort,
					hostPort: ctx.httpPort,
				});
			} catch (e) {
				countingRule = { ran: false, detail: `counting-rule probe failed: ${e instanceof Error ? e.message : String(e)}` };
			}
		}
	}

	const record = {
		capturedAt: new Date().toISOString(),
		phase: ctx.phase,
		trigger: ctx.trigger ?? null,
		machine: {
			name: ctx.name,
			arch: ctx.arch,
			accel: ctx.accel,
			bootTimeoutMs: ctx.bootTimeoutMs ?? null,
			machineDir: ctx.machineDir,
			portBase: ctx.portBase,
			httpPort: ctx.httpPort,
		},
		host: {
			platform: process.platform,
			hostArch: process.arch,
			qemuProcess: isProcessAlive(ctx.pid),
		},
		restProbe: ctx.probe
			? { summary: summarizeBootProbe(ctx.probe), ...ctx.probe }
			: null,
		hostfwd: ctx.httpPort === undefined
			? null
			: { port: ctx.httpPort, tcpConnect: await probeTcpPort(ctx.httpPort) },
		forwardProbe,
		guest,
		countingRule,
		monitor,
		qemuArgs: ctx.qemuArgs ?? null,
		machineDirListing: listMachineDir(ctx.machineDir),
		qemuLog: qemuLog ?? "<absent>",
		serialLog: serialLog ?? (serialLogEnabled() ? "<absent>" : "<not captured — set QUICKCHR_SERIAL_LOG=1>"),
	};

	let reportPath: string | null = null;
	try {
		const dir = ctx.reportDir ?? ctx.machineDir;
		mkdirSync(dir, { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		// The kind is in the filename, not only in the JSON: these land in a CI
		// artifact as a flat directory listing, and "why is there a boot-failure
		// report for a machine that booted?" is a question the name should not
		// provoke. Both prefixes are in FAILURE_REPORT_PREFIXES so both prune.
		const prefix = ctx.trigger ? "post-readiness-failure" : "boot-failure";
		reportPath = join(dir, `${prefix}-${ctx.name}-${stamp}.json`);
		writeFileSync(reportPath, `${JSON.stringify(record, null, 2)}\n`);
		pruneBootFailureReports(dir);
	} catch {
		reportPath = null;
	}

	const lines: string[] = [];
	// First, because on a post-readiness capture everything below it describes a
	// machine that is working — the trigger is the only line that says what broke.
	if (ctx.trigger) {
		const since = ctx.trigger.sinceReadyMs !== undefined
			? ` at +${(ctx.trigger.sinceReadyMs / 1000).toFixed(1)}s after REST-ready`
			: "";
		lines.push(`Failed after readiness: ${ctx.trigger.operation}${since} — ${ctx.trigger.error}`);
		if (ctx.trigger.credentialTransition) {
			lines.push(`Preceding credential transition: ${ctx.trigger.credentialTransition}`);
		}
	}
	if (ctx.probe) lines.push(`REST probe: ${summarizeBootProbe(ctx.probe)}`);
	lines.push(`QEMU process: ${record.host.qemuProcess}`);
	if (record.hostfwd) lines.push(`hostfwd 127.0.0.1:${record.hostfwd.port}: ${record.hostfwd.tcpConnect}`);
	if (forwardProbe) lines.push(`slirp per-port: ${forwardProbe.summary}`);
	// Shapes only — the values stay in the report. See summarizeGuestSnapshot.
	if (guest) lines.push(guest.summary);
	if (countingRule?.ran) lines.push(`counting rule: ${countingRule.detail}`);
	for (const [command, output] of Object.entries(monitor)) {
		if (command === "info status") lines.push(`monitor ${command}: ${output.replace(/\s+/g, " ").trim()}`);
	}
	// serial.log is NOT inlined here, only pointed at. This summary is appended to
	// a thrown QuickCHRError, which the CLI prints and CI echoes into job logs —
	// public ones, on a public repo. The log itself is secret-bearing (console
	// provisioning types the generated password in cleartext) and `logappend=on`
	// means it spans every boot of that machine dir, so an unrelated later failure
	// could print a password typed sessions earlier. The full text stays in the
	// JSON report, which is opt-in and lands in an access-controlled artifact.
	if (serialLog) {
		lines.push(
			`serial.log: ${serialLog.length} bytes captured — not inlined (may contain provisioning credentials); see the full report`,
		);
	}
	if (qemuLog) lines.push(`qemu.log tail:\n${qemuLog.slice(-1200)}`);
	if (reportPath) lines.push(`Full report: ${reportPath}`);

	return {
		summary: lines.join("\n"),
		reportPath,
		preserved: preserveOnFailure(),
	};
}

/** Per-phase timings for a QEMU monitor round-trip. All values are ms offsets
 *  from the start of monitorCommand(); null means the phase was never reached.
 *  Distinguishes issue #80's hypotheses: a null `promptAtMs` means the monitor
 *  never greeted us, a null `responseFirstByteAtMs` with a non-null
 *  `commandWrittenAtMs` means QEMU took the command and went quiet. */
export interface MonitorPhaseTimings {
	connectedAtMs: number | null;
	firstByteAtMs: number | null;
	promptAtMs: number | null;
	commandWrittenAtMs: number | null;
	responseFirstByteAtMs: number | null;
	bytesReceived: number;
}

export function newMonitorPhaseTimings(): MonitorPhaseTimings {
	return {
		connectedAtMs: null,
		firstByteAtMs: null,
		promptAtMs: null,
		commandWrittenAtMs: null,
		responseFirstByteAtMs: null,
		bytesReceived: 0,
	};
}

export function summarizeMonitorPhases(t: MonitorPhaseTimings): string {
	const ms = (v: number | null) => (v === null ? "never" : `${v}ms`);
	return (
		`connect=${ms(t.connectedAtMs)} first-byte=${ms(t.firstByteAtMs)} ` +
		`prompt=${ms(t.promptAtMs)} command-written=${ms(t.commandWrittenAtMs)} ` +
		`response-first-byte=${ms(t.responseFirstByteAtMs)} bytes=${t.bytesReceived}`
	);
}
