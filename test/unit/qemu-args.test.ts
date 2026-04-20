import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
	buildQemuArgs,
	buildQemuErrorMessage,
	spawnQemu,
	stopQemu,
	stopMachineByName,
	waitForBoot,
	type QemuLaunchConfig,
} from "../../src/lib/qemu.ts";
import type { MachineState, PortMapping } from "../../src/lib/types.ts";

// These tests verify QEMU arg generation without spawning QEMU.
// They depend on QEMU being installed (for binary path resolution).

function makeConfig(overrides: Partial<QemuLaunchConfig> = {}): QemuLaunchConfig {
	const ports: Record<string, PortMapping> = {
		http: { name: "http", host: 9100, guest: 80, proto: "tcp" },
		ssh: { name: "ssh", host: 9102, guest: 22, proto: "tcp" },
	};

	return {
		arch: "arm64",
		machineDir: "/tmp/quickchr-test-machine",
		bootDisk: { path: "/tmp/quickchr-test-machine/disk.img", format: "raw" },
		mem: 512,
		cpu: 1,
		ports,
		networks: [{ specifier: "user", id: "net0" }],
		background: true,
		...overrides,
	};
}

describe("buildQemuArgs", () => {
	test("arm64 uses virt machine type", async () => {
		try {
			const args = await buildQemuArgs(makeConfig({ arch: "arm64" }));
			expect(args).toContain("-M");
			const machineIdx = args.indexOf("-M");
			expect(args[machineIdx + 1]).toBe("virt");
		} catch (e: unknown) {
			// Skip if QEMU not installed
			if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "MISSING_QEMU") {
				console.log("Skipping: QEMU not installed");
				return;
			}
			throw e;
		}
	});

	test("x86 uses pc machine type", async () => {
		try {
			const args = await buildQemuArgs(makeConfig({ arch: "x86" }));
			const machineIdx = args.indexOf("-M");
			expect(args[machineIdx + 1]).toBe("pc");
		} catch (e: unknown) {
			// Skip if QEMU not installed
			if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "MISSING_QEMU") {
				console.log("Skipping: QEMU not installed");
				return;
			}
			throw e;
		}
	});

	test("arm64 uses explicit virtio-blk-pci", async () => {
		try {
			const args = await buildQemuArgs(makeConfig({ arch: "arm64" }));
			// Must NOT have if=virtio for arm64
			const driveArgs = args.filter((a) => a.includes("disk.img"));
			for (const d of driveArgs) {
				expect(d).not.toContain("if=virtio");
			}
			// Must have virtio-blk-pci device
			expect(args).toContain("virtio-blk-pci,drive=drive0");
		} catch (e: unknown) {
			if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "MISSING_QEMU") {
				console.log("Skipping: QEMU not installed");
				return;
			}
			if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "MISSING_FIRMWARE") {
				console.log("Skipping: UEFI firmware not installed");
				return;
			}
			throw e;
		}
	});

	test("sets memory and CPU", async () => {
		try {
			const args = await buildQemuArgs(makeConfig({ mem: 1024, cpu: 2 }));
			const memIdx = args.indexOf("-m");
			expect(args[memIdx + 1]).toBe("1024");
			const smpIdx = args.indexOf("-smp");
			expect(args[smpIdx + 1]).toBe("2");
		} catch (e: unknown) {
			if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "MISSING_QEMU") {
				console.log("Skipping: QEMU not installed");
				return;
			}
			if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "MISSING_FIRMWARE") {
				console.log("Skipping: UEFI firmware not installed");
				return;
			}
			throw e;
		}
	});

	test("includes hostfwd for user networking", async () => {
		try {
			const args = await buildQemuArgs(makeConfig({ networks: [{ specifier: "user", id: "net0" }] }));
			const netdevArg = args.find((a) => a.startsWith("user,id=net0"));
			expect(netdevArg).toBeDefined();
			expect(netdevArg).toContain("hostfwd=tcp::9100-:80");
			expect(netdevArg).toContain("hostfwd=tcp::9102-:22");
		} catch (e: unknown) {
			if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "MISSING_QEMU") {
				console.log("Skipping: QEMU not installed");
				return;
			}
			if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "MISSING_FIRMWARE") {
				console.log("Skipping: UEFI firmware not installed");
				return;
			}
			throw e;
		}
	});

	test("background mode uses socket channels", async () => {
		try {
			const args = await buildQemuArgs(makeConfig({ background: true }));
			// On Unix: .sock files; on Windows: named pipes (\\.\pipe\...-serial / ...-monitor)
			// Both appear as a `path=` value in a -chardev socket arg.
			const serialArg = args.find((a) => a.includes("serial0") && a.includes("path="));
			expect(serialArg).toBeDefined();
			const monitorArg = args.find((a) => a.includes("monitor0") && a.includes("path="));
			expect(monitorArg).toBeDefined();
		} catch (e: unknown) {
			if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "MISSING_QEMU") {
				console.log("Skipping: QEMU not installed");
				return;
			}
			if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "MISSING_FIRMWARE") {
				console.log("Skipping: UEFI firmware not installed");
				return;
			}
			throw e;
		}
	});

	test("foreground mode uses stdio and still binds monitor socket", async () => {
		try {
			const args = await buildQemuArgs(makeConfig({ background: false }));
			const stdioArg = args.find((a) => a.includes("stdio"));
			expect(stdioArg).toBeDefined();
			// Monitor socket is present in both Unix (.sock) and Windows (named pipe) modes
			const monitorArg = args.find((a) => a.includes("monitor0") && a.includes("path="));
			expect(monitorArg).toBeDefined();
		} catch (e: unknown) {
			if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "MISSING_QEMU") {
				console.log("Skipping: QEMU not installed");
				return;
			}
			if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "MISSING_FIRMWARE") {
				console.log("Skipping: UEFI firmware not installed");
				return;
			}
			throw e;
		}
	});
});

