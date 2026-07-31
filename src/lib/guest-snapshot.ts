/**
 * Guest-side forensics over the serial console, for a CHR that never became
 * REST-ready.
 *
 * The serial console stays reachable while REST is dead — verified against a
 * synthetic stuck state (a `action=drop` filter rule on tcp/80 makes REST time
 * out exactly like #79 while `consoleExec` still logs in and answers). That
 * makes a guest-side snapshot at failure time the only way to see whether
 * RouterOS itself is healthy when the host side says "silently dropped".
 *
 * Two capabilities, deliberately separated by how invasive they are:
 *
 *   - {@link captureGuestSnapshot} — read-only. Default on wherever a serial
 *     channel exists.
 *   - {@link runCountingRuleProbe} — writes a firewall rule and flips
 *     connection tracking active as a side effect. Opt-in
 *     (`QUICKCHR_DEEP_BOOT_DIAGNOSTICS=1`), and skipped when the caller asked
 *     for the machine to be preserved, since that means someone wants the
 *     failure state untouched.
 *
 * Everything here is best-effort: a diagnostic must never turn a boot failure
 * into a different thrown error.
 *
 * RouterOS console rules that this module encodes (all measured on 7.21.5 —
 * see tikoci/quickchr#105):
 *
 *   - **Always `:put [:serialize to=json [ ... print as-value]]`.** A bare
 *     `print` on `/log` or `/ip/firewall/connection/tracking` hits a paging
 *     prompt: it blocks for ~11 s and returns empty.
 *   - **De-wrap before parsing.** `:serialize` emits one line, so every newline
 *     in what comes back is a terminal wrap — and a wrap landing inside a JSON
 *     string breaks `JSON.parse`. See {@link parseSerializedJson}.
 *   - **`/tool/profile` is useless here** — it repaints instead of printing and
 *     returns empty in both `duration=` and `as-value` forms. Do not re-try it.
 */

/** A console reply, with whether the reader could frame it. `framed:false` means
 *  the end-of-reply sentinel never arrived, so an empty `output` says "the reader
 *  could not delimit the reply", not "the guest printed nothing" (#109). */
export interface GuestReply {
	output: string;
	framed?: boolean;
}

/** Executes one RouterOS CLI command in the guest and returns its raw output.
 *  Injected so this module stays free of a console.ts/channels.ts import.
 *  A bare string is accepted for callers and fakes that cannot report framing. */
export type GuestExec = (command: string, timeoutMs: number) => Promise<string | GuestReply>;

function asReply(reply: string | GuestReply): GuestReply {
	return typeof reply === "string" ? { output: reply } : reply;
}

/** Opens a TCP connection to a host port and returns a one-word outcome.
 *  Injected (diagnostics.probeTcpPort) to avoid an import cycle. */
export type HostPortProbe = (port: number, timeoutMs?: number) => Promise<string>;

/** Wrap a `print as-value` query so it comes back as single-line JSON. */
export function serializeJsonCommand(query: string): string {
	return `:put [:serialize to=json [${query}]]`;
}

/** The read-only snapshot. Ordered cheapest-and-most-decisive first, because
 *  {@link captureGuestSnapshot} stops issuing queries once its budget is spent.
 *
 *  `/log` leads: it is the only source that timestamps DHCP acquisition and
 *  service start. Note that a link flap does NOT show up under
 *  `topics~"interface"` — a healthy boot logs only `lo link up` and ether1's
 *  link-up is never recorded — it shows up as a `lost IP address` / `got IP
 *  address` DHCP pair, which is why the whole log is captured unfiltered. */
export const GUEST_SNAPSHOT_QUERIES: readonly { key: string; query: string; why: string }[] = [
	{ key: "log", query: "/log print as-value", why: "DHCP churn, service start, login failures" },
	{ key: "ipAddress", query: "/ip/address print as-value", why: "did the guest keep 10.0.2.15?" },
	{ key: "ipService", query: "/ip/service print as-value", why: "is www enabled and on port 80?" },
	{ key: "firewallFilter", query: "/ip/firewall/filter print as-value", why: "expected [] on a fresh CHR — confirm" },
	{ key: "systemResource", query: "/system/resource print as-value", why: "uptime, version, board" },
	{ key: "interfaceStats", query: "/interface print stats as-value", why: "rx-packet / rx-drop / rx-error" },
	{ key: "connectionTracking", query: "/ip/firewall/connection/tracking print as-value", why: "enabled + active-ipv4" },
];

