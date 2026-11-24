/**
 * download-origin probe (#146): is `cdn.mikrotik.com` the same artifact origin as
 * `download.mikrotik.com`, and does it behave the same?
 *
 * Grounding only. Nothing in quickchr's download path changes; the probe imports
 * `resolveVersion()` and the URL builders from `src/lib/versions.ts` so channels
 * and paths are resolved exactly as quickchr resolves them, then swaps the host.
 *
 * Bandwidth is bounded on purpose:
 *   - metadata is HEAD + a 1-byte range + the 1-line `.sha256` file;
 *   - full artifacts are downloaded (from BOTH hosts) only while they fit inside
 *     `--full-budget-mb`; artifacts past the budget are compared by hashing three
 *     1 MiB windows (start / middle / end) on both hosts instead;
 *   - timing trials are `--rounds` paired byte ranges of `--range-mib` each.
 *
 * Host order alternates per artifact and per round (A,B then B,A) so a warm path
 * or a jittery minute is spread over both hosts rather than charged to one.
 *
 * Usage:
 *   bun test/lab/download-origin/probe.ts run   [--label=local] [--full-budget-mb=1200]
 *        [--rounds=8] [--range-mib=8] [--arches=x86,arm64] [--versions=7.20.8]
 *        [--out=test/lab/download-origin/results]
 *   bun test/lab/download-origin/probe.ts watch [--interval-s=60] [--duration-min=720]
 *        [--expect=7.26beta6,7.25.2] [--out=...]
 *
 * `watch` is the release-boundary freshness observer: it polls the channel files
 * and the expected versions' x86 CHR image + `.sha256` on both hosts and records,
 * per host, the first poll at which each item was served successfully (a validated
 * 1-byte 206 for the image, a parsed 64-hex SHA-256 for `.sha256`). Timestamps are
 * only as precise as `--interval-s`. See REPORT.md "Freshness".
 *
 * Every flag is validated against fixed limits before the first request; a
 * malformed or out-of-range value exits 2.
 */

import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { promises as dns } from "node:dns";
import { join } from "node:path";
import * as tls from "node:tls";
import { CHANNELS } from "../../../src/lib/types.ts";
import type { Arch, Channel } from "../../../src/lib/types.ts";
import { chrDownloadUrl, packagesDownloadUrl, resolveVersion } from "../../../src/lib/versions.ts";

const HOSTS = ["download.mikrotik.com", "cdn.mikrotik.com"] as const;
type Host = (typeof HOSTS)[number];
// Generic client name: no account, person or project details go to MikroTik.
const USER_AGENT = "routeros-download-origin-probe/1";
const MIB = 1024 * 1024;

// ── args ──────────────────────────────────────────────────────────────────────

// Every argument is validated before the first request: a malformed or
// out-of-range value exits 2 instead of silently falling back to a default
// (a typo in --rounds or --full-budget-mb must not turn into gigabytes).

function usageError(message: string): never {
	console.error(`[probe] ${message}`);
	process.exit(2);
}

const KNOWN_FLAGS: Record<string, readonly string[]> = {
	run: ["label", "out", "stall-ms", "idle-abort-ms", "full-budget-mb", "rounds", "range-mib", "arches", "versions"],
	watch: ["label", "out", "stall-ms", "idle-abort-ms", "interval-s", "duration-min", "expect"],
};

const [mode = "run", ...rest] = process.argv.slice(2);
const known = KNOWN_FLAGS[mode];
if (!known) usageError(`unknown mode "${mode}" (expected run | watch)`);
const args = new Map<string, string>();
for (const a of rest) {
	const m = a.match(/^--([a-z0-9-]+)=(.*)$/);
	if (m?.[1] === undefined || m[2] === undefined) usageError(`malformed argument "${a}" (expected --name=value)`);
	if (!known.includes(m[1])) usageError(`unknown flag --${m[1]} for mode "${mode}"`);
	if (args.has(m[1])) usageError(`--${m[1]} given twice`);
	args.set(m[1], m[2]);
}
const arg = (k: string, d: string) => args.get(k) ?? d;
/** Integer flag in [min, max]. Absent → default; present but malformed or out of range → exit 2. */
const int = (k: string, d: number, min: number, max: number): number => {
	const raw = args.get(k);
	if (raw === undefined) return d;
	if (!/^\d+$/.test(raw)) usageError(`--${k}=${raw}: expected a whole number in ${min}..${max}`);
	const v = Number(raw);
	if (!Number.isSafeInteger(v) || v < min || v > max) usageError(`--${k}=${raw}: out of range ${min}..${max}`);
	return v;
};
const list = (k: string, d: string, valid: RegExp) => {
	const items = arg(k, d)
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	for (const s of items) if (!valid.test(s)) usageError(`--${k}: invalid item "${s}"`);
	return items;
};
const VERSION_RE = /^\d+\.\d+(\.\d+)?((alpha|beta|rc)\d+)?$/;

const LABEL = arg("label", process.env.PROBE_LABEL ?? "local");
if (!/^[A-Za-z0-9._-]{1,64}$/.test(LABEL)) usageError(`label "${LABEL}": use 1-64 of [A-Za-z0-9._-]`);
const OUT_DIR = arg("out", join(import.meta.dir, "results"));
const STALL_MS = int("stall-ms", 5000, 100, 600_000);
const IDLE_ABORT_MS = int("idle-abort-ms", 60_000, 1000, 600_000);