describe("buildQemuErrorMessage", () => {
	test("classifies permission denied", () => {
		const msg = buildQemuErrorMessage("qemu: open /some/file: Permission denied");
		expect(msg).toContain("permission denied");
		expect(msg).toContain("check image file permissions");
	});

	test("classifies EFI / pflash size mismatch", () => {
		const msg = buildQemuErrorMessage("pflash: drive size (67108864) larger than 67108863");
		expect(msg).toContain("EFI firmware size mismatch");
		expect(msg).toContain("quickchr clean");
	});

	test("classifies port already in use", () => {
		const msg = buildQemuErrorMessage("inet_listen_opts: bind(ipv4,0.0.0.0,9100): Address already in use");
		expect(msg).toContain("port already in use");
	});

	test("fallback message for unrecognized log", () => {
		const msg = buildQemuErrorMessage("some unknown error");
		expect(msg).toContain("QEMU exited immediately");
		expect(msg).toContain("some unknown error");
	});

	test("classifies EFI size mismatch via EFI+size pattern", () => {
		const msg = buildQemuErrorMessage("EFI: unable to open drive size mismatch detected");
		expect(msg).toContain("EFI firmware size mismatch");
	});
});

describe("buildQemuArgs — acceleration", () => {
	// These tests are platform-aware: we can't control which accelerator is
	// selected, but we CAN assert invariants that must hold regardless.

	test("TCG accel always includes tb-size=256", async () => {
		try {
			// On arm64 hosts, x86 QEMU must use tcg. On x86 hosts, arm64 uses tcg.
			// Test both arch combos and assert the invariant when tcg is selected.
			for (const arch of ["arm64", "x86"] as const) {
				const args = await buildQemuArgs(makeConfig({ arch }));
				const accelIdx = args.indexOf("-accel");
				expect(accelIdx).toBeGreaterThan(-1);
				const accelValue = args[accelIdx + 1] ?? "";
				if (accelValue.startsWith("tcg")) {
					expect(accelValue).toContain("tb-size=256");
				}
			}
		} catch (e: unknown) {
			if (e && typeof e === "object" && "code" in e &&
				((e as { code: string }).code === "MISSING_QEMU" || (e as { code: string }).code === "MISSING_FIRMWARE")) {
				console.log("Skipping: QEMU/firmware not installed");
				return;
			}
			throw e;
		}
	});

	test("arm64 TCG uses cortex-a710 CPU model; HVF uses host", async () => {
		try {
			const args = await buildQemuArgs(makeConfig({ arch: "arm64" }));
			const accelValue = args[args.indexOf("-accel") + 1] ?? "";
			const cpuValue = args[args.indexOf("-cpu") + 1] ?? "";
			if (accelValue.startsWith("tcg")) {
				expect(cpuValue).toBe("cortex-a710");
			} else if (accelValue === "hvf") {
				expect(cpuValue).toBe("host");
			}
			// kvm on Linux: also expects "host" but may vary — don't assert
		} catch (e: unknown) {
			if (e && typeof e === "object" && "code" in e &&
				((e as { code: string }).code === "MISSING_QEMU" || (e as { code: string }).code === "MISSING_FIRMWARE")) {
				console.log("Skipping: QEMU/firmware not installed");
				return;
			}
			throw e;
		}
	});

	test("x86 HVF uses host CPU model", async () => {
		try {
			const args = await buildQemuArgs(makeConfig({ arch: "x86" }));
			const accelValue = args[args.indexOf("-accel") + 1] ?? "";
			const cpuIdx = args.indexOf("-cpu");
			if (accelValue === "hvf") {
				expect(cpuIdx).toBeGreaterThan(-1);
				expect(args[cpuIdx + 1]).toBe("host");
			} else {
				expect(cpuIdx).toBe(-1);
			}
		} catch (e: unknown) {
			if (e && typeof e === "object" && "code" in e &&
				((e as { code: string }).code === "MISSING_QEMU" || (e as { code: string }).code === "MISSING_FIRMWARE")) {
				console.log("Skipping: QEMU/firmware not installed");
				return;
			}
			throw e;
		}
	});
});