export interface GuestSnapshotEntry {
	command: string;
	ok: boolean;
	elapsedMs: number;
	/** Parsed JSON payload when the round-trip succeeded. */
	value?: unknown;
	/** Why this entry has no value: exec failure, parse failure, or budget. */
	error?: string;
	/** Raw console text, kept only when parsing failed so the payload is not lost. */
	raw?: string;
	/** False when the console reader could not delimit the reply — the failure
	 *  mode is then the reader, not RouterOS. **Undefined means "not reported"**,
	 *  which covers both an exec that never ran and one that returned a bare
	 *  string (see {@link GuestExec}); do not read it as "no exec". */
	framed?: boolean;
}

export interface GuestSnapshot {
	/** True when at least one query round-tripped — i.e. RouterOS is alive and
	 *  answering on the console even though REST is not. */
	consoleReachable: boolean;
	loginUser: string;
	elapsedMs: number;
	entries: Record<string, GuestSnapshotEntry>;
	/** One-line, credential-free verdict safe to put in a thrown error. */
	summary: string;
}

/** Cap on raw console text retained for a query that failed to parse. */
const MAX_RAW_BYTES = 32 * 1024;

/**
 * De-wrap and parse a `:serialize to=json` reply.
 *
 * The payload is single-line by construction, so newlines are terminal wraps
 * and are simply removed. The harder half is finding where the payload starts:
 * RouterOS repaints the input line, so the echoed command can appear several
 * times before the reply. Candidate starts are therefore tried last-first —
 * the real payload is the last thing on the wire, and a candidate that starts
 * mid-payload leaves unbalanced JSON that fails to parse.
 */
export function parseSerializedJson(raw: string, framed?: boolean): { value?: unknown; error?: string } {
	const cleaned = raw.replace(/\r/g, "");
	const lines = cleaned.split("\n");
	const starts: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		const trimmed = (lines[i] ?? "").trimStart();
		if (trimmed.startsWith("[") || trimmed.startsWith("{")) starts.push(i);
	}
	if (starts.length === 0) {
		if (cleaned.trim() !== "") return { error: "no JSON payload in console reply" };
		// An empty reply has two very different causes, and #109 is the case where
		// telling them apart is the whole point: a *framed* empty reply is RouterOS
		// printing nothing, while an *unframed* one is the reader losing the payload.
		// `undefined` is neither — the exec could not report framing at all, so the
		// message must stay ambiguous rather than claim the guest was silent.
		if (framed === true) return { error: "empty console reply — RouterOS printed nothing" };
		if (framed === false) {
			return { error: "empty console reply — the reader could not frame it (payload may have been lost)" };
		}
		return { error: "empty console reply — framing unknown, so a lost payload cannot be ruled out" };
	}
	let lastError = "unparsable console reply";
	for (let i = starts.length - 1; i >= 0; i--) {
		const payload = lines.slice(starts[i]).join("").trim();
		try {
			return { value: JSON.parse(payload) };
		} catch (e) {
			lastError = e instanceof Error ? e.message : String(e);
		}
	}
	return { error: lastError };
}

/** Default per-command console timeout. Measured round-trips are ~0.5 s once
 *  paging is avoided; 15 s is slack for a loaded TCG guest, not an expectation.
 *  This covers the *command* only — see {@link GUEST_LOGIN_ALLOWANCE_MS}. */
export const GUEST_QUERY_TIMEOUT_MS = 15_000;

/**
 * Extra time a query gets, on top of {@link GUEST_QUERY_TIMEOUT_MS}, to pay for
 * the serial login the executor has to do before any command can run — granted
 * until one query answers, then dropped for the rest of the snapshot.
 *
 * The query cap was sized on the ~0.3 s cost of a command on an already-open
 * session (`CONSOLE_LOGIN_COST_MS` in console.ts has the measurements), which
 * left the ~11.4 s login unbudgeted. With a multi-candidate executor —
 * `bootFailureGuestExec()` tries stored credentials, then factory `admin`, then
 * `state.user` — that budget was then *divided*, so no candidate ever got enough
 * time to finish logging in. The first query failed, no credential was ever
 * marked working, every later query repeated the same doomed split, and the
 * snapshot spent its whole budget to report `consoleReachable: false` about a
 * guest that was answering serial in 10 ms (tikoci/quickchr#69, B10 of #110).
 *
 * Sized so at least two candidates fit in one query: 15 s + 15 s = 30 s of the
 * 60 s {@link GUEST_SNAPSHOT_BUDGET_MS}, leaving the remaining ~30 s for the
 * other six queries, which cost ~0.3 s each once a working credential is known.
 * Two candidates is the meaningful coverage — stored credentials and factory
 * `admin:""`, the pair that between them answer any machine we produce;
 * `state.user` is documented as the weakest case.
 *
 * Dropping it after the first answer is what keeps it bounded, and it costs a
 * genuinely wedged console nothing extra: `budgetMs - elapsed` caps every query
 * regardless, so an unreachable console spends the same total in fewer, longer
 * waits rather than more.
 */
