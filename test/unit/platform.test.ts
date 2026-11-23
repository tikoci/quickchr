import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { HostInterface } from "../../src/lib/types.ts";
import {
	detectAccel,
	detectPackageManager,
	detectPhysicalInterfaces,
	findCommandOnPath,
	findQemuBinary,
	findEfiFirmware,
	findEfiFirmwareInDataDirs,
	parseQemuDataDirs,
	qemuDataDirs,
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
	parseIfconfigLinkState,
	findManagedHelper,
	managedSocketSpecifier,
	isWiredPortName,
	isCrossArchEmulation,
	accelDoctorCheck,
	proxyDoctorCheck,
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

describe("UEFI firmware beside a QEMU's own data dirs (#254)", () => {
	let tmp: string;
	const touch = (...parts: string[]) => {
		const path = join(tmp, ...parts);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "");
		return path;
	};
	beforeEach(() => {
		tmp = mkdtempSync(join(import.meta.dir, ".efi-data-dirs-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	test("parses -L help: absolute dirs in order, -L dirs first", () => {
		// Debian's QEMU 10.0.13 behind a wrapper that adds three leading -L (app-t3code labs payload).
		const output = [
			"/data/t/groups/labs/x/root/usr/share/qemu",
			"/data/t/groups/labs/x/root/usr/share/seabios",
			"/data/t/groups/labs/x/root/usr/lib/ipxe/qemu",
			"/usr/share/qemu",
			"/usr/share/seabios",
			"/usr/lib/ipxe/qemu",
			"",
		].join("\n");
		expect(parseQemuDataDirs(output)).toEqual([
			"/data/t/groups/labs/x/root/usr/share/qemu",
			"/data/t/groups/labs/x/root/usr/share/seabios",
			"/data/t/groups/labs/x/root/usr/lib/ipxe/qemu",
			"/usr/share/qemu",
			"/usr/share/seabios",
			"/usr/lib/ipxe/qemu",
		]);
		expect(parseQemuDataDirs("qemu-system-aarch64: warning: something\r\n\r\n")).toEqual([]);
	});

	test("asks the binary for -L help and returns [] when it fails", () => {
		const spawn = mockSpawnSync((cmd) => {
			expect(cmd).toEqual(["/mock/bin/qemu-system-aarch64", "-L", "help"]);
			return { exitCode: 0, stdout: "/opt/q/share/qemu\n" };
		});
		expect(qemuDataDirs("/mock/bin/qemu-system-aarch64")).toEqual(["/opt/q/share/qemu"]);
		expect(spawn).toHaveBeenCalledTimes(1);
		mockSpawnSync(() => ({ exitCode: 1, stderr: "unknown option" }));
		expect(qemuDataDirs("/mock/bin/qemu-system-aarch64")).toEqual([]);
	});

	test("finds a Debian AAVMF pair in the share dir beside a data dir", () => {
		const code = touch("root", "usr", "share", "AAVMF", "AAVMF_CODE.fd");
		const vars = touch("root", "usr", "share", "AAVMF", "AAVMF_VARS.fd");
		mkdirSync(join(tmp, "root", "usr", "share", "qemu"), { recursive: true });
		const dirs = [join(tmp, "root", "usr", "share", "qemu"), join(tmp, "root", "usr", "share", "seabios"), join(tmp, "root", "usr", "lib", "ipxe", "qemu")];
		expect(findEfiFirmwareInDataDirs(dirs)).toEqual({ code, vars });
	});

	test("finds upstream edk2 images inside the data dir (Homebrew, make install, Windows)", () => {
		const code = touch("brew", "share", "qemu", "edk2-aarch64-code.fd");
		const vars = touch("brew", "share", "qemu", "edk2-arm-vars.fd");
		expect(findEfiFirmwareInDataDirs([join(tmp, "brew", "share", "qemu")])).toEqual({ code, vars });
	});

	test("takes code and vars from one layout: a mixed pair in one dir is skipped for a complete one", () => {
		// Upstream code in the data dir, Debian vars beside it: no complete pair from either layout…
		touch("m", "share", "qemu", "edk2-aarch64-code.fd");
		touch("m", "share", "AAVMF", "AAVMF_VARS.fd");
		expect(findEfiFirmwareInDataDirs([join(tmp, "m", "share", "qemu")])).toBeUndefined();
		// …until a later layout in the same dir is complete.
		const code = touch("m", "share", "qemu-efi-aarch64", "QEMU_EFI.fd");
		const vars = touch("m", "share", "qemu-efi-aarch64", "QEMU_VARS.fd");
		expect(findEfiFirmwareInDataDirs([join(tmp, "m", "share", "qemu")])).toEqual({ code, vars });
	});

	test("takes code and vars from one installation: a dir with only code is skipped", () => {
		touch("a", "share", "AAVMF", "AAVMF_CODE.fd");
		const code = touch("b", "share", "qemu-efi-aarch64", "QEMU_EFI.fd");
		const vars = touch("b", "share", "qemu-efi-aarch64", "QEMU_VARS.fd");
		const dirs = [join(tmp, "a", "share", "qemu"), join(tmp, "b", "share", "qemu")];
		expect(findEfiFirmwareInDataDirs(dirs)).toEqual({ code, vars });
		expect(findEfiFirmwareInDataDirs([join(tmp, "a", "share", "qemu")])).toBeUndefined();
		expect(findEfiFirmwareInDataDirs([])).toBeUndefined();
	});

	test("findEfiFirmware falls back to the arm64 QEMU's data dirs when no standard path exists", () => {
		// No standard paths, so the fallback runs whatever firmware this host has installed.
		const none = { code: [], vars: [] };
		mockSpawnSync(() => ({ exitCode: 1 }));
		expect(findEfiFirmware(none)).toBeUndefined();
		const code = touch("root", "usr", "share", "AAVMF", "AAVMF_CODE.fd");
		const vars = touch("root", "usr", "share", "AAVMF", "AAVMF_VARS.fd");
		const qemu = join(tmp, "bin", "qemu-system-aarch64");
		mockSpawnSync((cmd) => {
			if (cmd[0] === qemu) {
				expect(cmd).toEqual([qemu, "-L", "help"]);
				return { exitCode: 0, stdout: `${join(tmp, "root", "usr", "share", "qemu")}\n/usr/share/qemu\n` };
			}
			// `which` / `where.exe` resolving qemu-system-aarch64 on PATH.
			return cmd[1] === "qemu-system-aarch64" ? { exitCode: 0, stdout: `${qemu}\n` } : { exitCode: 1 };
		});
		expect(findEfiFirmware(none)).toEqual({ code, vars });
	});

	test("findEfiFirmware does not ask QEMU when a standard path matches", () => {
		const code = touch("std", "AAVMF_CODE.fd");
		const vars = touch("std", "AAVMF_VARS.fd");
		const spawn = mockSpawnSync(() => ({ exitCode: 1 }));
		expect(findEfiFirmware({ code: ["/nonexistent/code.fd", code], vars: [vars] })).toEqual({ code, vars });
		expect(spawn).not.toHaveBeenCalled();
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
		// The mock is load-bearing, not decoration: darwin + x64 is the one branch
		// where isAppleSiliconHost() shells out, so without it this assertion runs
		// the real probe — and on an Apple Silicon host running this suite under
		// Rosetta that answers "1", flipping the expected null to a note.
		setArch("x64");
		resetAppleSiliconHostCache();
		mockSpawnSync((cmd) => {
			expect(cmd).toEqual(["sysctl", "-n", "sysctl.proc_translated"]);
			return { exitCode: 1 };
		});
		expect(accelNote("arm64", "tcg")).toBeNull();

		// Non-darwin short-circuits before the probe, so no mock is needed here.
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
		// Naming the tier is the point: "why am I on this accelerator?"
		expect(note).toContain("--accel");
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
			if (cmd[0] === "ifconfig") {
				expect(cmd).toEqual(["ifconfig", "-a"]);
				return {
					exitCode: 0,
					stdout: [
						"en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500",
						"\tether aa:bb:cc:dd:ee:ff",
						"\tstatus: active",
						"en5: flags=8822<BROADCAST,SMART,SIMPLEX,MULTICAST> mtu 1500",
						"\tstatus: inactive",
					].join("\n"),
				};
			}
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
			{ device: "en0", name: "Wi-Fi", mac: "aa:bb:cc:dd:ee:ff", alias: "wifi", active: true },
			{ device: "en5", name: "USB Ethernet", mac: "11:22:33:44:55:66", alias: "ethernet", active: false },
			{ device: "en7", name: "Ethernet", mac: "77:88:99:aa:bb:cc", alias: undefined, active: undefined },
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

	test("auto passes over an unplugged ethernet port for wifi with link", () => {
		const linked = [{ ...wifiIface, active: true }, { ...ethernetIface, active: false }];
		expect(resolveInterfaceAlias("auto", linked)).toBe("en0");
	});

	test("auto takes ethernet with link over wifi with link", () => {
		const linked = [{ ...wifiIface, active: true }, { ...ethernetIface, active: true }];
		expect(resolveInterfaceAlias("auto", linked)).toBe("en5");
	});

	test("auto considers every ethernet port, not only the one with the alias", () => {
		// Codex review of #264: first USB adapter unplugged, a second one linked, Wi-Fi down.
		const second = { device: "en7", name: "Ethernet", active: true };
		expect(resolveInterfaceAlias("auto", [{ ...wifiIface, active: false }, { ...ethernetIface, active: false }, second])).toBe("en7");
	});

	test("auto counts USB and dock adapters named by chip or vendor as wired", () => {
		const usb: HostInterface = { device: "en8", name: "USB 10/100/1000 LAN", active: true };
		const tbPort: HostInterface = { device: "en2", name: "Thunderbolt 1", active: true };
		const iphone: HostInterface = { device: "en9", name: "iPhone USB", active: true };
		const wifiUp = { ...wifiIface, active: true };
		expect(resolveInterfaceAlias("auto", [wifiUp, { ...ethernetIface, active: false }, usb])).toBe("en8");
		expect(resolveInterfaceAlias("auto", [tbPort, iphone, wifiUp])).toBe("en0");
		expect(isWiredPortName("AX88179A")).toBe(true);
		expect(isWiredPortName("Thunderbolt Ethernet Slot 1")).toBe(true);
	});

	test("auto keeps the ethernet-first order when nothing has link", () => {
		const down = [{ ...wifiIface, active: false }, { ...ethernetIface, active: false }];
		expect(resolveInterfaceAlias("auto", down)).toBe("en5");
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

describe("managedSocketSpecifier", () => {
	test("names the network a quickchr socket serves, and nothing for other sockets", () => {
		expect(managedSocketSpecifier("/var/run/quickchr-net-shared.sock")).toBe("shared");
		expect(managedSocketSpecifier("/var/run/quickchr-net-bridged-en0.sock")).toBe("bridged:en0");
		expect(managedSocketSpecifier("/var/run/socket_vmnet.bridged.en0")).toBeUndefined();
		expect(managedSocketSpecifier("/tmp/quickchr-net-shared.sock")).toBeUndefined();
	});
});

describe("findManagedHelper", () => {
	test("finds the newest installed version, ignoring non-version entries and empty versions", () => {
		// Copilot review of #264: detection looked in /opt/quickchr/bin while the installer
		// writes /opt/quickchr/socket_vmnet/<version>/bin, so a stopped managed network
		// read as "not installed".
		const root = mkdtempSync(join(tmpdir(), "quickchr-tmp-helper-"));
		try {
			expect(findManagedHelper(root)).toBeUndefined();
			for (const v of ["1.2.2", "1.10.0", "notes"]) mkdirSync(join(root, v, "bin"), { recursive: true });
			writeFileSync(join(root, "1.2.2", "bin", "socket_vmnet"), "");
			expect(findManagedHelper(root)).toBe(join(root, "1.2.2", "bin", "socket_vmnet"));
			writeFileSync(join(root, "1.10.0", "bin", "socket_vmnet"), "");
			expect(findManagedHelper(root)).toBe(join(root, "1.10.0", "bin", "socket_vmnet"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("parseIfconfigLinkState", () => {
	test("maps each device's status line; devices without one are absent", () => {
		const links = parseIfconfigLinkState([
			"lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384",
			"\tinet 127.0.0.1 netmask 0xff000000",
			"en0: flags=8b63<UP,BROADCAST,SMART,RUNNING,PROMISC,ALLMULTI,SIMPLEX,MULTICAST> mtu 1500",
			"\tether 14:7d:da:0a:07:a1",
			"\tmedia: autoselect",
			"\tstatus: active",
			"en1: flags=8822<BROADCAST,SMART,SIMPLEX,MULTICAST> mtu 1500",
			"\tstatus: inactive",
			"utun0: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1500",
		].join("\n"));
		expect([...links]).toEqual([["en0", true], ["en1", false]]);
	});
});

describe("accelDoctorCheck", () => {
	test("TCG-only is a warning, not a success check", () => {
		// Cloud sessions have no /dev/kvm, so this is the row they see (#210).
		const check = accelDoctorCheck(["tcg"], "x64");
		expect(check.label).toBe("Acceleration");
		expect(check.status).toBe("warn");
		expect(check.detail).toContain("tcg");
		expect(check.detail).toContain("no KVM/HVF");
	});

	test("hardware acceleration present reads ok and says nothing about TCG-only", () => {
		const check = accelDoctorCheck(["kvm", "tcg"], "x64");
		expect(check.status).toBe("ok");
		expect(check.detail).toContain("kvm, tcg");
		expect(check.detail).not.toContain("software emulation only");
	});

	test("a configured override suffix is preserved on either status", () => {
		const suffix = " — configured override via QUICKCHR_ACCEL";
		expect(accelDoctorCheck(["tcg"], "x64", suffix).detail).toContain("QUICKCHR_ACCEL");
		expect(accelDoctorCheck(["hvf", "tcg"], "arm64", suffix).detail).toContain("QUICKCHR_ACCEL");
	});

	test("an override does not double the verdict with the TCG-only note", () => {
		// Under an override the row names the forced mode, not host capability —
		// appending the TCG-only capability note would say TCG twice.
		const check = accelDoctorCheck(["tcg"], "x64", " — configured override via QUICKCHR_ACCEL");
		expect(check.status).toBe("warn");
		expect(check.detail).toContain("configured override");
		expect(check.detail).not.toContain("software emulation only");
	});

	test("no detected accelerator stays a warning without claiming TCG", () => {
		const check = accelDoctorCheck([], "x64");
		expect(check.status).toBe("warn");
		expect(check.detail).toContain("none detected");
	});
});

describe("proxyDoctorCheck", () => {
	test("unset proxy reads ok", () => {
		const check = proxyDoctorCheck({} as NodeJS.ProcessEnv);
		expect(check.label).toBe("HTTPS proxy");
		expect(check.status).toBe("ok");
		expect(check.detail).toContain("not set");
	});

	test("a set proxy is reported as a warning with the endpoint shown", () => {
		const check = proxyDoctorCheck({ HTTPS_PROXY: "http://proxy.example:8080" });
		expect(check.status).toBe("warn");
		expect(check.detail).toContain("http://proxy.example:8080");
		expect(check.detail).toContain("*.mikrotik.com");
	});

	test("honors the lowercase spelling", () => {
		const check = proxyDoctorCheck({ https_proxy: "http://proxy.example:8080" });
		expect(check.status).toBe("warn");
		expect(check.detail).toContain("http://proxy.example:8080");
	});

	test("falls back to ALL_PROXY, either case", () => {
		const upper = proxyDoctorCheck({ ALL_PROXY: "http://proxy.example:8080" });
		expect(upper.status).toBe("warn");
		expect(upper.detail).toContain("http://proxy.example:8080");
		const lower = proxyDoctorCheck({ all_proxy: "http://proxy.example:8080" });
		expect(lower.status).toBe("warn");
		expect(lower.detail).toContain("http://proxy.example:8080");
	});

	test("the scheme-specific variable wins over ALL_PROXY for display", () => {
		const check = proxyDoctorCheck({
			HTTPS_PROXY: "http://specific.example:8080",
			ALL_PROXY: "http://fallback.example:8080",
		});
		expect(check.detail).toContain("specific.example");
		expect(check.detail).not.toContain("fallback.example");
	});

	test("a non-HTTP scheme on ALL_PROXY is reported as ignored, not as an active proxy", () => {
		// "Ignored" is only true on ALL_PROXY — a scheme-specific variable
		// with an unusable scheme fails fetches (see the test below).
		const check = proxyDoctorCheck({ ALL_PROXY: "socks5://proxy.example:1080" });
		expect(check.status).toBe("warn");
		expect(check.detail).toContain("socks5://proxy.example:1080");
		expect(check.detail).toContain("ignored");
		expect(check.detail).not.toContain("egress via proxy");
	});

	test("a scheme-less host:port reads as the active http proxy", () => {
		// Bun defaults scheme-less values to http (probed) — not unparseable.
		const check = proxyDoctorCheck({ HTTPS_PROXY: "proxy.example:8080" });
		expect(check.status).toBe("warn");
		expect(check.detail).toContain("http://proxy.example:8080");
		expect(check.detail).toContain("egress via proxy");
	});

	test("credentials in the proxy URL are never echoed", () => {
		const check = proxyDoctorCheck({ HTTPS_PROXY: "http://user:secret@proxy.example:8080" });
		expect(check.detail).toContain("http://proxy.example:8080");
		expect(check.detail).not.toContain("user");
		expect(check.detail).not.toContain("secret");
	});

	test("an unparseable value is not echoed raw", () => {
		const check = proxyDoctorCheck({ HTTPS_PROXY: "not a url {{{" });
		expect(check.status).toBe("warn");
		expect(check.detail).toContain("unparseable");
		expect(check.detail).not.toContain("{{{");
	});

	test("a whitespace-only value falls through to the next variable", () => {
		// Without the trim, the selector returns " " while
		// isProxyConfiguredFor() falls through to ALL_PROXY — the two
		// helpers disagree and doctor misdiagnoses direct egress.
		const check = proxyDoctorCheck({ HTTPS_PROXY: "   ", ALL_PROXY: "http://proxy.example:8080" });
		expect(check.detail).toContain("proxy.example");
		expect(check.detail).toContain("egress via proxy");
	});

	test("an unusable scheme on ALL_PROXY is ignored (direct egress)", () => {
		// Bun ignores a non-http(s) ALL_PROXY and goes direct (probed).
		const check = proxyDoctorCheck({ ALL_PROXY: "socks5://proxy.example:1080" });
		expect(check.status).toBe("warn");
		expect(check.detail).toContain("ignored");
		expect(check.detail).toContain("direct egress");
	});

	test("an unusable scheme on HTTPS_PROXY fails fetches instead of going direct", () => {
		// Bun throws UnsupportedProxyProtocol for a non-http(s)
		// scheme-specific variable (probed) — claiming direct egress here
		// misdiagnoses failing downloads.
		const check = proxyDoctorCheck({ HTTPS_PROXY: "socks5://proxy.example:1080" });
		expect(check.status).toBe("warn");
		expect(check.detail).toContain("socks5://proxy.example:1080");
		expect(check.detail).toContain("HTTPS_PROXY");
		expect(check.detail).not.toContain("direct egress");
	});
});
