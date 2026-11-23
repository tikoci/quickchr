/**
 * windows-pipe-chardev probe — can QEMU's monitor, serial and QGA run on
 * `-chardev pipe` on Windows, and survive repeated client reconnects? (#57)
 *
 * quickchr puts the three channels on TCP localhost at portBase+6/+7/+8 on
 * Windows because the *socket* chardev can't bind `\\.\pipe\` paths. QEMU has a
 * separate `-chardev pipe,path=<name>` that creates `\\.\pipe\<name>` natively.
 * If that backend serves every channel across reconnects, Windows needs no IPC
 * ports and the port layout can drop the +6..+8 reservation on every OS.
 *
 * The harness builds the QEMU argv by hand (only the channel args differ
 * between arms) and drives the channels with small clients of its own, because
 * the first client on a pipe has to be connected *while QEMU is still starting*
 * (see the REPORT). Per arm:
 *
 *   pipe  `-chardev pipe,path=quickchr-<name>-<channel>`        (the question)
 *   tcp   `-chardev socket,host=127.0.0.1,port=…,server=on`     (control: production today)
 *   unix  `-chardev socket,path=<dir>\<channel>.sock,server=on` (AF_UNIX on Windows, bonus)
 *
 * Phases, per machine:
 *   0. spawn QEMU; for `pipe`, watch which pipes exist and whether the guest's
 *      hostfwd port is bound while no client is connected
 *   1. connect one "held" client per channel; boot to `Login:` on the held serial
 *   2. on the held clients: monitor `info name`/`info status`, serial login +
 *      identity set/print, QGA ping; and a second client per channel while the
 *      held one is still connected
 *   3. close the held clients, then N fresh connect → command → disconnect trials
 *      per channel (monitor `info status`, serial `:put [/system identity get
 *      name]`, QGA `guest-ping`)
 *   4. liveness: QEMU process alive, REST through hostfwd answers
 *
 * `pipe` also boots a second machine at the same time and checks that each
 * machine's pipes reach that machine, and spawns a third QEMU that reuses the
 * first machine's monitor pipe name.
 *
 * Run (Windows, QEMU on PATH):
 *   bun run test/lab/windows-pipe-chardev/probe.ts --arm pipe --trials 50
 *
 * The `sun_path` check for `unix` (#57): `--work` set to the real data-dir layout
 * (`%LOCALAPPDATA%\quickchr\machines`), `--name` a long machine name, and
 * `--sun-path-sweep 104,107,108,109` first starts a bare QEMU per listed byte
 * length, with only a monitor socket at a path of exactly that many bytes, and
 * records whether QEMU accepts the path and a client can use it.
 * `--monitor-path-bytes N` (instead of `--name`) picks a name that puts the
 * machine's monitor socket at exactly N bytes; `max` uses the longest length the
 * sweep found working, so the full run sits at the limit.
 * Writes <work>/results-<arm>.json and appends a summary to $GITHUB_STEP_SUMMARY.
 * `tcp` and `unix` also run on Linux/macOS, which is how the harness is debugged.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import os from "node:os";
import { join, resolve } from "node:path";
import { cleanMonitorResponse } from "../../../src/lib/channels.ts";
import { stripAnsi } from "../../../src/lib/console.ts";
import { ensureCachedImage } from "../../../src/lib/images.ts";
import { resolveVersion } from "../../../src/lib/versions.ts";

type Arm = "pipe" | "tcp" | "unix";
type Channel = "monitor" | "serial" | "qga";
const CHANNELS: Channel[] = ["monitor", "serial", "qga"];

// ── args ────────────────────────────────────────────────────────────────────
function arg(name: string, fallback: string): string {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
}
const ARM = arg("arm", "pipe") as Arm;
const TRIALS = Number(arg("trials", "50"));
const WORK = resolve(arg("work", join(process.cwd(), ".lab-pipe-work")));
const BOOT_BUDGET_MS = Number(arg("boot-budget-ms", "900000"));
const CONNECT_TIMEOUT_MS = Number(arg("connect-timeout-ms", "5000"));
const ACCEL = arg("accel", "tcg");
const QEMU = arg("qemu", "qemu-system-x86_64");
/** A byte count, or `max`: the longest `--sun-path-sweep` length QEMU accepted and a client used. */
const MONITOR_PATH_BYTES = arg("monitor-path-bytes", "");
/** `--monitor-path-bytes N` names the machine so its monitor socket path is N bytes. */
function nameForMonitorPath(bytes: number): string {
	const fixed = Buffer.byteLength(join(WORK, "lab-unix-", "monitor.sock"));
	const pad = bytes - fixed;
	if (pad < 0) throw new Error(`--work is too long for a ${bytes}-byte monitor path`);
	return `lab-unix-${"n".repeat(pad)}`;
}
const NAME_ARG = arg("name", "");
const SWEEP = arg("sun-path-sweep", "")
	.split(",")
	.filter(Boolean)
	.map(Number);