export const GUEST_LOGIN_ALLOWANCE_MS = 15_000;

/** Default wall-clock cap for the whole read-only snapshot. It runs on an
 *  already-timed-out path, so it must be bounded rather than thorough. */
export const GUEST_SNAPSHOT_BUDGET_MS = 60_000;

/**
 * Run the read-only guest snapshot. Never throws.
 *
 * @param exec       Runs one command in the guest (serial console).
 * @param loginUser  Recorded in the result so a report shows which account was
 *                   used — post-`clean()` machines are unprovisioned and only
 *                   answer to `admin` with an empty password.
 */
export async function captureGuestSnapshot(
	exec: GuestExec,
	loginUser = "admin",
	opts: { queryTimeoutMs?: number; budgetMs?: number; loginAllowanceMs?: number } = {},
): Promise<GuestSnapshot> {
	const queryTimeoutMs = opts.queryTimeoutMs ?? GUEST_QUERY_TIMEOUT_MS;
	const budgetMs = opts.budgetMs ?? GUEST_SNAPSHOT_BUDGET_MS;
	const loginAllowanceMs = opts.loginAllowanceMs ?? GUEST_LOGIN_ALLOWANCE_MS;
	const started = Date.now();
	const entries: Record<string, GuestSnapshotEntry> = {};
	let consoleReachable = false;

	for (const { key, query } of GUEST_SNAPSHOT_QUERIES) {
		const command = serializeJsonCommand(query);
		const elapsed = Date.now() - started;
		if (elapsed >= budgetMs) {
			entries[key] = { command, ok: false, elapsedMs: 0, error: `skipped — snapshot budget ${budgetMs}ms spent` };
			continue;
		}
		// Granted until a query actually answers, not just to the first one: while
		// nothing has answered, no login has been established, so the next query
		// still has to pay for one. Tying it to "first" instead would let a single
		// hiccup cost the whole snapshot its only chance to log in. This cannot
		// overrun, because `budgetMs - elapsed` bounds every query either way — an
		// unreachable console spends the same total budget, in fewer, longer waits.
		const allowance = consoleReachable ? 0 : loginAllowanceMs;
		const queryStart = Date.now();
		try {
			const { output, framed } = asReply(await exec(command, Math.min(queryTimeoutMs + allowance, budgetMs - elapsed)));
			const parsed = parseSerializedJson(output, framed);
			consoleReachable = true;
			entries[key] = parsed.error === undefined
				? { command, ok: true, elapsedMs: Date.now() - queryStart, value: parsed.value, framed }
				: {
					command,
					ok: false,
					elapsedMs: Date.now() - queryStart,
					error: parsed.error,
					raw: output.slice(-MAX_RAW_BYTES),
					framed,
				};
		} catch (e) {
			entries[key] = {
				command,
				ok: false,
				elapsedMs: Date.now() - queryStart,
				error: e instanceof Error ? e.message : String(e),
			};
		}
	}

	return {
		consoleReachable,
		loginUser,
		elapsedMs: Date.now() - started,
		entries,
		summary: summarizeGuestSnapshot(consoleReachable, entries),
	};
}

/** Count rows in a `print as-value` payload — arrays are the usual shape,
 *  a bare object (e.g. `/ip/firewall/connection/tracking`) counts as one. */
function rowCount(value: unknown): number | null {
	if (Array.isArray(value)) return value.length;
	if (value !== null && typeof value === "object") return 1;
	return null;
}

/**
 * One line, no payload contents.
 *
 * This string is appended to a thrown `QuickCHRError`, which CI echoes into a
 * public job log. `/log` records "device changed by console" entries and the
 * snapshot can echo credentials the same way `serial.log` can, so only shapes
 * (reachability, row counts, a couple of booleans) go here — the values live in
 * the JSON report, which lands in an access-controlled artifact.
 */