describe("buildQemuArgs — boot disk format", () => {
	test("boot disk uses raw format in drive arg", async () => {
		try {
			const args = await buildQemuArgs(makeConfig({
				bootDisk: { path: "/tmp/quickchr-test-machine/disk.img", format: "raw" },
			}));
			const driveArg = args.find((a) => a.includes("disk.img"));
			expect(driveArg).toBeDefined();
			expect(driveArg).toContain("format=raw");
		} catch (e: unknown) {
			if (e && typeof e === "object" && "code" in e &&
				((e as { code: string }).code === "MISSING_QEMU" || (e as { code: string }).code === "MISSING_FIRMWARE")) {
				console.log("Skipping: QEMU/firmware not installed");
				return;
			}
			throw e;
		}
	});

	test("boot disk uses qcow2 format in drive arg", async () => {
		try {
			const args = await buildQemuArgs(makeConfig({
				bootDisk: { path: "/tmp/quickchr-test-machine/boot.qcow2", format: "qcow2" },
			}));
			const driveArg = args.find((a) => a.includes("boot.qcow2"));
			expect(driveArg).toBeDefined();
			expect(driveArg).toContain("format=qcow2");
		} catch (e: unknown) {
			if (e && typeof e === "object" && "code" in e &&
				((e as { code: string }).code === "MISSING_QEMU" || (e as { code: string }).code === "MISSING_FIRMWARE")) {
				console.log("Skipping: QEMU/firmware not installed");
				return;
			}
			throw e;
		}
	});
});