if (!["pipe", "tcp", "unix"].includes(ARM)) throw new Error(`--arm must be pipe|tcp|unix, got ${ARM}`);
const isWin = process.platform === "win32";
if (ARM === "pipe" && !isWin) throw new Error("--arm pipe needs Windows: QEMU's pipe chardev is a FIFO pair elsewhere");
if ((NAME_ARG || MONITOR_PATH_BYTES) && ARM === "pipe") throw new Error("--name/--monitor-path-bytes are for one-machine arms (tcp, unix)");
if (MONITOR_PATH_BYTES === "max" && !SWEEP.length) throw new Error("--monitor-path-bytes max needs --sun-path-sweep");

const T0 = Date.now();
function log(msg: string): void {
	console.log(`[${((Date.now() - T0) / 1000).toFixed(1).padStart(7)}s] ${msg}`);
}

// ── endpoints ───────────────────────────────────────────────────────────────
interface Machine {
	name: string;
	dir: string;
	portBase: number;
	proc?: ChildProcess;
	pid?: number;
	argv: string[];
	exit?: { code: number | null; signal: string | null; atMs: number };
}

/** RouterOS refuses a long identity ("too long"), and `--monitor-path-bytes` can
 *  make a long machine name, so the serial checks use a prefix. */
function identityOf(m: Machine): string {
	return m.name.slice(0, 32);
}

const OFFSET: Record<Channel, number> = { monitor: 6, serial: 7, qga: 8 };

function pipeName(m: Machine, ch: Channel): string {
	// Same naming as channelPath() in src/lib/channels.ts, so quickchr's own
	// no-portBase code path would reach these pipes unchanged.
	return `quickchr-${m.name}-${ch}`;
}

type Endpoint = { kind: "path"; path: string } | { kind: "tcp"; host: string; port: number };

function endpoint(m: Machine, ch: Channel): Endpoint {
	if (ARM === "pipe") return { kind: "path", path: `\\\\.\\pipe\\${pipeName(m, ch)}` };
	if (ARM === "unix") return { kind: "path", path: join(m.dir, `${ch}.sock`) };
	return { kind: "tcp", host: "127.0.0.1", port: m.portBase + OFFSET[ch] };
}

function chardevSpec(m: Machine, ch: Channel): string {
	const id = `${ch}0`;
	if (ARM === "pipe") return `pipe,id=${id},path=${pipeName(m, ch)}`;
	if (ARM === "unix") return `socket,id=${id},path=${join(m.dir, `${ch}.sock`)},server=on,wait=off`;
	return `socket,id=${id},host=127.0.0.1,port=${m.portBase + OFFSET[ch]},server=on,wait=off`;
}

function buildArgv(m: Machine, disk: string): string[] {
	// Mirrors buildQemuArgs() for an x86 background machine (src/lib/qemu.ts):
	// only the three -chardev specs differ between arms.
	return [
		QEMU,
		"-name", m.name,
		"-M", "pc",
		"-m", "512", "-smp", "1",
		"-accel", ACCEL === "tcg" ? "tcg,tb-size=256" : ACCEL,
		"-drive", `file=${disk},format=raw,if=virtio`,
		"-netdev", `user,id=net0,hostfwd=tcp::${m.portBase}-:80`,
		"-device", "virtio-net-pci,netdev=net0",
		"-display", "none",
		"-chardev", chardevSpec(m, "monitor"),
		"-mon", "chardev=monitor0,mode=readline",
		"-chardev", chardevSpec(m, "serial"),
		"-serial", "chardev:serial0",
		"-device", "virtio-serial-pci,id=virtio-serial-qga",
		"-chardev", chardevSpec(m, "qga"),
		"-device", "virtserialport,chardev=qga0,name=org.qemu.guest_agent.0,id=qga-port0",
	];
}

// ── connection layer ────────────────────────────────────────────────────────
interface Conn {
	sock: Socket;
	buf: string;
	closed: boolean;
	error?: string;
}

interface OpenResult {
	conn?: Conn;
	ms: number;
	err?: string;
}

/** node:net connect — the same call channels.ts/qga.ts/console.ts make. */
function openConn(ep: Endpoint, timeoutMs = CONNECT_TIMEOUT_MS): Promise<OpenResult> {
	const started = Date.now();
	return new Promise((res) => {
		let done = false;
		const sock = ep.kind === "path" ? connect({ path: ep.path }) : connect(ep.port, ep.host);
		const conn: Conn = { sock, buf: "", closed: false };
		sock.on("data", (d: Buffer) => {
			conn.buf += d.toString("latin1");
		});
		sock.on("close", () => {
			conn.closed = true;
		});
		const timer = setTimeout(() => {
			if (done) return;
			done = true;
			sock.destroy();
			res({ ms: Date.now() - started, err: `connect-timeout(${timeoutMs}ms)` });
		}, timeoutMs);
		sock.once("connect", () => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			res({ conn, ms: Date.now() - started });
		});
		sock.on("error", (e: NodeJS.ErrnoException) => {
			conn.error = `${e.code ?? "?"}: ${e.message}`;
			conn.closed = true;
			if (done) return;
			done = true;
			clearTimeout(timer);
			res({ ms: Date.now() - started, err: conn.error });
		});
	});
}

