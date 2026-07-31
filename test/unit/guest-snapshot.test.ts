import { describe, test, expect, afterEach } from "bun:test";
import {
	captureGuestSnapshot,
	deepBootDiagnosticsEnabled,
	DIAGNOSTIC_RULE_COMMENT,
	GUEST_LOGIN_ALLOWANCE_MS,
	GUEST_QUERY_TIMEOUT_MS,
	GUEST_SNAPSHOT_BUDGET_MS,
	GUEST_SNAPSHOT_QUERIES,
	parseSerializedJson,
	runCountingRuleProbe,
	serializeJsonCommand,
	type GuestExec,
} from "../../src/lib/guest-snapshot.ts";
import { CONSOLE_LOGIN_COST_MS } from "../../src/lib/console.ts";

afterEach(() => {
	delete process.env.QUICKCHR_DEEP_BOOT_DIAGNOSTICS;
});

describe("serializeJsonCommand", () => {
	// A bare `print` hits RouterOS's paging prompt: `/log print detail` blocks and
	// returns empty. Every query must go through :serialize + as-value.
	test("wraps a query in :put [:serialize to=json [...]]", () => {
		expect(serializeJsonCommand("/log print as-value")).toBe(":put [:serialize to=json [/log print as-value]]");
	});

	test("every snapshot query ends in as-value — bare print pages and returns empty", () => {
		for (const q of GUEST_SNAPSHOT_QUERIES) {
			expect(q.query).toContain("print");
			expect(q.query.endsWith("as-value")).toBe(true);
		}
	});
});

describe("parseSerializedJson", () => {
	test("parses a clean single-line array", () => {
		expect(parseSerializedJson('[{"address":"10.0.2.15/24"}]').value).toEqual([{ address: "10.0.2.15/24" }]);
	});

	// RouterOS wraps at terminal width and :serialize emits one line, so every
	// newline in the reply is an artifact — including one landing mid-string.
	test("de-wraps a payload broken by terminal wrapping inside a string", () => {
		const wrapped = '[{"message":"dhcp-client on ether1 got IP \naddress 10.0.2.15"}]';
		expect(parseSerializedJson(wrapped).value).toEqual([
			{ message: "dhcp-client on ether1 got IP address 10.0.2.15" },
		]);
	});

	test("strips carriage returns", () => {
		expect(parseSerializedJson('[{"a":\r\n1}]').value).toEqual([{ a: 1 }]);
	});

	// RouterOS repaints the input line, so the echoed command appears several
	// times before the payload — the real reply is the last thing on the wire.
	test("takes the payload after repeated command echoes", () => {
		const raw = [
			":put [:serialize to=json [/ip/address print as-value]]",
			":put [:serialize to=json [/ip/address print as-value]]",
			'[{"address":"10.0.2.15/24"}]',
		].join("\n");
		expect(parseSerializedJson(raw).value).toEqual([{ address: "10.0.2.15/24" }]);
	});

	// A wrap can put `{"` at the start of a continuation line inside an array —
	// starting there yields unbalanced JSON, so the earlier candidate must win.
	test("does not mistake a wrapped array element for the payload start", () => {
		const raw = '[{"topics":"dhcp,info"},\n{"topics":"system,info"}]';
		expect(parseSerializedJson(raw).value).toEqual([{ topics: "dhcp,info" }, { topics: "system,info" }]);
	});

	test("reports empty and non-JSON replies instead of throwing", () => {
		expect(parseSerializedJson("   ").error).toContain("empty");
		expect(parseSerializedJson("bad command name").error).toContain("no JSON payload");
	});

	// #109: `empty console reply` used to cover both "RouterOS printed nothing"
	// and "the reader lost the payload", so the blanked ipService/log entries in
	// the #79 forensics read as a guest answer rather than a reader defect.
	test("an unframed empty reply is reported as a framing failure, not an empty answer", () => {
		expect(parseSerializedJson("   ", false).error).toContain("could not frame");
		expect(parseSerializedJson("   ", true).error).toContain("RouterOS printed nothing");
		expect(parseSerializedJson("   ", true).error).not.toContain("could not frame");
		// `undefined` is "not reported", not "framed" — it must not claim the guest
		// was silent, because a bare-string GuestExec cannot report framing at all.
		expect(parseSerializedJson("   ", undefined).error).toContain("framing unknown");
		expect(parseSerializedJson("   ").error).not.toContain("printed nothing");
	});
});