describe("buildQemuArgs — extra disks", () => {
	test("arm64 extra disks use virtio-blk-pci with sequential IDs", async () => {
		try {
			const args = await buildQemuArgs(makeConfig({
				arch: "arm64",
				extraDisks: [
					{ path: "/tmp/quickchr-test-machine/extra-0.qcow2", format: "qcow2" },
					{ path: "/tmp/quickchr-test-machine/extra-1.qcow2", format: "qcow2" },
				],
			}));
			// Extra disk 0 → drive1, extra disk 1 → drive2
			const drive1Arg = args.find((a) => a.includes("extra-0.qcow2"));
			expect(drive1Arg).toBeDefined();
			expect(drive1Arg).toContain("id=drive1");
			expect(drive1Arg).toContain("if=none");
			expect(args).toContain("virtio-blk-pci,drive=drive1");

			const drive2Arg = args.find((a) => a.includes("extra-1.qcow2"));
			expect(drive2Arg).toBeDefined();
			expect(drive2Arg).toContain("id=drive2");
			expect(args).toContain("virtio-blk-pci,drive=drive2");
		} catch (e: unknown) {
			if (e && typeof e === "object" && "code" in e &&
				((e as { code: string }).code === "MISSING_QEMU" || (e as { code: string }).code === "MISSING_FIRMWARE")) {
				console.log("Skipping: QEMU/firmware not installed");
				return;
			}
			throw e;
		}
	});

	test("x86 extra disks use if=virtio", async () => {
		try {
			const args = await buildQemuArgs(makeConfig({
				arch: "x86",
				extraDisks: [
					{ path: "/tmp/quickchr-test-machine/extra-0.qcow2", format: "qcow2" },
				],
			}));
			const driveArg = args.find((a) => a.includes("extra-0.qcow2"));
			expect(driveArg).toBeDefined();
			expect(driveArg).toContain("if=virtio");
			expect(driveArg).toContain("format=qcow2");
			// x86 should NOT have virtio-blk-pci for extra disks
			expect(args).not.toContain("virtio-blk-pci,drive=drive1");
		} catch (e: unknown) {
			if (e && typeof e === "object" && "code" in e &&
				((e as { code: string }).code === "MISSING_QEMU" || (e as { code: string }).code === "MISSING_FIRMWARE")) {
				console.log("Skipping: QEMU/firmware not installed");
				return;
			}
			throw e;
		}
	});

	test("no extra disk args when extraDisks is undefined", async () => {
		try {
			const args = await buildQemuArgs(makeConfig({ extraDisks: undefined }));
			// Only boot disk (drive0) should exist, no drive1
			const drive1Args = args.filter((a) => a.includes("drive1"));
			expect(drive1Args).toHaveLength(0);
		} catch (e: unknown) {
			if (e && typeof e === "object" && "code" in e &&
				((e as { code: string }).code === "MISSING_QEMU" || (e as { code: string }).code === "MISSING_FIRMWARE")) {
				console.log("Skipping: QEMU/firmware not installed");
				return;
			}
			throw e;
		}
	});
});