async function closeConn(c: Conn | undefined): Promise<void> {
	if (!c || c.closed) return;
	await new Promise<void>((res) => {
		const t = setTimeout(() => {
			c.sock.destroy();
			res();
		}, 500);
		c.sock.once("close", () => {
			clearTimeout(t);
			res();
		});
		c.sock.end();
	});
}

async function waitFor(c: Conn, pred: (buf: string) => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (pred(c.buf)) return true;
		if (c.closed) return pred(c.buf);
		await Bun.sleep(25);
	}
	return pred(c.buf);
}

// ── channel clients ─────────────────────────────────────────────────────────
/** Monitor: wait for the `(qemu)` prompt, send, wait for the next prompt. */
async function monitorCmd(c: Conn, cmd: string, timeoutMs = 5000): Promise<{ ok: boolean; out: string; why?: string }> {
	if (!(await waitFor(c, (b) => b.includes("(qemu)"), timeoutMs))) {
		return { ok: false, out: c.buf.slice(-200), why: c.closed ? "closed-before-prompt" : "no-prompt" };
	}
	c.buf = "";
	c.sock.write(`${cmd}\n`);
	if (!(await waitFor(c, (b) => b.includes("(qemu)"), timeoutMs))) {
		return { ok: false, out: c.buf.slice(-200), why: c.closed ? "closed-before-reply" : "no-reply" };
	}
	return { ok: true, out: cleanMonitorResponse(c.buf.replace(/\(qemu\)\s*/g, "")) };
}

const PROMPT = "] > ";

/** Serial: reach a CLI prompt (logging in as admin/empty if needed), the same
 *  prompts console.ts's ensureLoggedIn() handles. */
async function serialLogin(c: Conn, timeoutMs: number): Promise<{ ok: boolean; why?: string }> {
	const deadline = Date.now() + timeoutMs;
	let off = c.buf.length;
	c.sock.write("\r");
	let lastPoke = Date.now();
	while (Date.now() < deadline) {
		const tail = c.buf.slice(off);
		if (tail.includes(PROMPT)) return { ok: true };
		if (tail.includes("Login:")) {
			off = c.buf.length;
			c.sock.write("admin\r");
			if (!(await waitFor(c, (b) => b.slice(off).includes("Password:"), 10_000))) return { ok: false, why: "no-password-prompt" };
			off = c.buf.length;
			c.sock.write("\r");
			continue;
		}
		if (tail.includes("[Y/n]")) {
			off = c.buf.length;
			c.sock.write("n\r");
			continue;
		}
		if (tail.includes("new password>")) {
			off = c.buf.length;
			c.sock.write("\x03");
			continue;
		}
		if (c.closed) return { ok: false, why: "closed" };
		if (Date.now() - lastPoke > 2000) {
			c.sock.write("\r");
			lastPoke = Date.now();
		}
		await Bun.sleep(50);
	}
	return { ok: false, why: `login-timeout; tail=${JSON.stringify(stripAnsi(c.buf.slice(-400)))}` };
}

/** Serial: run one command, framed by a guest-assembled sentinel (as consoleExec does). */
async function serialExec(c: Conn, cmd: string, timeoutMs: number): Promise<{ ok: boolean; out: string; why?: string }> {
	const nonce = Math.random().toString(36).slice(2, 8);
	const marker = `QC${nonce}END`;
	const off = c.buf.length;
	c.sock.write(`${cmd}\r:put ("QC" . "${nonce}" . "END")\r`);
	if (!(await waitFor(c, (b) => b.slice(off).includes(marker), timeoutMs))) {
		return { ok: false, out: stripAnsi(c.buf.slice(off)).slice(-200), why: c.closed ? "closed" : "no-sentinel" };
	}
	const raw = stripAnsi(c.buf.slice(off, c.buf.indexOf(marker, off)));
	const lines = raw
		.split(/\r?\n|\r/)
		.map((l) => l.trim())
		.filter((l) => l && !l.includes(PROMPT.trim()) && !l.includes(nonce) && !l.startsWith(cmd.slice(0, 10)));
	return { ok: true, out: lines.join("\n") };
}

/** QGA: sync + ping on a fresh connection; any `{"return"` back counts as a reply. */
async function qgaPing(c: Conn, timeoutMs: number): Promise<{ ok: boolean; out: string; why?: string }> {
	const id = Math.floor(Math.random() * 1e9);
	c.sock.write(`${JSON.stringify({ execute: "guest-sync-delimited", arguments: { id } })}\n`);
	c.sock.write(`${JSON.stringify({ execute: "guest-ping" })}\n`);
	const got = await waitFor(c, (b) => b.includes('"return"'), timeoutMs);
	return got
		? { ok: true, out: c.buf.replace(/\xff/g, "").trim().slice(0, 200) }
		: { ok: false, out: c.buf.slice(0, 200), why: c.closed ? "closed" : "no-reply" };
}

