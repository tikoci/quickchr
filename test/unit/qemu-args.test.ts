import { describe, test, expect } from "bun:test";
import { buildQemuArgs, buildQemuErrorMessage, type QemuLaunchConfig } from "../../src/lib/qemu.ts";
import type { PortMapping } from "../../src/lib/types.ts";

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
		diskPath: "/tmp/quickchr-test-machine/disk.img",
		mem: 512,
		cpu: 1,
		ports,
		network: "user",
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
			const args = await buildQemuArgs(makeConfig({ network: "user" }));
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
			const serialArg = args.find((a) => a.includes("serial.sock"));
			expect(serialArg).toBeDefined();
			const monitorArg = args.find((a) => a.includes("monitor.sock"));
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
			const monitorArg = args.find((a) => a.includes("monitor.sock"));
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
});

describe("buildQemuArgs — network modes", () => {
	test("vmnet-shared produces vmnet-shared netdev", async () => {
		try {
			const args = await buildQemuArgs(makeConfig({ arch: "x86", network: "vmnet-shared" }));
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
				makeConfig({ arch: "x86", network: { type: "vmnet-bridge", iface: "en0" } }),
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
});
