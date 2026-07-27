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
 * Both are best-effort and must never turn a diagnostic problem into a thrown
 * error: every capture path swallows its own failures and records them as text.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

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
 *  removing it. CI sets this so `boot-failure.json`, the full `qemu.log`, and
 *  (with QUICKCHR_SERIAL_LOG=1) `serial.log` survive into the run artifacts. */
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

export interface BootFailureContext {
	name: string;
	machineDir: string;
	arch: string;
	accel: string;
	bootTimeoutMs: number;
	pid?: number;
	httpPort?: number;
	portBase?: number;
	qemuArgs?: string[];
	probe?: BootProbeStats;
	/** Free-text marker for which call path failed, e.g. "start" / "_launchExisting". */
	phase: string;
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

	const record = {
		capturedAt: new Date().toISOString(),
		phase: ctx.phase,
		machine: {
			name: ctx.name,
			arch: ctx.arch,
			accel: ctx.accel,
			bootTimeoutMs: ctx.bootTimeoutMs,
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
		reportPath = join(dir, `boot-failure-${ctx.name}-${stamp}.json`);
		writeFileSync(reportPath, `${JSON.stringify(record, null, 2)}\n`);
	} catch {
		reportPath = null;
	}

	const lines: string[] = [];
	if (ctx.probe) lines.push(`REST probe: ${summarizeBootProbe(ctx.probe)}`);
	lines.push(`QEMU process: ${record.host.qemuProcess}`);
	if (record.hostfwd) lines.push(`hostfwd 127.0.0.1:${record.hostfwd.port}: ${record.hostfwd.tcpConnect}`);
	for (const [command, output] of Object.entries(monitor)) {
		if (command === "info status") lines.push(`monitor ${command}: ${output.replace(/\s+/g, " ").trim()}`);
	}
	if (serialLog) lines.push(`serial.log tail:\n${serialLog.slice(-1200)}`);
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