describe("captureGuestSnapshot", () => {
	test("collects every query and reports console reachability", async () => {
		const seen: string[] = [];
		const exec: GuestExec = async (command) => {
			seen.push(command);
			if (command.includes("/ip/address")) return '[{"address":"10.0.2.15/24","interface":"ether1"}]';
			if (command.includes("/ip/service")) return '[{"name":"www","disabled":"false","port":"80"}]';
			if (command.includes("/ip/firewall/filter")) return "[]";
			if (command.includes("/system/resource")) return '{"uptime":"00:03:12","version":"7.21.5"}';
			return "[]";
		};

		const snap = await captureGuestSnapshot(exec);
		expect(seen.length).toBe(GUEST_SNAPSHOT_QUERIES.length);
		expect(snap.consoleReachable).toBe(true);
		expect(snap.entries.ipAddress?.ok).toBe(true);
		expect(snap.entries.firewallFilter?.value).toEqual([]);
		expect(snap.summary).toContain("1 ip address(es)");
		expect(snap.summary).toContain("0 firewall filter rule(s)");
		expect(snap.summary).toContain("www disabled=false");
		expect(snap.summary).toContain("uptime=00:03:12");
	});

	// A diagnostic must never turn a boot failure into a different thrown error.
	test("survives an exec that always throws", async () => {
		const snap = await captureGuestSnapshot(async () => {
			throw new Error("Serial channel not found");
		});
		expect(snap.consoleReachable).toBe(false);
		expect(snap.summary).toContain("console unreachable");
		expect(Object.values(snap.entries).every((e) => !e.ok)).toBe(true);
	});

	test("records whether the console reader could frame each reply", async () => {
		const snap = await captureGuestSnapshot(async (command) =>
			command.includes("/ip/service")
				? { output: "", framed: false }
				: { output: "[]", framed: true },
		);
		expect(snap.entries.ipService?.framed).toBe(false);
		expect(snap.entries.ipService?.error).toContain("could not frame");
		expect(snap.entries.firewallFilter?.framed).toBe(true);
		expect(snap.entries.firewallFilter?.ok).toBe(true);
	});

	test("keeps the raw text when a reply cannot be parsed", async () => {
		const snap = await captureGuestSnapshot(async () => "expected end of command (line 1 column 12)");
		expect(snap.consoleReachable).toBe(true);
		expect(snap.entries.log?.ok).toBe(false);
		expect(snap.entries.log?.raw).toContain("expected end of command");
	});

	test("stops issuing queries once the budget is spent", async () => {
		let calls = 0;
		const exec: GuestExec = async () => {
			calls++;
			await Bun.sleep(60);
			return "[]";
		};
		const snap = await captureGuestSnapshot(exec, "admin", { budgetMs: 100 });
		expect(calls).toBeLessThan(GUEST_SNAPSHOT_QUERIES.length);
		expect(Object.values(snap.entries).some((e) => e.error?.includes("budget"))).toBe(true);
	});

	// #69/B10 regression. Before this, the login was unbudgeted: every query got
	// GUEST_QUERY_TIMEOUT_MS, an executor with N credential candidates divided
	// that N ways, and no share was long enough to finish a ~11.4 s RouterOS
	// serial login. The first query failed, so no credential was ever marked
	// working, so every later query repeated the same split — and the snapshot
	// burned its whole budget to report `consoleReachable: false` about a guest
	// answering serial in 10 ms.
	test("pays the login allowance until a query answers, then stops", async () => {
		const budgets: number[] = [];
		const exec: GuestExec = async (_command, timeoutMs) => {
			budgets.push(timeoutMs);
			// Nothing answers until the third query, so the first three all have to
			// budget for a login that has not happened yet.
			if (budgets.length < 3) throw new Error("Console exec: could not reach CLI prompt");
			return "[]";
		};

		await captureGuestSnapshot(exec, "admin");

		const withLogin = GUEST_QUERY_TIMEOUT_MS + GUEST_LOGIN_ALLOWANCE_MS;
		expect(budgets.slice(0, 3)).toEqual([withLogin, withLogin, withLogin]);
		expect(budgets.slice(3).every((b) => b === GUEST_QUERY_TIMEOUT_MS)).toBe(true);
	});

	// The allowance must not become a way for a wedged console to spend the whole
	// budget: it is added to one query, then bounded by whatever budget is left.
	test("the login allowance never exceeds the remaining budget", async () => {
		const budgets: number[] = [];
		const exec: GuestExec = async (_command, timeoutMs) => {
			budgets.push(timeoutMs);
			return "[]";
		};

		await captureGuestSnapshot(exec, "admin", { budgetMs: 5_000 });

		expect(budgets[0]).toBeLessThanOrEqual(5_000);
	});

	// Two candidates must fit inside the first query, because those two —
	// stored credentials and factory admin:"" — are what actually answer the
	// machines we produce. One candidate's worth of allowance would leave a
	// provisioned machine diagnosable only by luck of ordering.
	test("the allowance covers at least two credential logins", () => {
		expect(GUEST_QUERY_TIMEOUT_MS + GUEST_LOGIN_ALLOWANCE_MS).toBeGreaterThanOrEqual(2 * CONSOLE_LOGIN_COST_MS);
		// …and still leaves the rest of the snapshot room to run.
		expect(GUEST_QUERY_TIMEOUT_MS + GUEST_LOGIN_ALLOWANCE_MS).toBeLessThan(GUEST_SNAPSHOT_BUDGET_MS);
	});

	// The summary is appended to a thrown error that CI echoes into a public log,
	// while /log entries and the console itself can carry credentials.
	test("summary carries shapes, never payload contents", async () => {
		const snap = await captureGuestSnapshot(async (command) =>
			command.includes("/log")
				? '[{"message":"device changed by console: /user add password=hunter2"}]'
				: "[]",
		);
		expect(snap.entries.log?.ok).toBe(true);
		expect(snap.summary).not.toContain("hunter2");
	});
});