// ── results ─────────────────────────────────────────────────────────────────
interface Trial {
	i: number;
	connectMs: number;
	connectErr?: string;
	ok: boolean;
	totalMs: number;
	/** connect → reply received, excluding the client's close. */
	cmdMs?: number;
	why?: string;
	out?: string;
}

interface ChannelResult {
	channel: Channel;
	machine: string;
	trials: Trial[];
}

const results: {
	arm: Arm;
	env: Record<string, string>;
	machines: { name: string; portBase: number; argv: string[]; pid?: number; exit?: Machine["exit"] }[];
	notes: string[];
	phase0: unknown[];
	held: Record<string, unknown>;
	concurrent: Record<string, unknown>;
	channels: ChannelResult[];
	liveness: Record<string, unknown>;
	duplicateName?: unknown;
	crossCheck?: unknown;
	sunPath?: { channelPaths: Record<string, { path: string; bytes: number }>; sweep: SweepResult[] };
} = {
	arm: ARM,
	env: {},
	machines: [],
	notes: [],
	phase0: [],
	held: {},
	concurrent: {},
	channels: [],
	liveness: {},
};

function note(msg: string): void {
	log(`NOTE ${msg}`);
	results.notes.push(msg);
}

// ── helpers ─────────────────────────────────────────────────────────────────
function listPipes(prefix: string): string[] {
	if (!isWin) return [];
	try {
		return readdirSync("\\\\.\\pipe\\").filter((n) => n.startsWith(prefix)).sort();
	} catch (e) {
		return [`<readdir failed: ${(e as Error).message}>`];
	}
}

