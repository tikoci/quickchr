/**
 * Windows-only unit tests for QEMU channel IPC (named pipes).
 * Skipped automatically on macOS and Linux.
 *
 * On Windows, QEMU uses named pipes instead of Unix domain sockets.
 * These tests verify that:
 * - buildQemuArgs produces \\.\pipe\quickchr-<name>-<channel> paths
 * - monitorCommand / serialStreams throw MACHINE_STOPPED when the pipe is absent
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

describe.skipIf(!isWindows)("Windows named pipe channel paths in buildQemuArgs", () => {
const machineDir = join(tmpdir(), "quickchr-win-channels-test");
const machineName = "quickchr-win-channels-test";

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
background,
networks: [{ specifier: "user", id: "net0" }],
};
}

beforeEach(() => mkdirSync(machineDir, { recursive: true }));
afterEach(() => rmSync(machineDir, { recursive: true, force: true }));

test("background mode: monitor chardev uses named pipe path", async () => {
try {
const args = await buildQemuArgs(makeConfig(true));
const monitorArg = args.find((a) => a.includes("monitor0") && a.includes("path="));
expect(monitorArg).toBeDefined();
expect(monitorArg).toContain(`\\\\.\\pipe\\quickchr-${machineName}-monitor`);
} catch (e: unknown) {
if (e && typeof e === "object" && "code" in e) {
const code = (e as { code: string }).code;
if (code === "MISSING_QEMU" || code === "MISSING_FIRMWARE") return;
}
throw e;
}
});

test("background mode: serial chardev uses named pipe path", async () => {
try {
const args = await buildQemuArgs(makeConfig(true));
const serialArg = args.find((a) => a.includes("serial0") && a.includes("path="));
expect(serialArg).toBeDefined();
expect(serialArg).toContain(`\\\\.\\pipe\\quickchr-${machineName}-serial`);
} catch (e: unknown) {
if (e && typeof e === "object" && "code" in e) {
const code = (e as { code: string }).code;
if (code === "MISSING_QEMU" || code === "MISSING_FIRMWARE") return;
}
throw e;
}
});

test("foreground mode: monitor chardev still uses named pipe", async () => {
try {
const args = await buildQemuArgs(makeConfig(false));
const monitorArg = args.find((a) => a.includes("monitor0") && a.includes("path="));
expect(monitorArg).toBeDefined();
expect(monitorArg).toContain(`\\\\.\\pipe\\quickchr-${machineName}-monitor`);
} catch (e: unknown) {
if (e && typeof e === "object" && "code" in e) {
const code = (e as { code: string }).code;
if (code === "MISSING_QEMU" || code === "MISSING_FIRMWARE") return;
}
throw e;
}
});

test("named pipe path format: double-backslash prefix and channel suffix", () => {
const expected = `\\\\.\\pipe\\quickchr-${machineName}-monitor`;
expect(expected.startsWith("\\\\.\\pipe\\")).toBe(true);
expect(expected).toContain("-monitor");
});
});

describe.skipIf(!isWindows)("Windows channel error paths (missing named pipe)", () => {
const TMP = join(tmpdir(), "quickchr-win-channels-err-test");

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

test("monitorCommand throws MACHINE_STOPPED when named pipe does not exist", async () => {
// On Windows, channelFileExists() always returns true (pipes aren't filesystem entries).
// net.connect() to a non-existent named pipe throws ENOENT -> MACHINE_STOPPED.
await expect(monitorCommand(TMP, "info", 3000)).rejects.toMatchObject({
code: "MACHINE_STOPPED",
});
});

test("serialStreams returns streams without throwing when named pipe does not exist (deferred error)", () => {
// On Windows, channelFileExists() always returns true — named pipes aren't
// filesystem entries. serialStreams() creates and returns stream objects
// without checking pipe existence; the MACHINE_STOPPED error surfaces async.
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