describe("buildQemuArgs — network modes", () => {
	test("vmnet-shared produces vmnet-shared netdev", async () => {
		try {
			const args = await buildQemuArgs(makeConfig({ arch: "x86", networks: [{ specifier: "vmnet-shared", id: "net0" }] }));
			const netdevArg = args.find((a) => a.startsWith("vmnet-shared,id=net0"));
			expect(netdevArg).toBeDefined();
			// Also has a virtio-net-pci device attached
			expect(args).toContain("virtio-net-pci,netdev=net0");
		} catch (e: unknown) {
			if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "MISSING_QEMU") {
				console.log("Skipping: QEMU not installed");
				return;
			}
			throw e;
		}
	});

	test("vmnet-bridge produces vmnet-bridged netdev with iface", async () => {
		try {
			const args = await buildQemuArgs(
				makeConfig({ arch: "x86", networks: [
					{ specifier: { type: "vmnet-bridged", iface: "en0" }, id: "net0" },
					{ specifier: "vmnet-shared", id: "net1" },
				] }),
			);
			const netdevArg = args.find((a) => a.includes("vmnet-bridged,id=net0"));
			expect(netdevArg).toBeDefined();
			expect(netdevArg).toContain("ifname=en0");
			// vmnet-bridge also adds a shared interface for OOB management
			const sharedNetdev = args.find((a) => a.startsWith("vmnet-shared,id=net1"));
			expect(sharedNetdev).toBeDefined();
		} catch (e: unknown) {
			if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "MISSING_QEMU") {
				console.log("Skipping: QEMU not installed");
				return;
			}
			throw e;
		}
	});

	test("resolved networks with qemuNetdevArgs are passed through directly", async () => {
		try {
			const preResolved = [{
				specifier: "user" as const,
				id: "net0",
				resolved: {
					qemuNetdevArgs: [
						"-netdev", "user,id=net0,hostfwd=tcp::9100-:80",
						"-device", "virtio-net-pci,netdev=net0",
					],
				},
			}];
			const args = await buildQemuArgs(makeConfig({ arch: "x86", networks: preResolved }));
			expect(args).toContain("user,id=net0,hostfwd=tcp::9100-:80");
			expect(args).toContain("virtio-net-pci,netdev=net0");
		} catch (e: unknown) {
			if (e && typeof e === "object" && "code" in e &&
				((e as { code: string }).code === "MISSING_QEMU" || (e as { code: string }).code === "MISSING_FIRMWARE")) {
				console.log("Skipping: QEMU/firmware not installed");
				return;
			}
			throw e;
		}
	});

	test("multi-NIC: 2+ networks generate correct args for each", async () => {
		try {
			const args = await buildQemuArgs(makeConfig({
				arch: "x86",
				networks: [
					{ specifier: "user", id: "net0" },
					{ specifier: { type: "socket-listen", port: 4001 }, id: "net1" },
				],
			}));
			// First NIC: user mode
			const userNetdev = args.find((a) => a.startsWith("user,id=net0"));
			expect(userNetdev).toBeDefined();
			expect(args).toContain("virtio-net-pci,netdev=net0");
			// Second NIC: socket listen
			const socketNetdev = args.find((a) => a.includes("socket,id=net1,listen=:4001"));
			expect(socketNetdev).toBeDefined();
			expect(args).toContain("virtio-net-pci,netdev=net1");
		} catch (e: unknown) {
			if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "MISSING_QEMU") {
				console.log("Skipping: QEMU not installed");
				return;
			}
			throw e;
		}
	});

	test("socket-listen fallback generates listen arg", async () => {
		try {
			const args = await buildQemuArgs(makeConfig({
				arch: "x86",
				networks: [{ specifier: { type: "socket-listen", port: 5001 }, id: "net0" }],
			}));
			const netdevArg = args.find((a) => a.includes("socket,id=net0,listen=:5001"));
			expect(netdevArg).toBeDefined();
			expect(args).toContain("virtio-net-pci,netdev=net0");
		} catch (e: unknown) {
			if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "MISSING_QEMU") {
				console.log("Skipping: QEMU not installed");
				return;
			}
			throw e;
		}
	});

	test("socket-connect fallback generates connect arg", async () => {
		try {
			const args = await buildQemuArgs(makeConfig({
				arch: "x86",
				networks: [{ specifier: { type: "socket-connect", port: 5001 }, id: "net0" }],
			}));
			const netdevArg = args.find((a) => a.includes("socket,id=net0,connect=127.0.0.1:5001"));
			expect(netdevArg).toBeDefined();
			expect(args).toContain("virtio-net-pci,netdev=net0");
		} catch (e: unknown) {
			if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "MISSING_QEMU") {
				console.log("Skipping: QEMU not installed");
				return;
			}
			throw e;
		}
	});

	test("socket-mcast fallback generates mcast arg", async () => {
		try {
			const args = await buildQemuArgs(makeConfig({
				arch: "x86",
				networks: [{ specifier: { type: "socket-mcast", group: "230.0.0.1", port: 4001 }, id: "net0" }],
			}));
			const netdevArg = args.find((a) => a.includes("socket,id=net0,mcast=230.0.0.1:4001"));
			expect(netdevArg).toBeDefined();
			expect(args).toContain("virtio-net-pci,netdev=net0");
		} catch (e: unknown) {
			if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "MISSING_QEMU") {
				console.log("Skipping: QEMU not installed");
				return;
			}
			throw e;
		}
	});

	test("tap fallback generates tap arg", async () => {
		try {
			const args = await buildQemuArgs(makeConfig({
				arch: "x86",
				networks: [{ specifier: { type: "tap", ifname: "tap-chr0" }, id: "net0" }],
			}));
			const netdevArg = args.find((a) => a.includes("tap,id=net0,ifname=tap-chr0,script=no,downscript=no"));
			expect(netdevArg).toBeDefined();
			expect(args).toContain("virtio-net-pci,netdev=net0");
		} catch (e: unknown) {
			if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "MISSING_QEMU") {
				console.log("Skipping: QEMU not installed");
				return;
			}
			throw e;
		}
	});
});

// --- spawnQemu ---

describe("spawnQemu", () => {
	test("throws SPAWN_FAILED when qemuArgs is empty", async () => {
		await expect(spawnQemu([], "/tmp/quickchr-test", true)).rejects.toMatchObject({
			code: "SPAWN_FAILED",
			message: expect.stringContaining("Empty QEMU args"),
		});
	});
});

