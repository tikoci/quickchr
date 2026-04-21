import { describe, test, expect } from "bun:test";
import { accelTimeoutFactor } from "../../src/lib/platform.ts";

describe("accelTimeoutFactor", () => {
	test("kvm same-arch = 1.5", () => expect(accelTimeoutFactor("kvm", false)).toBe(1.5));
	test("hvf same-arch = 1.5", () => expect(accelTimeoutFactor("hvf", false)).toBe(1.5));
	test("tcg same-arch = 4.0", () => expect(accelTimeoutFactor("tcg", false)).toBe(4.0));
	test("tcg cross-arch = 15.0", () => expect(accelTimeoutFactor("tcg", true)).toBe(15.0));
	test("kvm cross-arch = 1.5", () => expect(accelTimeoutFactor("kvm", true)).toBe(1.5));
	test("hvf cross-arch = 1.5", () => expect(accelTimeoutFactor("hvf", true)).toBe(1.5));
	test("unknown accel same-arch = 4.0 (TCG fallback)", () => expect(accelTimeoutFactor("unknown", false)).toBe(4.0));
	test("unknown accel cross-arch = 15.0 (TCG fallback)", () => expect(accelTimeoutFactor("unknown", true)).toBe(15.0));
});