// Mode-specific limits, also parsed here so nothing is requested before they pass.
const RUN = {
	fullBudgetBytes: int("full-budget-mb", 1200, 0, 20_000) * 1e6,
	rounds: int("rounds", 8, 0, 200),
	rangeBytes: int("range-mib", 8, 1, 256) * MIB,
	arches: list("arches", "x86,arm64", /^(x86|arm64)$/) as Arch[],
	extraVersions: list("versions", "", VERSION_RE),
};
const WATCH = {
	intervalMs: int("interval-s", 60, 10, 3600) * 1000,
	durationMs: int("duration-min", 720, 1, 20_160) * 60_000,
	expect: list("expect", "", VERSION_RE),
};

// ── helpers ───────────────────────────────────────────────────────────────────

const nowIso = () => new Date().toISOString();

function hostUrl(officialUrl: string, host: Host): string {
	const u = new URL(officialUrl);
	u.hostname = host;
	return u.toString();
}

type ErrorClass = "dns" | "connect" | "tls" | "timeout" | "idle-abort" | "reset" | "http" | "protocol" | "other";

function classify(err: unknown): { class: ErrorClass; message: string } {
	const e = err as { code?: string; name?: string; message?: string };
	const message = `${e?.name ?? "Error"}${e?.code ? `(${e.code})` : ""}: ${e?.message ?? String(err)}`;
	const s = `${e?.code ?? ""} ${e?.name ?? ""} ${e?.message ?? ""}`;
	if (/PROTOCOL:/.test(s)) return { class: "protocol", message };
	if (/IDLE_ABORT/.test(s)) return { class: "idle-abort", message };
	if (/Timeout|TimeoutError|ETIMEDOUT/i.test(s)) return { class: "timeout", message };
	if (/ENOTFOUND|EAI_AGAIN|DNS|getaddrinfo/i.test(s)) return { class: "dns", message };
	if (/CERT|TLS|SSL|certificate/i.test(s)) return { class: "tls", message };
	if (/ECONNREFUSED|ConnectionRefused|EHOSTUNREACH|ENETUNREACH|FailedToOpenSocket/i.test(s))
		return { class: "connect", message };
	if (/ECONNRESET|ConnectionClosed|socket|closed|EPIPE/i.test(s)) return { class: "reset", message };
	return { class: "other", message };
}

const KEEP_HEADERS = [
	"content-length",
	"content-type",
	"content-range",
	"accept-ranges",
	"etag",
	"last-modified",
	"cache-control",
	"age",
	"server",
	"via",
	"x-cache",
	"x-ratelimit-limit",
	"x-ratelimit-remaining",
	"date",
] as const;

function pickHeaders(h: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	for (const k of KEEP_HEADERS) {
		const v = h.get(k);
		if (v !== null) out[k] = v;
	}
	return out;
}

async function request(
	url: string,
	init: { method?: string; range?: string; timeoutMs?: number } = {},
): Promise<Response> {
	const headers: Record<string, string> = { "User-Agent": USER_AGENT, "Accept-Encoding": "identity" };
	if (init.range) headers.Range = init.range;
	// Bare fetch(), not fetchResilient() (src/lib/net.ts), on purpose: the hosts'
	// own DNS, connect and TLS behaviour is what this probe measures. The resilient
	// wrapper retries a failed connect over a public-DNS IPv4 literal, which would
	// turn exactly the failure being looked for into a silent success.
	return fetch(url, {
		method: init.method ?? "GET",
		headers,
		// Fresh connection per request: every trial pays DNS+TCP+TLS the way a
		// one-shot `quickchr` download does, instead of riding a warm pool.
		keepalive: false,
		signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
	});
}

/** A byte range plus the full size it is cut from, so `Content-Range` can be checked exactly. */
interface ByteRange {
	start: number;
	end: number; // inclusive
	total: number;
}
const rangeHeader = (r: ByteRange) => `bytes=${r.start}-${r.end}`;
const contentRange = (r: ByteRange) => `bytes ${r.start}-${r.end}/${r.total}`;

/**
 * Checks a ranged response before any body byte is read: it must be 206 with exactly
 * the requested `Content-Range`. A server that ignores `Range` answers 200 with the
 * whole artifact, which must be cancelled, not buffered. Returns an error or undefined.
 */
function checkRanged(res: Response, r: ByteRange): string | undefined {
	if (res.status !== 206) return `PROTOCOL: expected 206 for ${rangeHeader(r)}, got ${res.status}`;
	const cr = res.headers.get("content-range");
	if (cr !== contentRange(r)) return `PROTOCOL: Content-Range "${cr}" != "${contentRange(r)}"`;
	const cl = res.headers.get("content-length");
	if (cl !== null && Number(cl) !== r.end - r.start + 1)
		return `PROTOCOL: Content-Length ${cl} != ${r.end - r.start + 1}`;
	return undefined;
}