function alive(m: Machine): boolean {
	if (m.exit || !m.pid) return false;
	try {
		process.kill(m.pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function restIdentity(m: Machine, timeoutMs = 20_000): Promise<string> {
	try {
		const r = await fetch(`http://127.0.0.1:${m.portBase}/rest/system/identity`, {
			headers: { Authorization: `Basic ${btoa("admin:")}` },
			signal: AbortSignal.timeout(timeoutMs),
		});
		return `HTTP ${r.status} ${(await r.text()).slice(0, 120)}`;
	} catch (e) {
		return `error: ${(e as Error).message}`;
	}
}

function tcpListening(port: number): Promise<boolean> {
	return new Promise((res) => {
		const s = connect(port, "127.0.0.1");
		const t = setTimeout(() => {
			s.destroy();
			res(false);
		}, 1000);
		s.once("connect", () => {
			clearTimeout(t);
			s.destroy();
			res(true);
		});
		s.once("error", () => {
			clearTimeout(t);
			res(false);
		});
	});
}

function spawnMachine(m: Machine, disk: string): void {
	m.argv = buildArgv(m, disk);
	const logFd = openSync(join(m.dir, "qemu.log"), "a");
	const [bin, ...rest] = m.argv;
	const proc = spawn(bin as string, rest, { stdio: ["ignore", logFd, logFd], windowsHide: true });
	m.proc = proc;
	if (proc.pid !== undefined) m.pid = proc.pid;
	proc.on("exit", (code, signal) => {
		m.exit = { code, signal, atMs: Date.now() - T0 };
		log(`${m.name}: QEMU exited code=${code} signal=${signal}`);
	});
	proc.on("error", (e) => note(`${m.name}: spawn error ${e.message}`));
	log(`${m.name}: spawned pid=${m.pid}: ${m.argv.join(" ")}`);
}

/** Connect with retries until the endpoint exists — the pipe for chardev N only
 *  appears once chardev N-1 has a client (see REPORT), so a single attempt is
 *  not a fair first connect. */
async function connectHeld(m: Machine, ch: Channel, budgetMs: number): Promise<{ conn?: Conn; attempts: number; ms: number; lastErr?: string }> {
	const started = Date.now();
	let attempts = 0;
	let lastErr: string | undefined;
	while (Date.now() - started < budgetMs) {
		attempts++;
		const r = await openConn(endpoint(m, ch), 3000);
		if (r.conn) return { conn: r.conn, attempts, ms: Date.now() - started };
		lastErr = r.err;
		if (m.exit) break;
		await Bun.sleep(200);
	}
	return { attempts, ms: Date.now() - started, ...(lastErr ? { lastErr } : {}) };
}

// ── per-channel trial ───────────────────────────────────────────────────────
async function trial(m: Machine, ch: Channel, i: number): Promise<Trial> {
	const started = Date.now();
	const r = await openConn(endpoint(m, ch));
	if (!r.conn) {
		return { i, connectMs: r.ms, ...(r.err ? { connectErr: r.err } : {}), ok: false, totalMs: Date.now() - started, why: "connect" };
	}
	const c = r.conn;
	let res: { ok: boolean; out: string; why?: string } = { ok: false, out: "" };
	let cmdMs = 0;
	try {
		if (ch === "monitor") {
			res = await monitorCmd(c, "info status", 5000);
			if (res.ok && !res.out.includes("running")) res = { ...res, ok: false, why: "not-running" };
		} else if (ch === "serial") {
			const l = await serialLogin(c, 30_000);
			if (!l.ok) res = { ok: false, out: stripAnsi(c.buf).slice(-200), why: l.why ?? "login" };
			else {
				res = await serialExec(c, ":put [/system identity get name]", 15_000);
				if (res.ok && !res.out.replace(/\s+/g, "").includes(identityOf(m))) res = { ...res, ok: false, why: "wrong-identity" };
			}
		} else {
			res = await qgaPing(c, 3000);
		}
		cmdMs = Date.now() - started;
	} finally {
		await closeConn(c);
	}
	return {
		i,
		connectMs: r.ms,
		ok: res.ok,
		totalMs: Date.now() - started,
		cmdMs,
		...(res.why ? { why: res.why } : {}),
		...(res.ok ? {} : { out: res.out }),
	};
}

function summarize(trials: Trial[]): string {
	const ok = trials.filter((t) => t.ok).length;
	const connFail = trials.filter((t) => t.why === "connect").length;
	const okMs = trials.filter((t) => t.ok).map((t) => t.cmdMs ?? t.totalMs).sort((a, b) => a - b);
	const p = (q: number) => (okMs.length ? okMs[Math.min(okMs.length - 1, Math.floor(q * okMs.length))] : NaN);
	const reasons = new Map<string, number>();
	for (const t of trials.filter((t) => !t.ok)) {
		const k = t.why === "connect" ? `connect: ${t.connectErr}` : (t.why ?? "?");
		reasons.set(k, (reasons.get(k) ?? 0) + 1);
	}
	return `${ok}/${trials.length} ok, ${connFail} connect failures, cmd-latency p50=${p(0.5)}ms p95=${p(0.95)}ms max=${okMs.at(-1) ?? NaN}ms; failures: ${[...reasons].map(([k, v]) => `${v}× ${k}`).join("; ") || "none"}`;
}

/** A second client on each channel while `held` (one client per channel) is
 *  still connected, then whether the held client still works. */
async function concurrentPhase(m0: Machine, held: Map<string, Conn>): Promise<void> {
	for (const ch of CHANNELS) {
		const r = await openConn(endpoint(m0, ch), CONNECT_TIMEOUT_MS);
		let bytes = "";
		if (r.conn) {
			r.conn.sock.write(ch === "qga" ? '{"execute":"guest-ping"}\n' : ch === "serial" ? "\r" : "\n");
			await Bun.sleep(2000);
			bytes = r.conn.buf.slice(0, 120);
			await closeConn(r.conn);
		}
		const h = held.get(`${m0.name}/${ch}`);
		let heldStillWorks: unknown = null;
		if (h && ch === "monitor") heldStillWorks = await monitorCmd(h, "info status", 10_000);
		if (h && ch === "serial") heldStillWorks = await serialExec(h, ":put [/system identity get name]", 30_000);
		results.concurrent[ch] = { heldConnected: !!h, connected: !!r.conn, connectMs: r.ms, err: r.err ?? null, secondClientGot: bytes, heldStillWorks };
		log(`concurrent ${ch}: held=${!!h} second client connected=${!!r.conn} err=${r.err ?? "-"} got=${JSON.stringify(bytes)}`);
	}
}

// ── sun_path sweep (unix) ───────────────────────────────────────────────────
interface SweepResult {
	bytes: number;
	path: string;
	/** QEMU still running after the wait, i.e. it accepted the chardev path. */
	qemuUp: boolean;
	exit?: number | null;
	output: string;
	socketFileExists: boolean;
	connect: string;
	monitor?: string;
}

/** A path of exactly `bytes` bytes (ASCII, so bytes = chars) under `base`. */
function pathOfLength(base: string, bytes: number): string {
	const fixed = join(base, "x", "m.sock");
	const pad = bytes - Buffer.byteLength(fixed) + 1;
	if (pad < 1) throw new Error(`--work is too long for a ${bytes}-byte sweep path`);
	return join(base, "p".repeat(pad), "m.sock");
}

async function sunPathSweep(): Promise<SweepResult[]> {
	const base = join(WORK, "sweep");
	const out: SweepResult[] = [];
	for (const bytes of SWEEP) {
		const path = pathOfLength(base, bytes);
		mkdirSync(join(path, ".."), { recursive: true });
		const argv = ["-M", "none", "-display", "none", "-nodefaults", "-chardev", `socket,id=m0,path=${path},server=on,wait=off`, "-mon", "chardev=m0,mode=readline"];
		const proc = spawn(QEMU, argv, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let output = "";
		proc.stdout?.on("data", (d: Buffer) => (output += d.toString()));
		proc.stderr?.on("data", (d: Buffer) => (output += d.toString()));
		let exit: number | null | undefined;
		proc.on("exit", (code) => (exit = code));
		await Bun.sleep(3000);
		const r: SweepResult = { bytes: Buffer.byteLength(path), path, qemuUp: exit === undefined, output: "", socketFileExists: existsSync(path), connect: "-" };
		if (exit !== undefined) r.exit = exit;
		const c = await openConn({ kind: "path", path }, 3000);
		r.connect = c.conn ? "ok" : (c.err ?? "?");
		if (c.conn) {
			const m = await monitorCmd(c.conn, "info version", 3000);
			r.monitor = m.ok ? m.out.trim() : `fail: ${m.why}`;
			await closeConn(c.conn);
		}
		if (exit === undefined) proc.kill();
		await Bun.sleep(300);
		r.output = output
			.split(/\r?\n/)
			.filter((l) => l.trim() && !l.includes("is deprecated"))
			.join(" ")
			.slice(0, 300);
		out.push(r);
		log(`sun_path sweep ${JSON.stringify(r)}`);
	}
	return out;
}

// ── main ────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
	mkdirSync(WORK, { recursive: true });
	const qv = spawnSync(QEMU, ["--version"], { encoding: "utf8" });
	results.env = {
		platform: `${process.platform} ${process.arch}`,
		osRelease: os.release(),
		osVersion: typeof os.version === "function" ? os.version() : "?",
		bun: Bun.version,
		qemu: (qv.stdout || qv.stderr || String(qv.error)).split("\n")[0]?.trim() ?? "?",
		accel: ACCEL,
		runnerImage: `${process.env.ImageOS ?? "?"} ${process.env.ImageVersion ?? ""}`.trim(),
		cpus: String(os.cpus().length),
	};
	log(`env ${JSON.stringify(results.env)}`);

	const version = process.env.CHR_VERSION || (await resolveVersion("stable"));
	results.env.routeros = version;
	const img = await ensureCachedImage(version, "x86", join(WORK, "cache"));
	log(`image ${img}`);

	const sweep = SWEEP.length ? await sunPathSweep() : [];
	let name = NAME_ARG;
	if (MONITOR_PATH_BYTES === "max") {
		const best = Math.max(...sweep.filter((r) => r.qemuUp && r.monitor && !r.monitor.startsWith("fail")).map((r) => r.bytes));
		if (!Number.isFinite(best)) throw new Error("no --sun-path-sweep length worked; nothing to run at the limit");
		name = nameForMonitorPath(best);
	} else if (MONITOR_PATH_BYTES) {
		name = nameForMonitorPath(Number(MONITOR_PATH_BYTES));
	}

	const tag = Date.now().toString(36).slice(-4);
	const names = ARM === "pipe" ? [`lab-a-${tag}`, `lab-b-${tag}`] : [name || `lab-${ARM}-${tag}`];
	const machines: Machine[] = names.map((name, k) => {
		const dir = join(WORK, name);
		mkdirSync(dir, { recursive: true });
		return { name, dir, portBase: 9300 + k * 10, argv: [] };
	});

	if (ARM === "unix") {
		const channelPaths: Record<string, { path: string; bytes: number }> = {};
		for (const ch of CHANNELS) {
			const ep = endpoint(machines[0] as Machine, ch);
			if (ep.kind === "path") channelPaths[ch] = { path: ep.path, bytes: Buffer.byteLength(ep.path) };
		}
		results.sunPath = { channelPaths, sweep };
		log(`channel socket paths ${JSON.stringify(channelPaths)}`);
	}

	try {
		// ── phase 0: spawn, and (pipe) watch what QEMU does with no client ──
		for (const m of machines) {
			const disk = join(m.dir, "disk.img");
			copyFileSync(img, disk);
			spawnMachine(m, disk);
		}
		if (ARM === "pipe") {
			for (let s = 0; s <= 10; s += 2) {
				for (const m of machines) {
					const snap = {
						atS: s,
						machine: m.name,
						alive: alive(m),
						pipes: listPipes(`quickchr-${m.name}-`),
						hostfwdListening: await tcpListening(m.portBase),
					};
					results.phase0.push(snap);
					log(`phase0 ${JSON.stringify(snap)}`);
				}
				if (s < 10) await Bun.sleep(2000);
			}
		}

		// ── phase 1: held clients, boot ──
		const held = new Map<string, Conn>();
		await Promise.all(
			machines.map(async (m) => {
				for (const ch of CHANNELS) {
					const h = await connectHeld(m, ch, 60_000);
					const key = `${m.name}/${ch}`;
					results.held[`${key}/connect`] = { attempts: h.attempts, ms: h.ms, lastErr: h.lastErr ?? null, connected: !!h.conn };
					log(`held ${key}: connected=${!!h.conn} attempts=${h.attempts} ms=${h.ms} lastErr=${h.lastErr ?? "-"}`);
					if (h.conn) held.set(key, h.conn);
					if (ARM === "pipe") log(`  pipes now: ${listPipes(`quickchr-${m.name}-`).join(", ")}`);
				}
				if (ARM === "pipe") results.held[`${m.name}/hostfwdListeningAfterAllHeld`] = await tcpListening(m.portBase);
			}),
		);

		await Promise.all(
			machines.map(async (m) => {
				const mon = held.get(`${m.name}/monitor`);
				if (mon) {
					const n = await monitorCmd(mon, "info name", 10_000);
					const s = await monitorCmd(mon, "info status", 10_000);
					results.held[`${m.name}/monitor`] = { infoName: n, infoStatus: s };
					log(`held ${m.name}/monitor: info name → ${n.out} | info status → ${s.out}`);
				}
				const ser = held.get(`${m.name}/serial`);
				if (ser) {
					const bootStart = Date.now();
					const booted = await waitFor(ser, (b) => b.includes("Login:"), BOOT_BUDGET_MS);
					const bootMs = Date.now() - bootStart;
					log(`held ${m.name}/serial: Login: seen=${booted} after ${bootMs}ms`);
					const login = booted ? await serialLogin(ser, 300_000) : { ok: false, why: "no-boot" };
					const set = login.ok ? await serialExec(ser, `/system identity set name=${identityOf(m)}`, 30_000) : null;
					const get = login.ok ? await serialExec(ser, ":put [/system identity get name]", 30_000) : null;
					results.held[`${m.name}/serial`] = { booted, bootMs, login, set, get };
					log(`held ${m.name}/serial: login=${login.ok} identity → ${get?.out}`);
				}
				const qga = held.get(`${m.name}/qga`);
				if (qga) {
					const p = await qgaPing(qga, 10_000);
					results.held[`${m.name}/qga`] = p;
					log(`held ${m.name}/qga: ping ok=${p.ok} ${p.why ?? ""}`);
				}
				results.liveness[`${m.name}/restAfterBoot`] = await restIdentity(m);
				log(`${m.name}: REST after boot → ${results.liveness[`${m.name}/restAfterBoot`]}`);
			}),
		);

		// ── phase 2: a second client while the held one is still connected ──
		// pipe: here, on the boot-time clients (the only ones a pipe ever gets).
		// tcp/unix: after the trials, so this step cannot disturb them (run 1
		// had it here and QGA refused every later connect on both arms).
		const m0 = machines[0] as Machine;
		if (ARM === "pipe") await concurrentPhase(m0, held);

		// ── phase 3: close the held clients, then N fresh trials per channel ──
		for (const c of held.values()) await closeConn(c);
		log("held clients closed");
		await Bun.sleep(1000);
		for (const m of machines) results.liveness[`${m.name}/aliveAfterHeldClose`] = alive(m);

		if (ARM === "pipe" && isWin) {
			// Independent client: .NET NamedPipeClientStream, to separate a Bun
			// client quirk from QEMU's server behaviour.
			const ps = `$p=New-Object System.IO.Pipes.NamedPipeClientStream('.','${pipeName(m0, "monitor")}',[System.IO.Pipes.PipeDirection]::InOut); try { $p.Connect(3000); 'connected'; $b=New-Object byte[] 256; $t=$p.ReadAsync($b,0,256); if ($t.Wait(3000)) { 'read ' + $t.Result + ': ' + [Text.Encoding]::ASCII.GetString($b,0,$t.Result) } else { 'no-data' } } catch { 'ERR: ' + $_.Exception.GetType().Name + ': ' + $_.Exception.Message } finally { $p.Dispose() }`;
			const out: string[] = [];
			for (let k = 0; k < 3; k++) {
				const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8", timeout: 20_000 });
				out.push((r.stdout + r.stderr).trim().replace(/\s+/g, " "));
			}
			results.crossCheck = { client: ".NET NamedPipeClientStream, monitor pipe, after held close", attempts: out };
			log(`crossCheck ${JSON.stringify(out)}`);
		}

		for (const ch of CHANNELS) {
			const trials: Trial[] = [];
			for (let i = 1; i <= TRIALS; i++) {
				const t = await trial(m0, ch, i);
				trials.push(t);
				if (i <= 3 || !t.ok || i % 10 === 0) log(`trial ${m0.name}/${ch} #${i}: ${JSON.stringify(t)}`);
				await Bun.sleep(100);
			}
			results.channels.push({ channel: ch, machine: m0.name, trials });
			log(`SUMMARY ${m0.name}/${ch}: ${summarize(trials)}`);
		}
		// Second machine: a shorter monitor run, enough to show it is independent.
		for (const m of machines.slice(1)) {
			const trials: Trial[] = [];
			for (let i = 1; i <= 10; i++) trials.push(await trial(m, "monitor", i));
			results.channels.push({ channel: "monitor", machine: m.name, trials });
			log(`SUMMARY ${m.name}/monitor: ${summarize(trials)}`);
		}

		if (ARM === "pipe") {
			// Longer than libuv's 30 s WaitNamedPipe on ERROR_PIPE_BUSY, so a
			// slow-to-rearm pipe is not mistaken for a dead one.
			const long: unknown[] = [];
			for (let k = 0; k < 2; k++) {
				const r = await openConn(endpoint(m0, "monitor"), 40_000);
				long.push({ connected: !!r.conn, ms: r.ms, err: r.err ?? null });
				await closeConn(r.conn);
			}
			results.liveness.pipeLongTimeoutReconnects = long;
			log(`long-timeout monitor reconnects ${JSON.stringify(long)}`);
		} else {
			const fresh = new Map<string, Conn>();
			for (const ch of CHANNELS) {
				const r = await openConn(endpoint(m0, ch));
				if (r.conn) fresh.set(`${m0.name}/${ch}`, r.conn);
			}
			await concurrentPhase(m0, fresh);
			for (const c of fresh.values()) await closeConn(c);
			// And does each channel still take a fresh client after that?
			const after: Record<string, unknown> = {};
			for (const ch of CHANNELS) after[ch] = await trial(m0, ch, 0);
			results.liveness.trialAfterConcurrent = after;
			log(`trial after concurrent ${JSON.stringify(after)}`);
		}

		// ── duplicate pipe name (pipe only) ──
		if (ARM === "pipe") {
			const dupArgv = ["-M", "none", "-display", "none", "-chardev", `pipe,id=dup0,path=${pipeName(m0, "monitor")}`, "-mon", "chardev=dup0,mode=readline"];
			const started = Date.now();
			const r = spawnSync(QEMU, dupArgv, { encoding: "utf8", timeout: 15_000 });
			results.duplicateName = {
				argv: [QEMU, ...dupArgv].join(" "),
				status: r.status,
				signal: r.signal,
				timedOut: r.error ? String(r.error) : null,
				ms: Date.now() - started,
				output: (r.stdout + r.stderr).trim().slice(0, 400),
			};
			log(`duplicateName ${JSON.stringify(results.duplicateName)}`);
		}

		// ── phase 4: liveness ──
		for (const m of machines) {
			results.liveness[`${m.name}/aliveAtEnd`] = alive(m);
			results.liveness[`${m.name}/restAtEnd`] = await restIdentity(m);
			log(`${m.name}: alive=${alive(m)} REST at end → ${results.liveness[`${m.name}/restAtEnd`]}`);
		}
	} finally {
		for (const m of machines) {
			results.machines.push({ name: m.name, portBase: m.portBase, argv: m.argv, ...(m.pid ? { pid: m.pid } : {}), ...(m.exit ? { exit: m.exit } : {}) });
			if (m.proc && !m.exit) m.proc.kill();
		}
		const outPath = join(WORK, `results-${ARM}.json`);
		writeFileSync(outPath, JSON.stringify(results, null, 2));
		log(`wrote ${outPath}`);
		writeSummary();
	}
}

function writeSummary(): void {
	const lines: string[] = [];
	lines.push(`## windows-pipe-chardev — arm \`${ARM}\``, "");
	lines.push("```text", ...Object.entries(results.env).map(([k, v]) => `${k}: ${v}`), "```", "");
	if (results.machines[0]) lines.push("argv:", "```text", results.machines[0].argv.join(" "), "```", "");
	lines.push("| machine | channel | result |", "|---|---|---|");
	for (const c of results.channels) lines.push(`| ${c.machine} | ${c.channel} | ${summarize(c.trials)} |`);
	if (results.sunPath) {
		lines.push("", "Channel socket paths:", "", "| channel | bytes | path |", "|---|---|---|");
		for (const [ch, p] of Object.entries(results.sunPath.channelPaths)) lines.push(`| ${ch} | ${p.bytes} | \`${p.path}\` |`);
		if (results.sunPath.sweep.length) {
			lines.push("", "`sun_path` sweep (bare QEMU, monitor socket only):", "", "| bytes | QEMU up | socket file | connect | monitor / QEMU output |", "|---|---|---|---|---|");
			for (const r of results.sunPath.sweep) {
				const detail = (r.monitor ?? r.output).replace(/\s+/g, " ").replace(/\|/g, "\\|").slice(0, 160);
				lines.push(`| ${r.bytes} | ${r.qemuUp ? "yes" : `no (exit ${r.exit})`} | ${r.socketFileExists ? "yes" : "no"} | ${r.connect} | ${detail} |`);
			}
		}
	}
	lines.push("", "<details><summary>phase0 / held / concurrent / liveness / duplicate / crossCheck</summary>", "", "```json");
	lines.push(JSON.stringify({ notes: results.notes, phase0: results.phase0, held: results.held, concurrent: results.concurrent, liveness: results.liveness, duplicateName: results.duplicateName, crossCheck: results.crossCheck }, null, 2));
	lines.push("```", "", "</details>", "");
	const text = lines.join("\n");
	console.log(text);
	if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

const hardCap = setTimeout(() => {
	note("hard cap reached — writing partial results");
	writeSummary();
	writeFileSync(join(WORK, `results-${ARM}.json`), JSON.stringify(results, null, 2));
	process.exit(2);
}, Number(arg("hard-cap-ms", "3000000")));

main()
	.then(() => {
		clearTimeout(hardCap);
		process.exit(0);
	})
	.catch((e) => {
		console.error(e);
		results.notes.push(`fatal: ${(e as Error).stack ?? e}`);
		try {
			writeFileSync(join(WORK, `results-${ARM}.json`), JSON.stringify(results, null, 2));
		} catch {
			/* ignore */
		}
		process.exit(1);
	});

