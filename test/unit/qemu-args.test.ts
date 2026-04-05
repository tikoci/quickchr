import { describe, test, expect, } from "bun:test";
import { buildQemuArgs, type QemuLaunchConfig } from "../../src/lib/qemu.ts";
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

	test("x86 uses q35 machine type", async () => {
		try {
			const args = await buildQemuArgs(makeConfig({ arch: "x86" }));
			const machineIdx = args.indexOf("-M");
			expect(args[machineIdx + 1]).toBe("q35");
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

	test("foreground mode uses stdio", async () => {
		try {
			const args = await buildQemuArgs(makeConfig({ background: false }));
			const stdioArg = args.find((a) => a.includes("stdio"));
			expect(stdioArg).toBeDefined();
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