/** Reads a small body, cancelling the stream as soon as it exceeds `max` bytes. */
async function readCapped(res: Response, max: number): Promise<Uint8Array> {
	if (!res.body) return new Uint8Array();
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let n = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		n += value.byteLength;
		if (n > max) {
			await reader.cancel();
			throw new Error(`PROTOCOL: body exceeds ${max} bytes`);
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks);
}

/** First 64-hex SHA-256 in a `.sha256` body, lowercased; undefined when there is none. */
const parseSha256 = (text: string) => text.trim().match(/^[0-9a-f]{64}(?=\s|$)/i)?.[0]?.toLowerCase();

interface Transfer {
	host: Host;
	url: string;
	kind: "full" | "range" | "window";
	range?: string | undefined;
	position: number; // 0 = this host went first in its pair
	startedAt: string;
	status?: number | undefined;
	ttfbMs?: number | undefined;
	totalMs?: number | undefined;
	bytes: number;
	expectedBytes?: number | undefined;
	mbps?: number | undefined; // MB/s (1e6) of body only, after first byte
	maxGapMs: number;
	stalls: number; // gaps > STALL_MS between body chunks
	sha256?: string | undefined;
	error?: { class: ErrorClass; message: string } | undefined;
}

/** Stream a body, hashing as it goes, recording TTFB, gaps and stalls. */
async function transfer(
	host: Host,
	url: string,
	kind: Transfer["kind"],
	position: number,
	opts: { range?: ByteRange; expectedBytes: number; timeoutMs: number },
): Promise<Transfer> {
	const expectedBytes = opts.range ? opts.range.end - opts.range.start + 1 : opts.expectedBytes;
	const t: Transfer = {
		host,
		url,
		kind,
		range: opts.range ? rangeHeader(opts.range) : undefined,
		position,
		startedAt: nowIso(),
		bytes: 0,
		expectedBytes,
		maxGapMs: 0,
		stalls: 0,
	};
	const t0 = performance.now();
	const controller = new AbortController();
	const overall = setTimeout(() => controller.abort(new Error("TimeoutError: overall")), opts.timeoutMs);
	let idle: ReturnType<typeof setTimeout> | undefined;
	const armIdle = () => {
		if (idle) clearTimeout(idle);
		idle = setTimeout(() => controller.abort(new Error("IDLE_ABORT: no bytes")), IDLE_ABORT_MS);
	};
	try {
		const headers: Record<string, string> = { "User-Agent": USER_AGENT, "Accept-Encoding": "identity" };
		if (opts.range) headers.Range = rangeHeader(opts.range);
		armIdle();
		// Bare fetch() for the same reason as request(): the host is the subject.
		const res = await fetch(url, { headers, keepalive: false, signal: controller.signal });
		t.ttfbMs = performance.now() - t0;
		t.status = res.status;
		if (!res.ok || !res.body) {
			t.error = { class: "http", message: `HTTP ${res.status}` };
			await res.body?.cancel();
			return t;
		}
		const cl = res.headers.get("content-length");
		const bad = opts.range
			? checkRanged(res, opts.range)
			: res.status !== 200
				? `PROTOCOL: expected 200, got ${res.status}`
				: cl !== null && Number(cl) !== expectedBytes
					? `PROTOCOL: Content-Length ${cl} != ${expectedBytes}`
					: undefined;
		if (bad) {
			t.error = { class: "protocol", message: bad };
			await res.body.cancel();
			return t;
		}
		const hasher = new Bun.CryptoHasher("sha256");
		const reader = res.body.getReader();
		const firstByteAt = performance.now();
		let last = firstByteAt;
		armIdle();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			const now = performance.now();
			const gap = now - last;
			if (gap > t.maxGapMs) t.maxGapMs = gap;
			if (gap > STALL_MS) t.stalls++;
			last = now;
			t.bytes += value.byteLength;
			if (t.bytes > expectedBytes) {
				await reader.cancel();
				t.error = { class: "protocol", message: `PROTOCOL: body exceeds ${expectedBytes} bytes` };
				t.totalMs = performance.now() - t0;
				return t;
			}
			hasher.update(value);
			armIdle();
		}
		t.totalMs = performance.now() - t0;
		const bodyMs = performance.now() - firstByteAt;
		t.mbps = bodyMs > 0 ? t.bytes / 1e6 / (bodyMs / 1000) : undefined;
		t.sha256 = hasher.digest("hex");
		if (t.bytes !== expectedBytes) {
			t.error = { class: "reset", message: `short body: ${t.bytes}/${expectedBytes}` };
		}
	} catch (err) {
		const reason = controller.signal.aborted ? controller.signal.reason : err;
		t.error = classify(reason);
		t.totalMs = performance.now() - t0;
	} finally {
		clearTimeout(overall);
		if (idle) clearTimeout(idle);
	}
	return t;
}

// ── host identity ─────────────────────────────────────────────────────────────

interface HostIdentity {
	host: Host;
	cname?: string[] | string;
	a?: string[] | string;
	aaaa?: string[] | string;
	tls?: {
		remoteAddress?: string | undefined;
		protocol?: string | null | undefined;
		subject?: string | undefined;
		issuer?: string | undefined;
		san?: string | undefined;
		validFrom?: string | undefined;
		validTo?: string | undefined;
		fingerprint256?: string | undefined;
	};
	tlsError?: string;
}