function summarizeGuestSnapshot(consoleReachable: boolean, entries: Record<string, GuestSnapshotEntry>): string {
	if (!consoleReachable) return "guest snapshot: console unreachable — RouterOS answered nothing over serial";
	const parts: string[] = [];
	const ok = Object.values(entries).filter((e) => e.ok).length;
	parts.push(`${ok}/${Object.keys(entries).length} queries answered`);

	const addresses = rowCount(entries.ipAddress?.value);
	if (addresses !== null) parts.push(`${addresses} ip address(es)`);

	const filters = rowCount(entries.firewallFilter?.value);
	if (filters !== null) parts.push(`${filters} firewall filter rule(s)`);

	const services = entries.ipService?.value;
	if (Array.isArray(services)) {
		const www = services.find((s) => (s as Record<string, unknown>)?.name === "www") as Record<string, unknown> | undefined;
		if (www) parts.push(`www disabled=${String(www.disabled)} port=${String(www.port)}`);
	}

	const uptime = (entries.systemResource?.value as Record<string, unknown> | undefined)?.uptime
		?? (Array.isArray(entries.systemResource?.value)
			? (entries.systemResource?.value[0] as Record<string, unknown> | undefined)?.uptime
			: undefined);
	if (uptime !== undefined) parts.push(`uptime=${String(uptime)}`);

	return `guest snapshot: ${parts.join(", ")}`;
}

// --- Counting-rule probe (opt-in, mutates the guest) ---

/** True when the invasive guest probes may run. */
export function deepBootDiagnosticsEnabled(): boolean {
	return process.env.QUICKCHR_DEEP_BOOT_DIAGNOSTICS === "1";
}

/** Comment used to find the diagnostic rule again — and to make it obvious in a
 *  preserved machine where the rule came from. */
export const DIAGNOSTIC_RULE_COMMENT = "quickchr-boot-diagnostic";

/** How long to let the guest count retransmitted SYNs before re-reading. */
export const COUNTER_SETTLE_MS = 1_500;

export interface CountingRuleProbe {
	ran: boolean;
	/** Set when the probe declined to run; `ran` is then false. */
	skipped?: string;
	guestPort?: number;
	hostPort?: number;
	probesFired?: number;
	packetsBefore?: number | null;
	packetsAfter?: number | null;
	/** `/ip/firewall/connection print as-value` right after the burst — `seen-reply`
	 *  separates "arrived and something answered" from "arrived, nothing answered".
	 *  Secondary only: conntrack records what was *accepted*, never what was dropped. */
	connections?: unknown;
	verdict?: "guest-received" | "not-delivered" | "inconclusive";
	detail: string;
}

function firstNumber(value: unknown, field: string): number | null {
	const row = Array.isArray(value) ? value[0] : value;
	if (row === null || typeof row !== "object") return null;
	const raw = (row as Record<string, unknown>)[field];
	if (raw === undefined || raw === null) return null;
	const n = Number(String(raw).replace(/\s/g, ""));
	return Number.isFinite(n) ? n : null;
}

async function execJson(exec: GuestExec, query: string, timeoutMs: number): Promise<unknown> {
	const { output, framed } = asReply(await exec(serializeJsonCommand(query), timeoutMs));
	const parsed = parseSerializedJson(output, framed);
	if (parsed.error !== undefined) throw new Error(parsed.error);
	return parsed.value;
}

/**
 * The discriminator for #79: **does the guest receive the SYNs?**
 *
 * Accumulating `TCP[SYN_SENT]` in `info usernet` proves the packets are being
 * silently dropped, but a guest that received all of them and dropped them
 * itself looks identical from the host — measured: with `action=drop`
 * installed, 20 host probes advanced a rule counter by exactly 20 while slirp
 * showed 21 `SYN_SENT` rows. A counting rule inside the guest is what separates
 * the two:
 *
 *   - counter advances → the packets arrive; the drop is RouterOS-side;
 *   - counter flat → they never reach RouterOS; the drop is in the slirp /
 *     virtio RX path.
 *
 * It must be a **mangle `chain=prerouting action=passthrough`** rule, not a
 * filter `accept`. Two reasons, both measured on 7.23.2:
 *
 *   - `passthrough` is non-terminating and prerouting runs before the filter
 *     chains, so it counts arrivals whatever else is installed — verified by
 *     counting 10/10 SYNs that a filter `drop` on the same port then killed. A
 *     filter `accept` appended after an existing `drop` counts **zero** and
 *     reports "not-delivered" for a guest that is receiving everything.
 *   - it does not change what happens to the packet, so the failure state under
 *     investigation survives the measurement.
 *
 * `place-before=0` is not the fix for the ordering problem: on the empty chain
 * of a fresh CHR — #79's exact state — it fails with `no such item`.
 *
 * Read the delta as a boolean, never as a count: slirp retransmits a dropped
 * SYN, so the counter can advance by several per probe.
 *
 * Conntrack cannot answer this. RouterOS ships `enabled=auto`, which means
 * tracking is *off* while no filter/NAT/mangle rule exists — a fresh CHR (#79's
 * exact state) reports `active-ipv4:false` and 0 connections after healthy
 * probes — and even with tracking forced on, a dropped SYN leaves no entry at
 * all. It is captured here only as corroboration, because installing the accept
 * rule flips tracking active as a side effect.
 */
