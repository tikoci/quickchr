import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { appendBootLog, bootLogPath, type BootLogEntry } from "../../src/lib/state.ts";

// Anchor tests for the boot-history log (<dataDir>/boot-log.ndjson) — the
// durable per-boot metrics feed (machine dirs are removed by tests, so
// machine.json alone cannot carry boot timing to CI artifacts).

const TEST_DIR = join(import.meta.dir, ".tmp-boot-log-test");
const origDataDir = process.env.QUICKCHR_DATA_DIR;

function entry(over: Partial<BootLogEntry> = {}): BootLogEntry {
	return {
		ts: "2026-07-04T00:00:00.000Z",
		name: "chr-test",
		version: "7.22.1",
		arch: "x86",
		accel: "hvf",
		bootMs: 42_000,
		host: process.platform,
		...over,
	};
}

beforeEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.QUICKCHR_DATA_DIR = TEST_DIR;
});

afterEach(() => {
	if (origDataDir === undefined) delete process.env.QUICKCHR_DATA_DIR;
	else process.env.QUICKCHR_DATA_DIR = origDataDir;
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("appendBootLog", () => {
	test("creates the log and appends one JSON line per boot", () => {
		expect(existsSync(bootLogPath())).toBe(false);
		appendBootLog(entry({ name: "one" }));
		appendBootLog(entry({ name: "two", accel: "kvm" }));
		const lines = readFileSync(bootLogPath(), "utf-8").trim().split("\n");
		expect(lines.length).toBe(2);
		const first = JSON.parse(lines[0] ?? "");
		const second = JSON.parse(lines[1] ?? "");
		expect(first.name).toBe("one");
		expect(second.name).toBe("two");
		expect(second.accel).toBe("kvm");
		expect(second.bootMs).toBe(42_000);
	});

	test("rotates to the newest 500 lines past 1000", () => {
		for (let i = 0; i < 1001; i++) {
			appendBootLog(entry({ name: `boot-${i}` }));
		}
		const lines = readFileSync(bootLogPath(), "utf-8").trim().split("\n");
		expect(lines.length).toBe(500);
		expect(JSON.parse(lines[0] ?? "").name).toBe("boot-501");
		expect(JSON.parse(lines.at(-1) ?? "").name).toBe("boot-1000");
	});
});