async function dnsField(fn: () => Promise<string[]>): Promise<string[] | string> {
	try {
		return await fn();
	} catch (e) {
		return (e as { code?: string }).code ?? String(e);
	}
}

function fmtDn(dn: unknown): string {
	if (!dn || typeof dn !== "object") return String(dn);
	return Object.entries(dn as Record<string, string>)
		.map(([k, v]) => `${k}=${v}`)
		.join(", ");
}

async function hostIdentity(host: Host): Promise<HostIdentity> {
	const id: HostIdentity = {
		host,
		cname: await dnsField(() => dns.resolveCname(host)),
		a: await dnsField(() => dns.resolve4(host)),
		aaaa: await dnsField(() => dns.resolve6(host)),
	};
	try {
		id.tls = await new Promise((resolve, reject) => {
			const s = tls.connect({ host, port: 443, servername: host }, () => {
				const c = s.getPeerCertificate();
				resolve({
					remoteAddress: s.remoteAddress,
					protocol: s.getProtocol(),
					subject: fmtDn(c.subject),
					issuer: fmtDn(c.issuer),
					san: c.subjectaltname,
					validFrom: c.valid_from,
					validTo: c.valid_to,
					fingerprint256: c.fingerprint256,
				});
				s.end();
			});
			s.setTimeout(15_000, () => {
				s.destroy();
				reject(new Error("tls timeout"));
			});
			s.on("error", reject);
		});
	} catch (e) {
		id.tlsError = String(e);
	}
	return id;
}

// ── artifacts ─────────────────────────────────────────────────────────────────

interface Artifact {
	version: string;
	channels: Channel[];
	arch: Arch;
	kind: "chr" | "all_packages";
	officialUrl: string;
	file: string;
}

interface HostMeta {
	host: Host;
	head?: { status: number; headers: Record<string, string> } | undefined;
	range?:
		| { status: number; contentRange?: string | undefined; bytes: number; valid: boolean; error?: string | undefined }
		| undefined;
	sha256File?: { status: number; text?: string | undefined; hash?: string | undefined } | undefined;
	error?: { class: ErrorClass; message: string } | undefined;
}

/**
 * A validated 1-byte `Range` GET: 206 with `Content-Range: bytes 0-0/<size>`, body read
 * capped at 1 byte. `size` is the HEAD `Content-Length` when known; otherwise any
 * numeric total is accepted. Anything else is cancelled unread.
 */
async function oneByteRange(url: string, size: number | undefined): Promise<NonNullable<HostMeta["range"]>> {
	const r = await request(url, { range: "bytes=0-0" });
	const cr = r.headers.get("content-range") ?? undefined;
	const total = Number(cr?.match(/^bytes 0-0\/(\d+)$/)?.[1] ?? Number.NaN);
	const bad =
		size !== undefined
			? checkRanged(r, { start: 0, end: 0, total: size })
			: r.status !== 206 || !Number.isSafeInteger(total)
				? `PROTOCOL: expected 206 with Content-Range bytes 0-0/<n>, got ${r.status} "${cr}"`
				: undefined;
	if (bad) {
		await r.body?.cancel();
		return { status: r.status, contentRange: cr, bytes: 0, valid: false, error: bad };
	}
	const body = await readCapped(r, 1);
	return { status: r.status, contentRange: cr, bytes: body.byteLength, valid: body.byteLength === 1 };
}

async function hostMeta(a: Artifact, host: Host): Promise<HostMeta> {
	const url = hostUrl(a.officialUrl, host);
	const m: HostMeta = { host };
	try {
		const h = await request(url, { method: "HEAD" });
		m.head = { status: h.status, headers: pickHeaders(h.headers) };
		const len = Number(m.head.headers["content-length"] ?? Number.NaN);
		m.range = await oneByteRange(url, h.status === 200 && Number.isSafeInteger(len) ? len : undefined);
		const s = await request(`${url}.sha256`);
		const text = s.ok ? new TextDecoder().decode(await readCapped(s, 4096)).trim() : undefined;
		if (!s.ok) await s.body?.cancel();
		m.sha256File = { status: s.status, text, hash: text === undefined ? undefined : parseSha256(text) };
	} catch (e) {
		m.error = classify(e);
	}
	return m;
}

// ── stats ─────────────────────────────────────────────────────────────────────

function quantile(xs: number[], q: number): number | undefined {
	if (xs.length === 0) return undefined;
	const s = [...xs].sort((a, b) => a - b);
	const i = (s.length - 1) * q;
	const lo = Math.floor(i);
	const hi = Math.ceil(i);
	const a = s[lo] ?? 0;
	const b = s[hi] ?? a;
	return a + (b - a) * (i - lo);
}

function stats(xs: number[]) {
	return { n: xs.length, min: quantile(xs, 0), p50: quantile(xs, 0.5), max: quantile(xs, 1) };
}

const f = (x: number | undefined, d = 2) => (x === undefined ? "—" : x.toFixed(d));

// ── run ───────────────────────────────────────────────────────────────────────