// --- stopQemu ---

describe("stopQemu", () => {
	test("returns false when PID does not exist", async () => {
		// A PID this large is virtually guaranteed not to exist
		const result = await stopQemu(999_999_999);
		expect(result).toBe(false);
	});
});

// --- stopMachineByName ---

const TMP_STOP = join(import.meta.dir, ".tmp-qemu-stop-test");

function makeMachineState(overrides: Partial<MachineState> = {}): MachineState {
	return {
		name: "test",
		version: "7.22.1",
		arch: "x86",
		cpu: 1,
		mem: 512,
		networks: [{ specifier: "user", id: "net0" }],
		ports: {},
		packages: [],
		portBase: 9100,
		excludePorts: [],
		extraPorts: [],
		createdAt: new Date().toISOString(),
		status: "stopped",
		machineDir: TMP_STOP,
		...overrides,
	};
}

describe("stopMachineByName", () => {
	beforeEach(() => {
		mkdirSync(TMP_STOP, { recursive: true });
	});

	afterEach(() => {
		rmSync(TMP_STOP, { recursive: true, force: true });
	});

	test("returns false immediately when state has no pid", async () => {
		const state = makeMachineState({ pid: undefined });
		const result = await stopMachineByName("test", state);
		expect(result).toBe(false);
	});

	test("cleans up socket files even when PID is already dead", async () => {
		// On Windows, IPC uses named pipes (not .sock files) — skip file cleanup assertions.
		// The important invariant on all platforms is that stopMachineByName does not throw.
		if (process.platform !== "win32") {
			writeFileSync(join(TMP_STOP, "monitor.sock"), "");
			writeFileSync(join(TMP_STOP, "serial.sock"), "");
			writeFileSync(join(TMP_STOP, "qga.sock"), "");
		}

		const state = makeMachineState({ pid: 999_999_999 });
		await stopMachineByName("test", state);

		if (process.platform !== "win32") {
			expect(existsSync(join(TMP_STOP, "monitor.sock"))).toBe(false);
			expect(existsSync(join(TMP_STOP, "serial.sock"))).toBe(false);
			expect(existsSync(join(TMP_STOP, "qga.sock"))).toBe(false);
		}
	});
});

// --- waitForBoot ---

// globalThis.fetch mocking does not intercept node:http — use a real server instead.
async function withBootServer(
	handler: (req: Request) => Response | Promise<Response>,
	fn: (port: number) => Promise<void>,
) {
	const server = Bun.serve({ port: 0, fetch: handler });
	try {
		await fn(server.port ?? 0);
	} finally {
		server.stop(true);
	}
}

describe("waitForBoot", () => {
	test("returns true when HTTP server responds with 401 (auth required = booted)", async () => {
		await withBootServer(
			() => new Response("Unauthorized", { status: 401 }),
			async (port) => {
				const result = await waitForBoot(port, 8000);
				expect(result).toBe(true);
			},
		);
	}, 15_000);

	test("returns true when HTTP server responds with 200 and valid board-name body", async () => {
		await withBootServer(
			() => new Response(
				JSON.stringify({ "board-name": "CHR", "architecture-name": "x86_64" }),
				{ status: 200 },
			),
			async (port) => {
				const result = await waitForBoot(port, 8000);
				expect(result).toBe(true);
			},
		);
	}, 15_000);

	test("returns false when 200 response has user-list body (startup race — REST not fully initialized)", async () => {
		// RouterOS sometimes returns the /user list for all GET requests briefly
		// after boot during a startup race — not related to the expired admin flag.
		// waitForBoot should reject array bodies and keep polling until timeout.
		await withBootServer(
			() => new Response(
				JSON.stringify([{ name: "admin", group: "full" }]),
				{ status: 200 },
			),
			async (port) => {
				const result = await waitForBoot(port, 50);
				expect(result).toBe(false);
			},
		);
	}, 10_000);

	test("returns false when all polls fail within timeout", async () => {
		// Use a port with no server — every poll gets ECONNREFUSED
		const result = await waitForBoot(9198, 50);
		expect(result).toBe(false);
	}, 10_000);
});