export async function runCountingRuleProbe(
	exec: GuestExec,
	probeHostPort: HostPortProbe,
	opts: { guestPort: number; hostPort: number; probes?: number; queryTimeoutMs?: number; settleMs?: number },
): Promise<CountingRuleProbe> {
	const probes = opts.probes ?? 10;
	const timeout = opts.queryTimeoutMs ?? GUEST_QUERY_TIMEOUT_MS;
	const base: CountingRuleProbe = { ran: false, guestPort: opts.guestPort, hostPort: opts.hostPort, detail: "" };

	try {
		await exec(
			`/ip/firewall/mangle add chain=prerouting protocol=tcp dst-port=${opts.guestPort} action=passthrough comment="${DIAGNOSTIC_RULE_COMMENT}"`,
			timeout,
		);
	} catch (e) {
		return { ...base, detail: `could not install counting rule: ${e instanceof Error ? e.message : String(e)}` };
	}

	const readCounter = async (): Promise<number | null> => {
		try {
			// `print stats`, not plain `print`: measured on 7.23.2, the plain form
			// returns the rule without `packets`/`bytes` at all, which reads as an
			// unreadable counter rather than a flat one.
			const value = await execJson(
				exec,
				`/ip/firewall/mangle print stats as-value where comment="${DIAGNOSTIC_RULE_COMMENT}"`,
				timeout,
			);
			return firstNumber(value, "packets");
		} catch {
			return null;
		}
	};

	const packetsBefore = await readCounter();
	for (let i = 0; i < probes; i++) await probeHostPort(opts.hostPort, 2000);
	// slirp retransmits a dropped SYN, so give the guest a moment to count what
	// was already sent before sampling — otherwise a slow TCG guest reads flat.
	// Overridable only so unit tests need not pay it; never shorten it in anger.
	await Bun.sleep(opts.settleMs ?? COUNTER_SETTLE_MS);
	const packetsAfter = await readCounter();

	let connections: unknown;
	try {
		connections = await execJson(exec, "/ip/firewall/connection print as-value", timeout);
	} catch { /* secondary signal — absence is itself expected on a fresh CHR */ }

	// Best-effort cleanup: the machine is normally destroyed right after this,
	// but the probe must not be the reason a preserved machine looks modified
	// beyond the tracking flip it cannot undo.
	try {
		await exec(`/ip/firewall/mangle remove [find comment="${DIAGNOSTIC_RULE_COMMENT}"]`, timeout);
	} catch { /* ignore */ }

	// Only `packetsAfter` is load-bearing. The rule is created by *this* function a
	// moment earlier, so its counter necessarily starts at 0 — which means an
	// unreadable `packetsBefore` costs nothing and must not throw the verdict away.
	// #109: a report read `packetsAfter: 2` and still said "inconclusive", even
	// though a counter at 2 on a seconds-old rule already proves `guest-received`.
	const baseline = packetsBefore ?? 0;
	const delta = packetsAfter === null ? null : packetsAfter - baseline;
	// A negative delta cannot happen on a rule this function created moments ago,
	// so it means the rule was replaced or reset mid-probe — that is unmeasured,
	// not evidence of non-delivery.
	const verdict: CountingRuleProbe["verdict"] = delta === null || delta < 0
		? "inconclusive"
		: delta > 0
			? "guest-received"
			: "not-delivered";
	const assumed = packetsBefore === null ? " (pre-probe read failed; a freshly added rule starts at 0)" : "";
	let detail: string;
	if (delta === null) {
		detail = "could not read the rule counter after the probes — cannot localize the drop";
	} else if (delta > 0) {
		detail = `rule counter advanced by ${delta} over ${probes} probes${assumed} — the guest IS receiving the SYNs; the drop is RouterOS-side`;
	} else if (delta < 0) {
		// Should not happen on a rule this function created; report it as the
		// anomaly it is rather than folding it into "flat".
		detail = `rule counter went BACKWARDS by ${-delta} over ${probes} probes${assumed} — the rule was replaced or reset mid-probe; treat as not measured`;
	} else {
		detail = `rule counter flat over ${probes} probes${assumed} — the SYNs never reach RouterOS; the drop is in the slirp/virtio RX path`;
	}

	return { ...base, ran: true, probesFired: probes, packetsBefore, packetsAfter, connections, verdict, detail };
}