async function run() {
	const { fullBudgetBytes: fullBudget, rounds, rangeBytes, arches, extraVersions } = RUN;
	const startedAt = nowIso();
	console.error(`[probe] ${LABEL} started ${startedAt}`);

	// 1. Channels, resolved the way quickchr resolves them.
	const channels: Record<string, string> = {};
	for (const ch of CHANNELS) channels[ch] = await resolveVersion(ch);
	const versions = new Map<string, Channel[]>();
	for (const ch of CHANNELS) {
		const v = channels[ch] as string;
		versions.set(v, [...(versions.get(v) ?? []), ch]);
	}
	for (const v of extraVersions) if (!versions.has(v)) versions.set(v, []);
	console.error(`[probe] channels ${JSON.stringify(channels)}`);

	// 2. Host identity.
	const identities: HostIdentity[] = [];
	for (const h of HOSTS) identities.push(await hostIdentity(h));

	// 3. Artifacts. Priority order for the full-download budget: CHR images first
	//    (what every quickchr start needs), then all-packages; versions in channel order.
	const artifacts: Artifact[] = [];
	for (const kind of ["chr", "all_packages"] as const) {
		for (const arch of arches) {
			for (const [version, chs] of versions) {
				const officialUrl = kind === "chr" ? chrDownloadUrl(version, arch) : packagesDownloadUrl(version, arch);
				artifacts.push({ version, channels: chs, arch, kind, officialUrl, file: officialUrl.split("/").pop() ?? "" });
			}
		}
	}

	// 4. Metadata on both hosts, alternating which host is asked first.
	const meta: { artifact: Artifact; hosts: HostMeta[] }[] = [];
	for (const [i, a] of artifacts.entries()) {
		const order = i % 2 === 0 ? [...HOSTS] : [...HOSTS].reverse();
		const hosts: HostMeta[] = [];
		for (const h of order) hosts.push(await hostMeta(a, h));
		hosts.sort((x, y) => HOSTS.indexOf(x.host) - HOSTS.indexOf(y.host));
		meta.push({ artifact: a, hosts });
		console.error(`[probe] meta ${a.file}: ${hosts.map((m) => `${m.host}=${m.head?.status ?? m.error?.class}`).join(" ")}`);
	}

	// 5. Integrity: full downloads from both hosts inside the budget, else windows.
	//    Only full-download bytes count against --full-budget-mb; window bytes are
	//    tracked on their own so they never crowd out a full download.
	let fullBytes = 0;
	let windowBytes = 0;
	const integrity: {
		file: string;
		version: string;
		arch: Arch;
		kind: Artifact["kind"];
		mode: "full" | "windows" | "skipped";
		publishedSha256: Record<string, string | undefined>;
		transfers: Transfer[];
		verdict: string;
	}[] = [];
	const fullTransfers: Transfer[] = [];
	for (const [i, { artifact: a, hosts }] of meta.entries()) {
		const size = Number(hosts[0]?.head?.headers["content-length"] ?? Number.NaN);
		const published: Record<string, string | undefined> = {};
		for (const m of hosts) published[m.host] = m.sha256File?.hash;
		const order = i % 2 === 0 ? [...HOSTS] : [...HOSTS].reverse();
		const transfers: Transfer[] = [];
		let mode: "full" | "windows" | "skipped";
		if (!Number.isFinite(size) || hosts.some((m) => m.head?.status !== 200)) {
			mode = "skipped";
		} else if (fullBytes + 2 * size <= fullBudget) {
			mode = "full";
			for (const [pos, h] of order.entries()) {
				console.error(`[probe] full ${a.file} from ${h} (${(size / 1e6).toFixed(1)} MB)`);
				const t = await transfer(h, hostUrl(a.officialUrl, h), "full", pos, {
					expectedBytes: size,
					timeoutMs: 20 * 60_000,
				});
				fullBytes += t.bytes;
				transfers.push(t);
				fullTransfers.push(t);
				console.error(`[probe]   -> ${t.status} ${f(t.mbps)} MB/s ttfb=${f(t.ttfbMs, 0)}ms ${t.error?.class ?? "ok"}`);
			}
		} else {
			mode = "windows";
			const starts = [0, Math.floor(size / 2 / MIB) * MIB, Math.max(0, size - MIB)];
			for (const s of starts) {
				const range: ByteRange = { start: s, end: Math.min(size, s + MIB) - 1, total: size };
				for (const [pos, h] of order.entries()) {
					const t = await transfer(h, hostUrl(a.officialUrl, h), "window", pos, {
						range,
						expectedBytes: range.end - range.start + 1,
						timeoutMs: 120_000,
					});
					windowBytes += t.bytes;
					transfers.push(t);
				}
			}
		}
		let verdict: string;
		const pubVals = Object.values(published);
		const pubAgree = pubVals.every((v) => v !== undefined && v === pubVals[0]);
		if (mode === "skipped") verdict = "skipped (not 200 on both hosts)";
		else if (transfers.some((t) => t.error)) verdict = "transfer error (see transfers)";
		else if (mode === "full") {
			const hashes = new Set(transfers.map((t) => t.sha256));
			const matchesPublished = pubAgree && transfers.every((t) => t.sha256 === pubVals[0]);
			verdict =
				hashes.size === 1
					? matchesPublished
						? "identical; matches published .sha256 on both hosts"
						: pubAgree
							? "identical bytes; DOES NOT match published .sha256"
							: "identical bytes; published .sha256 missing or differs between hosts"
					: "DIFFERENT BYTES between hosts";
		} else {
			const byRange = new Map<string, Set<string | undefined>>();
			for (const t of transfers) byRange.set(t.range ?? "", (byRange.get(t.range ?? "") ?? new Set()).add(t.sha256));
			const same = [...byRange.values()].every((s) => s.size === 1);
			verdict = `${same ? "3 × 1 MiB windows identical" : "WINDOWS DIFFER"}; published .sha256 ${pubAgree ? "identical on both hosts" : "missing or differs"}`;
		}
		integrity.push({ file: a.file, version: a.version, arch: a.arch, kind: a.kind, mode, publishedSha256: published, transfers, verdict });
	}

	// 6. Paired range trials for timing: same artifact + offset for both hosts in a
	//    round, order flipped each round, offsets spread across the file.
	const trialArtifacts = meta.filter(
		(m) =>
			m.hosts.every((h) => h.head?.status === 200) &&
			Number.isSafeInteger(Number(m.hosts[0]?.head?.headers["content-length"] ?? Number.NaN)),
	);
	const rangeTrials: { round: number; file: string; range: string; transfers: Transfer[] }[] = [];
	for (let r = 0; r < rounds && trialArtifacts.length > 0; r++) {
		const m = trialArtifacts[r % trialArtifacts.length];
		if (!m) break;
		const size = Number(m.hosts[0]?.head?.headers["content-length"]);
		const span = Math.max(0, size - rangeBytes);
		const start = Math.floor((Math.random() * span) / MIB) * MIB;
		const end = Math.min(size, start + rangeBytes) - 1;
		const byteRange: ByteRange = { start, end, total: size };
		const range = rangeHeader(byteRange);
		const order = r % 2 === 0 ? [...HOSTS] : [...HOSTS].reverse();
		const transfers: Transfer[] = [];
		for (const [pos, h] of order.entries()) {
			transfers.push(
				await transfer(h, hostUrl(m.artifact.officialUrl, h), "range", pos, {
					range: byteRange,
					expectedBytes: end - start + 1,
					timeoutMs: 180_000,
				}),
			);
		}
		const same = transfers.every((t) => !t.error && t.sha256 === transfers[0]?.sha256);
		console.error(
			`[probe] round ${r} ${m.artifact.file} ${range}: ${transfers.map((t) => `${t.host}=${f(t.mbps)}MB/s/${f(t.ttfbMs, 0)}ms${t.error ? `/${t.error.class}` : ""}`).join(" ")}${same ? "" : " HASH-MISMATCH"}`,
		);
		rangeTrials.push({ round: r, file: m.artifact.file, range, transfers });
	}

	// 7. Summaries.
	const allTimed = [...fullTransfers, ...rangeTrials.flatMap((r) => r.transfers)];
	const perHost = HOSTS.map((h) => {
		const mine = (kind: Transfer["kind"]) => allTimed.filter((t) => t.host === h && t.kind === kind);
		const ok = (ts: Transfer[]) => ts.filter((t) => !t.error);
		return {
			host: h,
			full: {
				trials: mine("full").length,
				errors: mine("full").filter((t) => t.error).map((t) => t.error?.class),
				stalls: mine("full").reduce((s, t) => s + t.stalls, 0),
				maxGapMs: Math.max(0, ...mine("full").map((t) => t.maxGapMs)),
				mbps: stats(ok(mine("full")).map((t) => t.mbps ?? 0)),
				ttfbMs: stats(ok(mine("full")).map((t) => t.ttfbMs ?? 0)),
			},
			range: {
				trials: mine("range").length,
				errors: mine("range").filter((t) => t.error).map((t) => t.error?.class),
				stalls: mine("range").reduce((s, t) => s + t.stalls, 0),
				maxGapMs: Math.max(0, ...mine("range").map((t) => t.maxGapMs)),
				mbps: stats(ok(mine("range")).map((t) => t.mbps ?? 0)),
				ttfbMs: stats(ok(mine("range")).map((t) => t.ttfbMs ?? 0)),
			},
		};
	});
	// Paired view: cdn/download throughput ratio per pair, and first-vs-second position.
	// A pair only counts when both hosts returned the same bytes: timing two
	// different bodies against each other is not a host comparison.
	const completePairs = [
		...rangeTrials.map((r) => r.transfers),
		...integrity.filter((i) => i.mode === "full").map((i) => i.transfers),
	].filter((p) => p.length === 2 && p.every((t) => !t.error && t.mbps));
	const pairs = completePairs.filter((p) => p[0]?.sha256 !== undefined && p[0].sha256 === p[1]?.sha256);
	const hashMismatchPairs = completePairs.length - pairs.length;
	const ratios = pairs.map((p) => {
		const d = p.find((t) => t.host === "download.mikrotik.com")?.mbps ?? 1;
		const c = p.find((t) => t.host === "cdn.mikrotik.com")?.mbps ?? 1;
		return c / d;
	});
	const positionEffect = {
		firstMbps: stats(pairs.map((p) => p.find((t) => t.position === 0)?.mbps ?? 0)),
		secondMbps: stats(pairs.map((p) => p.find((t) => t.position === 1)?.mbps ?? 0)),
	};
	const paired = {
		pairs: pairs.length,
		hashMismatchPairs,
		cdnFaster: ratios.filter((r) => r > 1).length,
		ratioCdnOverDownload: stats(ratios),
		positionEffect,
	};

	const result = {
		label: LABEL,
		startedAt,
		finishedAt: nowIso(),
		runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
		params: { fullBudgetMb: fullBudget / 1e6, rounds, rangeMiB: rangeBytes / MIB, arches, stallMs: STALL_MS },
		bodyBytes: {
			full: fullBytes,
			windows: windowBytes,
			ranges: rangeTrials.flatMap((r) => r.transfers).reduce((s, t) => s + t.bytes, 0),
		},
		channels,
		identities,
		meta,
		integrity,
		rangeTrials,
		perHost,
		paired,
	};

	mkdirSync(OUT_DIR, { recursive: true });
	const base = join(OUT_DIR, `${LABEL}`);
	writeFileSync(`${base}.json`, `${JSON.stringify(result, null, "\t")}\n`);
	const md = summaryMarkdown(result);
	writeFileSync(`${base}.md`, md);
	if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
	console.log(md);
}

