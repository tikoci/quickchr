import { describe, test, expect } from "bun:test";
import {
	detectPackageManager,
	findQemuBinary,
	getQemuInstallHint,
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
});
