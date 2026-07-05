import { describe, expect, test } from "bun:test";
import { cleanMonitorResponse } from "../../src/lib/channels.ts";

// Anchor tests for QEMU monitor response cleaning (issue #31): the monitor
// echoes the typed command as incremental ANSI-laden fragments before the
// response, which hid `Error:` lines from the `/^error/i` checks in
// snapshot save/load — savevm failed on arm64 for months while reporting ok.

/* cspell:disable — fixtures are verbatim monitor wire bytes */
// Verbatim capture from the arm64 repro (test/lab/arm64-rollback), truncated
// echo: each keystroke renders as `text ESC[K` + ESC[D backspaces.
const SAVEVM_ERROR =
	"s[K[Dsa[K[D[Dsav[K[D[D[Dsavevm baseline[K\r\nError: Device 'pflash1' is writable but does not support snapshots";

const INFO_SNAPSHOTS_EMPTY =
	"i[K[Din[K[D[Dinfo snapshots[K\r\nThere is no snapshot available.";

const INFO_STATUS =
	"i[K[Dinfo status[K\r\nVM status: paused (restore-vm)";

/* cspell:enable */

describe("cleanMonitorResponse", () => {
	test("exposes the Error line savevm actually returned (the #31 mask)", () => {
		const cleaned = cleanMonitorResponse(SAVEVM_ERROR);
		expect(cleaned).toBe("Error: Device 'pflash1' is writable but does not support snapshots");
		// The property the snapshot code relies on:
		expect(/^error[:\s]/i.test(cleaned)).toBe(true);
	});

	test("plain responses survive with echo stripped", () => {
		expect(cleanMonitorResponse(INFO_SNAPSHOTS_EMPTY)).toBe("There is no snapshot available.");
		expect(cleanMonitorResponse(INFO_STATUS)).toBe("VM status: paused (restore-vm)");
	});

	test("multi-line responses keep all lines after the echo", () => {
		const raw = "info snapshots[K\r\nList of snapshots:\r\nID  TAG\r\n1   baseline";
		expect(cleanMonitorResponse(raw)).toBe("List of snapshots:\nID  TAG\n1   baseline");
	});

	test("empty response (successful savevm) cleans to empty string", () => {
		expect(cleanMonitorResponse("savevm ok[K\r\n")).toBe("");
	});
});