// biome-ignore lint/suspicious/noExplicitAny: report renderer over the result object built above
function summaryMarkdown(r: any): string {
	const L: string[] = [];
	L.push(`# download-origin probe: ${r.label}`, "");
	L.push(`${r.startedAt} → ${r.finishedAt} · Bun ${r.runtime.bun} · ${r.runtime.platform}/${r.runtime.arch}`);
	const b = r.bodyBytes;
	const mb = (n: number) => (n / 1e6).toFixed(0);
	L.push(
		`Body bytes fetched: ${mb(b.full + b.windows + b.ranges)} MB — full artifacts ${mb(b.full)} MB (budget ${r.params.fullBudgetMb} MB), integrity windows ${mb(b.windows)} MB, timing ranges ${mb(b.ranges)} MB`,
		"",
	);
	L.push(`Channels: ${Object.entries(r.channels).map(([k, v]) => `${k} ${v}`).join(", ")}`, "");
	L.push("## Host identity", "", "| host | CNAME | A | AAAA | TLS peer | cert subject | issuer | SAN | valid to |", "|---|---|---|---|---|---|---|---|---|");
	for (const i of r.identities as HostIdentity[]) {
		L.push(
			`| ${i.host} | ${[i.cname].flat().join(" ")} | ${[i.a].flat().join(" ")} | ${[i.aaaa].flat().join(" ")} | ${i.tls?.remoteAddress ?? i.tlsError} | ${i.tls?.subject ?? ""} | ${i.tls?.issuer ?? ""} | ${i.tls?.san ?? ""} | ${i.tls?.validTo ?? ""} |`,
		);
	}
	L.push("", "## Integrity", "", "| file | channels | mode | published sha256 | verdict |", "|---|---|---|---|---|");
	for (const i of r.integrity) {
		const ch = r.meta.find((m: { artifact: Artifact }) => m.artifact.file === i.file)?.artifact.channels.join("+") || "pinned";
		const pub = Object.values(i.publishedSha256 as Record<string, string | undefined>)[0];
		L.push(`| ${i.file} | ${ch} | ${i.mode} | \`${pub?.slice(0, 12) ?? "—"}…\` | ${i.verdict} |`);
	}
	L.push(
		"",
		"## Headers (compared across hosts)",
		"",
		"`differs` compares only: HEAD status, content-length, etag, last-modified; the 1-byte range's status, Content-Range and validity; the parsed .sha256 hash.",
		"",
		"| file | status | content-length | etag | last-modified | 1-byte range | .sha256 | differs |",
		"|---|---|---|---|---|---|---|---|",
	);
	for (const m of r.meta as { artifact: Artifact; hosts: HostMeta[] }[]) {
		const [d, c] = m.hosts;
		const h = d?.head?.headers ?? {};
		const fields = (x: HostMeta | undefined) =>
			[x?.head?.status, x?.head?.headers["content-length"], x?.head?.headers.etag, x?.head?.headers["last-modified"], x?.range?.status, x?.range?.contentRange, x?.range?.valid, x?.sha256File?.hash].join("|");
		const differs = fields(d) === fields(c) ? "no" : "**YES**";
		L.push(
			`| ${m.artifact.file} | ${d?.head?.status}/${c?.head?.status} | ${h["content-length"]} | \`${h.etag ?? ""}\` | ${h["last-modified"] ?? ""} | ${d?.range?.status}/${c?.range?.status} | ${d?.sha256File?.status}/${c?.sha256File?.status} | ${differs} |`,
		);
	}
	L.push(
		"",
		"## Timing",
		"",
		`TTFB = request start until response headers arrive (includes whatever DNS, connect and TLS that request needed; not split out). Throughput = body MB/s (1e6) over the body-read loop after headers. Stall = gap > ${r.params.stallMs} ms between body chunks. keepalive off.`,
		"",
	);
	L.push("| host | kind | trials | errors | stalls | max gap ms | MB/s min / p50 / max | TTFB ms min / p50 / max |", "|---|---|---|---|---|---|---|---|");
	for (const h of r.perHost) {
		for (const k of ["full", "range"] as const) {
			const s = h[k];
			L.push(
				`| ${h.host} | ${k} | ${s.trials} | ${s.errors.length ? s.errors.join(",") : 0} | ${s.stalls} | ${f(s.maxGapMs, 0)} | ${f(s.mbps.min)} / ${f(s.mbps.p50)} / ${f(s.mbps.max)} | ${f(s.ttfbMs.min, 0)} / ${f(s.ttfbMs.p50, 0)} / ${f(s.ttfbMs.max, 0)} |`,
			);
		}
	}
	const p = r.paired;
	L.push(
		"",
		`Paired (same bytes, both hosts, order alternated): ${p.pairs} pairs with equal hashes (${p.hashMismatchPairs} pairs excluded for unequal hashes); cdn faster in ${p.cdnFaster}; cdn/download throughput ratio min ${f(p.ratioCdnOverDownload.min)} / p50 ${f(p.ratioCdnOverDownload.p50)} / max ${f(p.ratioCdnOverDownload.max)}.`,
		`Position effect: first-in-pair p50 ${f(p.positionEffect.firstMbps.p50)} MB/s vs second-in-pair p50 ${f(p.positionEffect.secondMbps.p50)} MB/s.`,
	);
	return `${L.join("\n")}\n`;
}

