import { describe, test, expect } from "bun:test";
import {
	detectPackageManager,
	findQemuBinary,
	findEfiFirmware,
	getQemuInstallHint,
	getQemuVersion,
	requireQemu,
	requireFirmware,
} from "../../src/lib/platform.ts";

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
		expect(getQemuInstallHint("apt")).toContain("qemu");
	});

	test("dnf: returns dnf install command", () => {
		expect(getQemuInstallHint("dnf")).toContain("dnf install");
	});

	test("pacman: returns pacman command", () => {
		expect(getQemuInstallHint("pacman")).toContain("pacman");
		expect(getQemuInstallHint("pacman")).toContain("qemu");
	});

	test("winget: returns winget install command", () => {
		expect(getQemuInstallHint("winget")).toContain("winget install");
	});

	test("unknown: returns generic install note", () => {
		expect(getQemuInstallHint("unknown")).toContain("Install QEMU");
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
