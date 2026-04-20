/**
 * Windows-only unit tests for QEMU channel IPC (TCP localhost).
 * Skipped automatically on macOS and Linux.
 *
 * On Windows, QEMU channels use TCP localhost instead of named pipes or Unix sockets
 * because QEMU's Winsock bind() cannot handle \\.\pipe\ paths.
 * These tests verify that:
 * - buildQemuArgs produces host=127.0.0.1,port=portBase+N TCP chardev args
 * - monitorCommand / serialStreams throw MACHINE_STOPPED when the TCP port is not listening
 * - stopMachineByName does not crash on missing .sock files (there are none on Windows)
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildQemuArgs, stopMachineByName, type QemuLaunchConfig } from "../../src/lib/qemu.ts";
import { monitorCommand, serialStreams } from "../../src/lib/channels.ts";
import type { PortMapping } from "../../src/lib/types.ts";

const isWindows = process.platform === "win32";

describe.skipIf(!isWindows)("Windows TCP channel paths in buildQemuArgs", () => {
const machineDir = join(tmpdir(), "quickchr-win-channels-test");

function makeConfig(background: boolean): QemuLaunchConfig {
const ports: Record<string, PortMapping> = {
http: { name: "http", host: 9100, guest: 80, proto: "tcp" },
ssh: { name: "ssh", host: 9102, guest: 22, proto: "tcp" },
};
return {
arch: "x86",
machineDir,
bootDisk: { path: join(machineDir, "disk.img"), format: "raw" },
mem: 512,
cpu: 1,
ports,
portBase: 9100,
background,
networks: [{ specifier: "user", id: "net0" }],
};
}

beforeEach(() => mkdirSync(machineDir, { recursive: true }));
afterEach(() => rmSync(machineDir, { recursive: true, force: true }));

test("background mode: monitor chardev uses TCP localhost port", async () => {
try {
const args = await buildQemuArgs(makeConfig(true));
const monitorArg = args.find((a) => a.includes("monitor0") && a.includes("host=127.0.0.1"));
expect(monitorArg).toBeDefined();
expect(monitorArg).toContain("host=127.0.0.1,port=9106");
} catch (e: unknown) {
if (e && typeof e === "object" && "code" in e) {
const code = (e as { code: string }).code;
if (code === "MISSING_QEMU" || code === "MISSING_FIRMWARE") return;
}
throw e;
}
});

test("background mode: serial chardev uses TCP localhost port", async () => {
try {
const args = await buildQemuArgs(makeConfig(true));
const serialArg = args.find((a) => a.includes("serial0") && a.includes("host=127.0.0.1"));
expect(serialArg).toBeDefined();
expect(serialArg).toContain("host=127.0.0.1,port=9107");
} catch (e: unknown) {
if (e && typeof e === "object" && "code" in e) {
const code = (e as { code: string }).code;
if (code === "MISSING_QEMU" || code === "MISSING_FIRMWARE") return;
}
throw e;
}
});

test("foreground mode: monitor chardev still uses TCP localhost port", async () => {
try {
const args = await buildQemuArgs(makeConfig(false));
const monitorArg = args.find((a) => a.includes("monitor0") && a.includes("host=127.0.0.1"));
expect(monitorArg).toBeDefined();
expect(monitorArg).toContain("host=127.0.0.1,port=9106");
} catch (e: unknown) {
if (e && typeof e === "object" && "code" in e) {
const code = (e as { code: string }).code;
if (code === "MISSING_QEMU" || code === "MISSING_FIRMWARE") return;
}
throw e;
}
});

test("QGA chardev uses TCP localhost port (x86)", async () => {
try {
const args = await buildQemuArgs(makeConfig(true));
const qgaArg = args.find((a) => a.includes("qga0") && a.includes("host=127.0.0.1"));
expect(qgaArg).toBeDefined();
expect(qgaArg).toContain("host=127.0.0.1,port=9108");
} catch (e: unknown) {
if (e && typeof e === "object" && "code" in e) {
const code = (e as { code: string }).code;
if (code === "MISSING_QEMU" || code === "MISSING_FIRMWARE") return;
}
throw e;
}
});
});

describe.skipIf(!isWindows)("Windows channel error paths (TCP port not listening)", () => {
const TMP = join(tmpdir(), "quickchr-win-channels-err-test");

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

test("monitorCommand throws MACHINE_STOPPED when TCP port is not listening", async () => {
// On Windows, channelFileExists() always returns true (pipes aren't filesystem entries).
// TCP connect to a non-listening port throws ECONNREFUSED -> MACHINE_STOPPED.
await expect(monitorCommand(TMP, "info", 3000)).rejects.toMatchObject({
code: "MACHINE_STOPPED",
});
});

test("serialStreams returns streams without throwing when TCP port is not listening (deferred error)", () => {
// serialStreams() creates and returns stream objects without checking port availability;
// the MACHINE_STOPPED error surfaces asynchronously when the streams are consumed.
const result = serialStreams(TMP);
expect(result).toHaveProperty("readable");
expect(result).toHaveProperty("writable");
});
});

describe.skipIf(!isWindows)("Windows stopMachineByName -- no .sock files to clean up", () => {
const TMP = join(tmpdir(), "quickchr-win-stop-test");

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

function makeMachineState(overrides: Partial<{ pid: number }> = {}) {
return {
name: "test",
version: "7.22.1",
arch: "x86" as const,
cpu: 1,
mem: 512,
networks: [{ specifier: "user" as const, id: "net0" }],
ports: {},
packages: [],
portBase: 9100,
excludePorts: [],
extraPorts: [],
createdAt: new Date().toISOString(),
status: "stopped" as const,
machineDir: TMP,
...overrides,
};
}

test("stops gracefully even when no .sock files exist in machineDir", async () => {
const state = makeMachineState({ pid: 999_999_999 });
// stopMachineByName returns false when the PID is already dead
// (.resolves.not.toThrow() fails in Bun when the promise resolves with `false`)
await expect(stopMachineByName("test", state)).resolves.toBe(false);
});

test("no .sock files are created or expected in machineDir", async () => {
const state = makeMachineState({ pid: 999_999_999 });
await stopMachineByName("test", state);
expect(existsSync(join(TMP, "monitor.sock"))).toBe(false);
expect(existsSync(join(TMP, "serial.sock"))).toBe(false);
expect(existsSync(join(TMP, "qga.sock"))).toBe(false);
});
});