// ── watch (release-boundary freshness) ────────────────────────────────────────

async function watch() {
	const { intervalMs } = WATCH;
	const deadline = Date.now() + WATCH.durationMs;
	const expect = new Set(WATCH.expect);
	mkdirSync(OUT_DIR, { recursive: true });
	const logPath = join(OUT_DIR, `watch-${LABEL}.jsonl`);
	const log = (o: object) => {
		const line = JSON.stringify({ at: nowIso(), ...o });
		appendFileSync(logPath, `${line}\n`);
		console.log(line);
	};
	const baseline: Record<string, string> = {};
	for (const ch of CHANNELS) baseline[ch] = await resolveVersion(ch);
	log({ event: "baseline", channels: baseline, expect: [...expect] });
	// first-seen per (host, thing)
	const firstSeen = new Map<string, string>();
	const mark = (key: string, detail: object) => {
		if (firstSeen.has(key)) return;
		firstSeen.set(key, nowIso());
		log({ event: "first-seen", key, ...detail });
	};
	const watched = new Set(expect);
	const shaByHost = new Map<string, string>();
	while (Date.now() < deadline) {
		// The channel pointer on each host (cdn serves /routeros/NEWESTa7.* too).
		for (const ch of CHANNELS) {
			for (const h of HOSTS) {
				try {
					const res = await request(`https://${h}/routeros/NEWESTa7.${ch}`);
					if (!res.ok) {
						await res.body?.cancel();
						continue;
					}
					const body = new TextDecoder().decode(await readCapped(res, 4096));
					const v = body.trim().split(/\s+/)[0] ?? "";
					if (VERSION_RE.test(v) && v !== baseline[ch]) {
						mark(`${h} NEWESTa7.${ch}=${v}`, { host: h, channel: ch, version: v });
						watched.add(v);
					}
				} catch (e) {
					log({ event: "error", host: h, what: `NEWESTa7.${ch}`, ...classify(e) });
				}
			}
		}
		for (const v of watched) {
			const img = chrDownloadUrl(v, "x86");
			for (const h of HOSTS) {
				try {
					// "Seen" means the host served real bytes: a validated 1-byte 206, not
					// just a 200 HEAD (which a placeholder or error page could also give).
					const probe = await oneByteRange(hostUrl(img, h), undefined);
					if (probe.valid) mark(`${h} ${v} image`, { host: h, version: v, contentRange: probe.contentRange });
					const s = await request(`${hostUrl(img, h)}.sha256`);
					const text = s.ok ? new TextDecoder().decode(await readCapped(s, 4096)) : undefined;
					if (!s.ok) await s.body?.cancel();
					const sha = text === undefined ? undefined : parseSha256(text);
					if (sha) {
						shaByHost.set(`${h} ${v}`, sha);
						mark(`${h} ${v} sha256`, { host: h, version: v, sha256: sha });
					}
				} catch (e) {
					log({ event: "error", host: h, what: `${v} image`, ...classify(e) });
				}
			}
			const done = HOSTS.every((h) => firstSeen.has(`${h} ${v} image`) && firstSeen.has(`${h} ${v} sha256`));
			if (done && !firstSeen.has(`done ${v}`)) {
				firstSeen.set(`done ${v}`, nowIso());
				const shas = new Set(HOSTS.map((h) => shaByHost.get(`${h} ${v}`)));
				log({ event: "both-hosts-serving", version: v, sha256Agree: shas.size === 1, firstSeen: Object.fromEntries([...firstSeen].filter(([k]) => k.includes(v))) });
			}
		}
		await Bun.sleep(intervalMs);
	}
	log({ event: "deadline", firstSeen: Object.fromEntries(firstSeen) });
}

if (mode === "run") await run();
else await watch();
