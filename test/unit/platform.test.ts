import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
	detectAccel,
	detectPackageManager,
	detectPhysicalInterfaces,
	findCommandOnPath,
	findQemuBinary,
	findEfiFirmware,
	findQemuImg,
	getQemuInstallHint,
	getQemuVersion,
	isAppleSiliconHost,
	resetAppleSiliconHostCache,
	qgaKvmWarning,
	accelNote,
	resolveAccelOverride,
	setAccelOverride,
	requireQemu,
	requireFirmware,
	resolveInterfaceAlias,
	isCrossArchEmulation,
} from "../../src/lib/platform.ts";

const originalSpawnSync = Bun.spawnSync;
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
const originalArchDescriptor = Object.getOwnPropertyDescriptor(process, "arch");

function restoreRuntimeDetection(): void {
	(Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = originalSpawnSync;
	if (originalPlatformDescriptor) {
		Object.defineProperty(process, "platform", originalPlatformDescriptor);
	}
	if (originalArchDescriptor) {
		Object.defineProperty(process, "arch", originalArchDescriptor);
	}
}

function setPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function setArch(arch: NodeJS.Architecture): void {
	Object.defineProperty(process, "arch", { value: arch, configurable: true });
}

function stdout(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

function mockSpawnSync(
	impl: (cmd: string[]) => { exitCode: number; stdout?: string; stderr?: string },
) {
	const spawn = mock((cmd: string[]) => {
		const result = impl(cmd);
		return {
			exitCode: result.exitCode,
			stdout: stdout(result.stdout ?? ""),
			stderr: stdout(result.stderr ?? ""),
		} as unknown as ReturnType<typeof Bun.spawnSync>;
	});
	(Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = spawn as unknown as typeof Bun.spawnSync;
	return spawn;
}

// Pin the accelerator override tier for every test: without this, resolveAccelOverride()
// falls through to the real QUICKCHR_ACCEL env var and ~/.config/quickchr/quickchr.env,
// so a developer who has forced an accelerator would see these tests fail.
beforeEach(() => {
	setAccelOverride("auto");
	resetAppleSiliconHostCache();
});

afterEach(() => {
	restoreRuntimeDetection();
	setAccelOverride(undefined);
	resetAppleSiliconHostCache();
	mock.restore();
});

describe("detectPackageManager", () => {
	test("returns a valid package manager", () => {
		const pm = detectPackageManager();
		expect(["brew", "apt", "dnf", "pacman", "winget", "unknown"]).toContain(pm);
	});

	test("on macOS returns brew or unknown", () => {
		if (process.platform === "darwin") {
			const pm = detectPackageManager();
			expect(["brew", "unknown"]).toContain(pm);
		}
	});

	test("on Linux chooses the first available package manager in priority order", () => {
		setPlatform("linux");
		const calls: string[] = [];
		mockSpawnSync((cmd) => {
			expect(cmd[0]).toBe("which");
			calls.push(cmd[1] ?? "");
			if (cmd[1] === "dnf") {
				return { exitCode: 0, stdout: "/usr/bin/dnf\n" };
			}
			return { exitCode: 1 };
		});

		expect(detectPackageManager()).toBe("dnf");
		expect(calls).toEqual(["apt", "dnf"]);
	});

	test("on Linux returns unknown when no known package manager is found", () => {
		setPlatform("linux");
		mockSpawnSync(() => ({ exitCode: 1 }));

		expect(detectPackageManager()).toBe("unknown");
	});
});

describe("findCommandOnPath", () => {
	test("returns the first non-empty path from command lookup output", () => {
		setPlatform("linux");
		mockSpawnSync((cmd) => {
			expect(cmd).toEqual(["which", "qemu-img"]);
			return { exitCode: 0, stdout: "\n  /toolchain/bin/qemu-img  \n/usr/bin/qemu-img\n" };
		});

		expect(findCommandOnPath("qemu-img")).toBe("/toolchain/bin/qemu-img");
	});

	test("uses where.exe on Windows and returns undefined on lookup failure", () => {
		setPlatform("win32");
		mockSpawnSync((cmd) => {
			expect(cmd).toEqual(["where.exe", "qemu-img"]);
			return { exitCode: 1, stderr: "INFO: Could not find files" };
		});

		expect(findCommandOnPath("qemu-img")).toBeUndefined();
	});
});

describe("findQemuBinary", () => {
	test("returns path or undefined for arm64", () => {
		const bin = findQemuBinary("arm64");
		if (bin) {
			expect(bin).toContain("qemu-system-aarch64");
		}
		// Undefined is also acceptable (QEMU not installed)
	});

	test("returns path or undefined for x86", () => {
		const bin = findQemuBinary("x86");
		if (bin) {
			expect(bin).toContain("qemu-system-x86_64");
		}
	});

	test("resolves x86 binary from mocked PATH lookup without requiring host QEMU", () => {
		setPlatform("linux");
		mockSpawnSync((cmd) => {
			if (cmd[1] === "qemu-system-x86_64") {
				return { exitCode: 0, stdout: "/mock/bin/qemu-system-x86_64\n" };
			}
			return { exitCode: 1 };
		});

		expect(findQemuBinary("x86")).toBe("/mock/bin/qemu-system-x86_64");
		expect(findQemuBinary("arm64")).toBeUndefined();
	});
});

describe("findQemuImg", () => {
	test("returns path or undefined", () => {
		const bin = findQemuImg();
		if (bin) {
			expect(bin).toContain("qemu-img");
		}
	});

	test("resolves qemu-img from mocked PATH lookup", () => {
		setPlatform("linux");
		mockSpawnSync((cmd) => {
			expect(cmd).toEqual(["which", "qemu-img"]);
			return { exitCode: 0, stdout: "/mock/bin/qemu-img\n" };
		});

		expect(findQemuImg()).toBe("/mock/bin/qemu-img");
	});
});

describe("getQemuInstallHint", () => {
	test("returns a string with install command", () => {
		const hint = getQemuInstallHint();
		if (hint) {
			expect(typeof hint).toBe("string");
			expect(hint.length).toBeGreaterThan(0);
		}
	});

	test("brew: returns brew install qemu", () => {
		expect(getQemuInstallHint("brew")).toContain("brew install qemu");
	});

	test("apt: returns apt install command", () => {
		expect(getQemuInstallHint("apt")).toContain("apt install");
		expect(getQemuInstallHint("apt")).toContain("qemu-utils");
	});

	test("dnf: returns dnf install command", () => {
		expect(getQemuInstallHint("dnf")).toContain("dnf install");
		expect(getQemuInstallHint("dnf")).toContain("qemu-img");
	});

	test("pacman: returns pacman command", () => {
		expect(getQemuInstallHint("pacman")).toContain("pacman");
		expect(getQemuInstallHint("pacman")).toContain("qemu");
	});

	test("winget: returns winget install command for SoftwareFreedomConservancy.QEMU only", () => {
		const hint = getQemuInstallHint("winget");
		// Must point to the SFC package (standard QEMU for Windows, includes qemu-img)
		expect(hint).toBe("winget install SoftwareFreedomConservancy.QEMU");
		// Must NOT suggest the outdated cloudbase/qemu-img standalone package (only v2.3.0 exists)
		expect(hint).not.toContain("cloudbase");
	});

	test("unknown: returns generic install note", () => {
		expect(getQemuInstallHint("unknown")).toContain("qemu-img");
	});
});

describe("getQemuVersion", () => {
	test("returns undefined for a nonexistent binary path", () => {
		const result = getQemuVersion("/nonexistent/path/to/qemu-binary");
		expect(result).toBeUndefined();
	});

	test("returns a version string matching semver when QEMU is installed", () => {
		const bin = findQemuBinary("x86") ?? findQemuBinary("arm64");
		if (!bin) {
			console.log("Skipping: QEMU not installed");
			return;
		}
		const version = getQemuVersion(bin);
		if (version !== undefined) {
			expect(version).toMatch(/^\d+\.\d+/);
		}
	});

	test("parses version from mocked qemu --version output", () => {
		mockSpawnSync((cmd) => {
			expect(cmd).toEqual(["/mock/bin/qemu-system-x86_64", "--version"]);
			return { exitCode: 0, stdout: "QEMU emulator version 8.2.3\nCopyright...\n" };
		});

		expect(getQemuVersion("/mock/bin/qemu-system-x86_64")).toBe("8.2.3");
	});

	test("returns undefined when version command succeeds with unexpected output", () => {
		mockSpawnSync(() => ({ exitCode: 0, stdout: "not qemu output" }));

		expect(getQemuVersion("/mock/bin/qemu-system-x86_64")).toBeUndefined();
	});
});

describe("requireQemu", () => {
	test("returns binary path when QEMU is installed", () => {
		const bin = findQemuBinary("x86");
		if (!bin) {
			console.log("Skipping: QEMU x86 not installed");
			return;
		}
		const result = requireQemu("x86");
		expect(result).toContain("qemu-system-x86_64");
	});

	test("throws MISSING_QEMU with the requested architecture in the message", () => {
		setPlatform("linux");
		mockSpawnSync(() => ({ exitCode: 1 }));

		expect(() => requireQemu("arm64")).toThrow(
			expect.objectContaining({
				code: "MISSING_QEMU",
				message: expect.stringContaining("qemu-system-aarch64"),
			}),
		);
	});
});

describe("requireFirmware", () => {
	test("returns firmware paths when EFI firmware is installed", () => {
		const fw = findEfiFirmware();
		if (!fw) {
			console.log("Skipping: EFI firmware not installed");
			return;
		}
		const result = requireFirmware();
		expect(result).toHaveProperty("code");
		expect(result).toHaveProperty("vars");
	});

	test("throws MISSING_FIRMWARE when EFI firmware is absent", () => {
		const fw = findEfiFirmware();
		if (fw) {
			console.log("Skipping: EFI firmware is present on this system");
			return;
		}
		expect(() => requireFirmware()).toThrow(
			expect.objectContaining({ code: "MISSING_FIRMWARE" }),
		);
	});
});

describe("qgaKvmWarning", () => {
	test("returns null on Linux", () => {
		setPlatform("linux");

		expect(qgaKvmWarning()).toBeNull();
	});

	test("describes the non-KVM platform in warnings", () => {
		setPlatform("darwin");
		expect(qgaKvmWarning()).toContain("macOS (HVF)");

		setPlatform("win32");
		expect(qgaKvmWarning()).toContain("Windows");
	});
});

describe("isCrossArchEmulation", () => {
	test("compares both guest architectures to an arm64 host", () => {
		setPlatform("darwin");
		setArch("arm64");
		expect(isCrossArchEmulation("arm64")).toBe(false);
		expect(isCrossArchEmulation("x86")).toBe(true);
	});

	test("compares both guest architectures to an x86_64 host", () => {
		setPlatform("linux");
		setArch("x64");
		expect(isCrossArchEmulation("arm64")).toBe(true);
		expect(isCrossArchEmulation("x86")).toBe(false);
	});
});

describe("detectAccel", () => {
	test("returns kvm on Linux only when host and guest architecture match and /dev/kvm is writable", async () => {
		setPlatform("linux");
		setArch("x64");
		const calls: string[][] = [];
		mockSpawnSync((cmd) => {
			calls.push(cmd);
			expect(cmd).toEqual(["test", "-w", "/dev/kvm"]);
			return { exitCode: 0 };
		});

		expect(await detectAccel("x86")).toBe("kvm");
		expect(await detectAccel("arm64")).toBe("tcg");
		expect(calls).toEqual([["test", "-w", "/dev/kvm"]]);
	});

	test("falls back to tcg on Linux when matching-arch KVM probe fails", async () => {
		setPlatform("linux");
		setArch("arm64");
		mockSpawnSync(() => ({ exitCode: 1 }));

		expect(await detectAccel("arm64")).toBe("tcg");
	});

	test("returns hvf on macOS for x86 when Hypervisor Framework is available", async () => {
		setPlatform("darwin");
		setArch("x64");
		mockSpawnSync((cmd) => {
			if (cmd.at(-1) === "sysctl.proc_translated") return { exitCode: 1 };
			expect(cmd).toEqual(["sysctl", "-n", "kern.hv_support"]);
			return { exitCode: 0, stdout: "1\n" };
		});

		expect(await detectAccel("x86")).toBe("hvf");
		expect(await detectAccel("arm64")).toBe("tcg");
	});

	test("falls back to tcg for arm64 on Apple Silicon even though HVF is available", async () => {
		setPlatform("darwin");
		setArch("arm64");
		// hv_support=1 — HVF *is* usable, but arm64 CHR ships a 32-bit ARM userspace
		// and Apple Silicon implements no AArch32 at any exception level, so an HVF
		// guest panics at init ("No working init found"). tikoci/quickchr#97.
		mockSpawnSync(() => ({ exitCode: 0, stdout: "1\n" }));

		expect(await detectAccel("arm64")).toBe("tcg");
		// x86 is cross-architecture on this physical host, so HVF is unavailable.
		expect(await detectAccel("x86")).toBe("tcg");
	});

	test("falls back to tcg for both guests when running under Rosetta on Apple Silicon", async () => {
		setPlatform("darwin");
		setArch("x64");
		mockSpawnSync((cmd) => {
			if (cmd.at(-1) === "sysctl.proc_translated") {
				return { exitCode: 0, stdout: "1\n" };
			}
			expect(cmd).toEqual(["sysctl", "-n", "kern.hv_support"]);
			return { exitCode: 0, stdout: "1\n" };
		});

		expect(await detectAccel("x86")).toBe("tcg");
		expect(await detectAccel("arm64")).toBe("tcg");
	});

	test("falls back to tcg on macOS when Hypervisor Framework is unavailable", async () => {
		setPlatform("darwin");
		setArch("x64");
		mockSpawnSync(() => ({ exitCode: 0, stdout: "0\n" }));

		expect(await detectAccel("x86")).toBe("tcg");
	});
});

describe("isAppleSiliconHost", () => {
	test("true on darwin with a native arm64 process", () => {
		setPlatform("darwin");
		setArch("arm64");
		expect(isAppleSiliconHost()).toBe(true);
	});

	test("true for a Rosetta process", () => {
		setPlatform("darwin");
		setArch("x64");
		mockSpawnSync((cmd) => {
			expect(cmd).toEqual(["sysctl", "-n", "sysctl.proc_translated"]);
			return { exitCode: 0, stdout: "1\n" };
		});
		expect(isAppleSiliconHost()).toBe(true);
	});

	test("false on an Intel Mac", () => {
		setPlatform("darwin");
		setArch("x64");
		mockSpawnSync(() => ({ exitCode: 1 }));
		expect(isAppleSiliconHost()).toBe(false);
	});

	test("false on non-darwin arm64 (Linux/Windows on ARM)", () => {
		setPlatform("linux");
		setArch("arm64");
		expect(isAppleSiliconHost()).toBe(false);
	});
});

describe("accelerator override", () => {
	test("a forced mode short-circuits detection on every platform", async () => {
		setPlatform("darwin");
		setArch("arm64");
		const spawn = mockSpawnSync(() => ({ exitCode: 0, stdout: "1\n" }));

		setAccelOverride("hvf");
		expect(resolveAccelOverride()).toBe("hvf");
		// Forced arm64 HVF on Apple Silicon — the case #97 normally downgrades.
		expect(await detectAccel("arm64")).toBe("hvf");
		// Detection never ran, so no sysctl was probed.
		expect(spawn).not.toHaveBeenCalled();
	});

	test("a forced mode is passed through verbatim even when unavailable", async () => {
		setPlatform("darwin");
		setArch("arm64");
		mockSpawnSync(() => ({ exitCode: 0, stdout: "1\n" }));

		// kvm does not exist on macOS: force means force, and QEMU reports the error.
		setAccelOverride("kvm");
		expect(await detectAccel("x86")).toBe("kvm");
	});

	test('"auto" restores normal detection', async () => {
		setPlatform("darwin");
		setArch("arm64");
		mockSpawnSync(() => ({ exitCode: 0, stdout: "1\n" }));

		setAccelOverride("hvf");
		expect(await detectAccel("arm64")).toBe("hvf");
		setAccelOverride("auto");
		expect(await detectAccel("arm64")).toBe("tcg");
	});
});

describe("accelNote", () => {
	test("explains the arm64 TCG downgrade on Apple Silicon", () => {
		setPlatform("darwin");
		setArch("arm64");

		const note = accelNote("arm64", "tcg");
		expect(note).toContain("32-bit ARM");
		expect(note).toContain("--accel hvf");
	});

	test("null for x86 guests, for HVF arm64, and on non-Apple-Silicon hosts", () => {
		setPlatform("darwin");
		setArch("arm64");
		expect(accelNote("x86", "hvf")).toBeNull();
		// arm64 under HVF is not a downgrade, so there is nothing to explain.
		expect(accelNote("arm64", "hvf")).toBeNull();

		// Intel Mac: arm64 TCG is cross-arch emulation, not the #97 fallback.
		setArch("x64");
		expect(accelNote("arm64", "tcg")).toBeNull();

		setPlatform("linux");
		setArch("x64");
		expect(accelNote("arm64", "tcg")).toBeNull();
	});

	test("reports a configured accelerator, and warns when forcing arm64 HVF on Apple Silicon", () => {
		setPlatform("darwin");
		setArch("arm64");

		setAccelOverride("hvf");
		const note = accelNote("arm64", "hvf");
		expect(note).toContain("configured");
		expect(note).toContain("No working init found");

		// x86 guests get the plain configured line with no #97 caveat.
		const x86Note = accelNote("x86", "hvf");
		expect(x86Note).toContain("configured");
		expect(x86Note).not.toContain("No working init found");
	});
});

describe("detectPhysicalInterfaces", () => {
	test("parses macOS networksetup output, filters virtual ports, and assigns aliases once", () => {
		setPlatform("darwin");
		mockSpawnSync((cmd) => {
			expect(cmd).toEqual(["networksetup", "-listallhardwareports"]);
			return {
				exitCode: 0,
				stdout: [
					"Hardware Port: Wi-Fi",
					"Device: en0",
					"Ethernet Address: aa:bb:cc:dd:ee:ff",
					"",
					"Hardware Port: USB Ethernet",
					"Device: en5",
					"Ethernet Address: 11:22:33:44:55:66",
					"",
					"Hardware Port: Thunderbolt Bridge",
					"Device: bridge0",
					"Ethernet Address: (null)",
					"",
					"Hardware Port: Ethernet",
					"Device: en7",
					"Ethernet Address: 77:88:99:aa:bb:cc",
				].join("\n"),
			};
		});

		expect(detectPhysicalInterfaces()).toEqual([
			{ device: "en0", name: "Wi-Fi", mac: "aa:bb:cc:dd:ee:ff", alias: "wifi" },
			{ device: "en5", name: "USB Ethernet", mac: "11:22:33:44:55:66", alias: "ethernet" },
			{ device: "en7", name: "Ethernet", mac: "77:88:99:aa:bb:cc", alias: undefined },
		]);
	});

	test("returns an empty list when networksetup fails", () => {
		setPlatform("darwin");
		mockSpawnSync(() => ({ exitCode: 1 }));

		expect(detectPhysicalInterfaces()).toEqual([]);
	});
});

describe("resolveInterfaceAlias", () => {
	const wifiIface = { device: "en0", name: "Wi-Fi", alias: "wifi" as const };
	const ethernetIface = { device: "en5", name: "USB Ethernet", alias: "ethernet" as const };
	const ifaces = [wifiIface, ethernetIface];

	test("passes through non-alias interface names", () => {
		expect(resolveInterfaceAlias("bridge100", ifaces)).toBe("bridge100");
	});

	test("auto prefers ethernet before wifi", () => {
		expect(resolveInterfaceAlias("auto", ifaces)).toBe("en5");
		expect(resolveInterfaceAlias("auto", [wifiIface])).toBe("en0");
	});

	test("throws NETWORK_UNAVAILABLE when an alias has no match", () => {
		expect(() => resolveInterfaceAlias("ethernet", [wifiIface])).toThrow(
			expect.objectContaining({
				code: "NETWORK_UNAVAILABLE",
				message: expect.stringContaining("ethernet"),
			}),
		);
	});
});
