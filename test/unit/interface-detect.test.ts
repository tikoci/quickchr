import { describe, test, expect } from "bun:test";
import { detectPhysicalInterfaces, resolveInterfaceAlias } from "../../src/lib/platform.ts";

describe("detectPhysicalInterfaces", () => {
	test("returns array of interfaces on macOS", () => {
		if (process.platform !== "darwin") return;
		const ifaces = detectPhysicalInterfaces();
		expect(Array.isArray(ifaces)).toBe(true);
		// Should find at least Wi-Fi on any Mac
		const wifi = ifaces.find(i => i.alias === "wifi");
		expect(wifi).toBeDefined();
		expect(wifi?.device).toBe("en0");
	});
});

describe("resolveInterfaceAlias", () => {
	test("resolves 'wifi' to en0 on macOS", () => {
		if (process.platform !== "darwin") return;
		expect(resolveInterfaceAlias("wifi")).toBe("en0");
	});

	test("passes through literal device names", () => {
		expect(resolveInterfaceAlias("en5")).toBe("en5");
	});
});
