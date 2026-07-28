import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	captureBootFailure,
	classifyProbeError,
	MAX_BOOT_FAILURE_REPORTS,
	newBootProbeStats,
	newMonitorPhaseTimings,
	preserveOnFailure,
	probeTcpPort,
	pruneBootFailureReports,
	recordBootProbe,
	serialLogEnabled,
	summarizeBootProbe,
	summarizeMonitorPhases,
} from "../../src/lib/diagnostics.ts";

const dirs: string[] = [];
function scratch(): string {
	const d = mkdtempSync(join(tmpdir(), "quickchr-diag-"));
	dirs.push(d);
	return d;
}

afterEach(() => {
	while (dirs.length) {
		const d = dirs.pop();
		if (d) rmSync(d, { recursive: true, force: true });
	}
	delete process.env.QUICKCHR_PRESERVE_ON_FAILURE;
	delete process.env.QUICKCHR_SERIAL_LOG;
});

describe("classifyProbeError", () => {
	test("maps node errno codes to probe outcomes", () => {
		const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
		expect(classifyProbeError(refused).outcome).toBe("refused");

		const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
		expect(classifyProbeError(reset).outcome).toBe("reset");

		const etimedout = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
		expect(classifyProbeError(etimedout).outcome).toBe("probe-timeout");
	});

	// restGet() rejects its own deadline with a plain Error carrying no errno —
	// it must still be distinguishable from an unknown failure.
	test("recognizes restGet's own timeout message without an errno", () => {
		expect(classifyProbeError(new Error("restGet timeout after 3000ms: http://x")).outcome)
			.toBe("probe-timeout");
	});

	test("falls back to 'other' with the message preserved", () => {
		const c = classifyProbeError(new Error("something unexpected"));
		expect(c.outcome).toBe("other");
		expect(c.detail).toContain("something unexpected");
	});
});

describe("BootProbeStats", () => {
	test("tallies outcomes and tracks first/last", () => {
		const s = newBootProbeStats();
		recordBootProbe(s, 0, "refused", "ECONNREFUSED");
		recordBootProbe(s, 2000, "refused", "ECONNREFUSED");
		recordBootProbe(s, 4000, "reset", "ECONNRESET");

		expect(s.attempts).toBe(3);
		expect(s.counts.refused).toBe(2);
		expect(s.counts.reset).toBe(1);
		expect(s.first?.atMs).toBe(0);
		expect(s.last?.outcome).toBe("reset");
	});

	// The whole point of the classification: "the port never answered" and
	// "the port answered but RouterOS never finished coming up" must not look alike.
	test("firstHttpAtMs stays null while only transport errors occur", () => {
		const s = newBootProbeStats();
		recordBootProbe(s, 0, "refused");
		recordBootProbe(s, 2000, "probe-timeout");
		expect(s.firstHttpAtMs).toBeNull();
		expect(summarizeBootProbe(s)).toContain("never produced an HTTP response");
	});

	test("firstHttpAtMs latches on the first HTTP-level outcome", () => {
		const s = newBootProbeStats();
		recordBootProbe(s, 0, "refused");
		recordBootProbe(s, 6000, "wrong-body", "[]");
		recordBootProbe(s, 8000, "unauthorized", "401");
		expect(s.firstHttpAtMs).toBe(6000);
		expect(summarizeBootProbe(s)).toContain("first HTTP response at 6s");
	});

	test("recordBootProbe tolerates an absent stats object", () => {
		expect(() => recordBootProbe(undefined, 0, "refused")).not.toThrow();
	});

	test("summarizes an empty stats object without throwing", () => {
		expect(summarizeBootProbe(newBootProbeStats())).toBe("no probes recorded");
	});
});

describe("monitor phase timings", () => {
	test("renders unreached phases as 'never'", () => {
		const t = newMonitorPhaseTimings();
		t.connectedAtMs = 3;
		const summary = summarizeMonitorPhases(t);
		expect(summary).toContain("connect=3ms");
		expect(summary).toContain("prompt=never");
		expect(summary).toContain("response-first-byte=never");
		expect(summary).toContain("bytes=0");
	});

	// Issue #80 hypothesis 2: QEMU takes the command and goes quiet. That shape —
	// command written, no response — has to be readable straight off the message.
	test("distinguishes 'command written, no response' from 'no prompt'", () => {
		const t = newMonitorPhaseTimings();
		t.connectedAtMs = 1;
		t.firstByteAtMs = 4;
		t.promptAtMs = 4;
		t.commandWrittenAtMs = 4;
		t.bytesReceived = 120;
		const summary = summarizeMonitorPhases(t);
		expect(summary).toContain("command-written=4ms");
		expect(summary).toContain("response-first-byte=never");
	});
});

describe("environment gates", () => {
	test("both diagnostics knobs default off and require exactly '1'", () => {
		expect(preserveOnFailure()).toBe(false);
		expect(serialLogEnabled()).toBe(false);

		process.env.QUICKCHR_PRESERVE_ON_FAILURE = "true";
		process.env.QUICKCHR_SERIAL_LOG = "yes";
		expect(preserveOnFailure()).toBe(false);
		expect(serialLogEnabled()).toBe(false);

		process.env.QUICKCHR_PRESERVE_ON_FAILURE = "1";
		process.env.QUICKCHR_SERIAL_LOG = "1";
		expect(preserveOnFailure()).toBe(true);
		expect(serialLogEnabled()).toBe(true);
	});
});