describe("deepBootDiagnosticsEnabled", () => {
	test("off unless QUICKCHR_DEEP_BOOT_DIAGNOSTICS=1", () => {
		expect(deepBootDiagnosticsEnabled()).toBe(false);
		process.env.QUICKCHR_DEEP_BOOT_DIAGNOSTICS = "1";
		expect(deepBootDiagnosticsEnabled()).toBe(true);
	});
});

describe("runCountingRuleProbe", () => {
	/** Fake guest whose mangle passthrough counter advances by `perProbe` per host probe. */
	function fakeGuest(perProbe: number) {
		const state = { packets: 12, probes: 0, commands: [] as string[] };
		const exec: GuestExec = async (command) => {
			state.commands.push(command);
			if (command.includes("/ip/firewall/mangle add")) return "";
			// Only `print stats` carries packets/bytes — plain `print` omits them.
			if (command.includes("/ip/firewall/mangle print stats")) {
				return `[{"packets":"${state.packets}","bytes":"480","comment":"${DIAGNOSTIC_RULE_COMMENT}"}]`;
			}
			if (command.includes("/ip/firewall/connection print")) return "[]";
			return "";
		};
		const probe = async () => {
			state.probes++;
			state.packets += perProbe;
			return "accepting";
		};
		return { state, exec, probe };
	}

	// The delta is a boolean signal, not a count: slirp retransmits a SYN the guest
	// never answers, so one probe can move the counter several times. The fake
	// advances by 4 per probe to keep any count-equality assumption out of the code.
	test("counter advancing means the guest received the SYNs (RouterOS-side drop)", async () => {
		const guest = fakeGuest(4);
		const result = await runCountingRuleProbe(guest.exec, guest.probe, { guestPort: 80, hostPort: 9100, probes: 5, settleMs: 0 });
		expect(result.ran).toBe(true);
		expect(result.verdict).toBe("guest-received");
		expect(result.packetsBefore).toBe(12);
		expect(result.packetsAfter).toBe(32);
		expect(result.detail).toContain("RouterOS-side");
	});

	test("reads the counter with `print stats` — plain print omits packets/bytes", async () => {
		const guest = fakeGuest(4);
		await runCountingRuleProbe(guest.exec, guest.probe, { guestPort: 80, hostPort: 9100, probes: 1, settleMs: 0 });
		expect(guest.state.commands.some((c) => c.includes("/ip/firewall/mangle print stats as-value where comment="))).toBe(true);
	});

	test("flat counter means the SYNs never reach RouterOS (RX path)", async () => {
		const guest = fakeGuest(0);
		const result = await runCountingRuleProbe(guest.exec, guest.probe, { guestPort: 80, hostPort: 9100, probes: 5, settleMs: 0 });
		expect(result.verdict).toBe("not-delivered");
		expect(result.detail).toContain("RX path");
	});

	test("installs the rule, then removes it again", async () => {
		const guest = fakeGuest(1);
		await runCountingRuleProbe(guest.exec, guest.probe, { guestPort: 80, hostPort: 9100, probes: 1, settleMs: 0 });
		expect(guest.state.commands.some((c) => c.startsWith("/ip/firewall/mangle add"))).toBe(true);
		expect(guest.state.commands.some((c) => c.includes("mangle remove [find comment="))).toBe(true);
	});

	test("does not run — and does not throw — when the rule cannot be installed", async () => {
		const result = await runCountingRuleProbe(
			async () => { throw new Error("no such command"); },
			async () => "accepting",
			{ guestPort: 80, hostPort: 9100, probes: 2, settleMs: 0 },
		);
		expect(result.ran).toBe(false);
		expect(result.detail).toContain("could not install counting rule");
	});

	test("unreadable counter is inconclusive, not a verdict", async () => {
		const exec: GuestExec = async (command) =>
			command.includes("/ip/firewall/mangle add") ? "" : "input does not match any value of value-name";
		const result = await runCountingRuleProbe(exec, async () => "accepting", {
			guestPort: 80, hostPort: 9100, probes: 2, settleMs: 0,
		});
		expect(result.verdict).toBe("inconclusive");
	});

	// #109: the #79 report read `packetsAfter: 2` and still said "inconclusive"
	// because the pre-probe read had failed. The rule is created by this function
	// moments earlier, so its counter necessarily starts at 0 — a post-probe
	// counter above zero is already proof the guest received the SYNs.
	test("an unreadable pre-probe counter does not discard a positive post-probe one", async () => {
		let preProbeReadPending = false;
		const exec: GuestExec = async (command) => {
			if (command.includes("/ip/firewall/mangle add")) {
				preProbeReadPending = true;
				return "";
			}
			if (command.includes("/ip/firewall/mangle print stats")) {
				if (preProbeReadPending) {
					preProbeReadPending = false;
					return "input does not match any value of value-name";
				}
				return '[{"packets":"2","bytes":"120"}]';
			}
			return "";
		};
		const result = await runCountingRuleProbe(exec, async () => "accepting", {
			guestPort: 80, hostPort: 9100, probes: 5, settleMs: 0,
		});
		expect(result.packetsBefore).toBeNull();
		expect(result.packetsAfter).toBe(2);
		expect(result.verdict).toBe("guest-received");
		expect(result.detail).toContain("freshly added rule starts at 0");
	});

	test("an unreadable post-probe counter is still inconclusive", async () => {
		const exec: GuestExec = async (command) => {
			if (command.includes("/ip/firewall/mangle add")) return "";
			return "input does not match any value of value-name";
		};
		const result = await runCountingRuleProbe(exec, async () => "accepting", {
			guestPort: 80, hostPort: 9100, probes: 2, settleMs: 0,
		});
		expect(result.packetsAfter).toBeNull();
		expect(result.verdict).toBe("inconclusive");
	});

	// A rule this function created moments ago cannot legitimately count down, so
	// a negative delta means it was replaced or reset — unmeasured, not "flat".
	test("a counter that goes backwards is inconclusive, not not-delivered", async () => {
		let reads = 0;
		const exec: GuestExec = async (command) => {
			if (command.includes("/ip/firewall/mangle print stats")) {
				reads++;
				return `[{"packets":"${reads === 1 ? 5 : 3}","bytes":"120"}]`;
			}
			return "";
		};
		const result = await runCountingRuleProbe(exec, async () => "accepting", {
			guestPort: 80, hostPort: 9100, probes: 2, settleMs: 0,
		});
		expect(result.verdict).toBe("inconclusive");
		expect(result.detail).toContain("BACKWARDS");
	});
});