describe("probeTcpPort", () => {
	test("reports 'accepting' for a live listener and ECONNREFUSED for a dead port", async () => {
		const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
		try {
			expect(await probeTcpPort(server.port as number)).toBe("accepting");
		} finally {
			server.stop(true);
		}
		// Port 1 is privileged and unbound in test environments.
		expect(await probeTcpPort(1, 1000)).not.toBe("accepting");
	});
});

describe("captureBootFailure", () => {
	test("writes a self-contained report outside the machine directory", async () => {
		const machineDir = scratch();
		const reportDir = join(scratch(), "failures");
		writeFileSync(join(machineDir, "qemu.log"), "qemu-system-x86_64: warning: something\n");
		writeFileSync(join(machineDir, "serial.log"), "MikroTik 7.21.5 (long-term)\nMikroTik Login: \n");

		const probe = newBootProbeStats();
		recordBootProbe(probe, 0, "refused", "ECONNREFUSED");

		const report = await captureBootFailure({
			name: "unit-machine",
			machineDir,
			reportDir,
			arch: "x86",
			accel: "kvm",
			bootTimeoutMs: 180_000,
			pid: process.pid,
			httpPort: 1,
			portBase: 9100,
			qemuArgs: ["qemu-system-x86_64", "-m", "512"],
			probe,
			phase: "unit",
			monitorQuery: async (cmd) => (cmd === "info status" ? "VM status: paused (io-error)" : ""),
		});

		expect(report.reportPath).toBeTruthy();
		expect(report.reportPath).toContain(reportDir);

		const record = JSON.parse(readFileSync(report.reportPath as string, "utf-8"));
		// Log contents are embedded, not referenced — the machine dir gets deleted.
		expect(record.qemuLog).toContain("warning: something");
		expect(record.serialLog).toContain("MikroTik Login");
		expect(record.monitor["info status"]).toBe("VM status: paused (io-error)");
		expect(record.restProbe.counts.refused).toBe(1);
		expect(record.qemuArgs).toEqual(["qemu-system-x86_64", "-m", "512"]);
		expect(record.host.qemuProcess).toContain("alive");

		expect(report.summary).toContain("monitor info status: VM status: paused (io-error)");
	});

	// The summary is appended to a thrown QuickCHRError, which the CLI prints and
	// CI echoes into public job logs. serial.log can hold the generated
	// provisioning password in cleartext, so it must stay in the report only.
	test("never puts serial.log content into the error summary", async () => {
		const machineDir = scratch();
		const reportDir = join(scratch(), "failures");
		writeFileSync(join(machineDir, "serial.log"), 'MikroTik Login: admin\n/user add name=q password="SuperSecret123"\n');
		writeFileSync(join(machineDir, "qemu.log"), "qemu: some warning\n");

		const report = await captureBootFailure({
			name: "leaky", machineDir, reportDir, arch: "x86", accel: "kvm", bootTimeoutMs: 1000, phase: "unit",
		});

		expect(report.summary).not.toContain("SuperSecret123");
		expect(report.summary).not.toContain("/user add");
		expect(report.summary).toContain("serial.log:");
		expect(report.summary).toContain("not inlined");
		// qemu.log carries no credentials and stays inline — it is the useful tail.
		expect(report.summary).toContain("some warning");
		// The full text is still preserved in the report itself.
		const record = JSON.parse(readFileSync(report.reportPath as string, "utf-8"));
		expect(record.serialLog).toContain("SuperSecret123");
	});

	test("prunes to the newest MAX_BOOT_FAILURE_REPORTS reports", async () => {
		const dir = scratch();
		// 25 stale reports with sortable ISO-ish stamps, plus one non-report file.
		for (let i = 0; i < 25; i++) {
			writeFileSync(join(dir, `boot-failure-m-2026-07-27T00-00-${String(i).padStart(2, "0")}-000Z.json`), "{}");
		}
		writeFileSync(join(dir, "unrelated.json"), "{}");

		pruneBootFailureReports(dir);

		const left = readdirSync(dir).filter((f) => f.startsWith("boot-failure-")).sort();
		expect(left.length).toBe(MAX_BOOT_FAILURE_REPORTS);
		// Newest kept, oldest dropped.
		expect(left.at(-1)).toContain("00-00-24");
		expect(left[0]).toContain("00-00-05");
		expect(existsSync(join(dir, "unrelated.json"))).toBe(true);
	});

	test("pruneBootFailureReports tolerates a missing directory", () => {
		expect(() => pruneBootFailureReports(join(tmpdir(), "quickchr-no-such-dir-9182"))).not.toThrow();
	});

	test("never throws when the machine directory is gone and no monitor is reachable", async () => {
		const reportDir = join(scratch(), "failures");
		const report = await captureBootFailure({
			name: "vanished",
			machineDir: join(tmpdir(), "quickchr-does-not-exist-12345"),
			reportDir,
			arch: "arm64",
			accel: "tcg",
			bootTimeoutMs: 480_000,
			phase: "unit",
		});
		expect(report.reportPath).toBeTruthy();
		const record = JSON.parse(readFileSync(report.reportPath as string, "utf-8"));
		expect(record.qemuLog).toBe("<absent>");
		expect(record.machineDirListing).toEqual([]);
		expect(record.host.qemuProcess).toContain("unknown");
	});

	test("preserved flag mirrors QUICKCHR_PRESERVE_ON_FAILURE", async () => {
		const reportDir = join(scratch(), "failures");
		const base = { name: "n", machineDir: scratch(), reportDir, arch: "x86", accel: "tcg", bootTimeoutMs: 1, phase: "unit" };

		expect((await captureBootFailure(base)).preserved).toBe(false);
		process.env.QUICKCHR_PRESERVE_ON_FAILURE = "1";
		expect((await captureBootFailure(base)).preserved).toBe(true);
	});
});
