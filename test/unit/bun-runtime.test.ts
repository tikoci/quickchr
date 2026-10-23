import { describe, expect, test } from "bun:test";
import { bunRuntimeCheck } from "../../src/lib/platform.ts";

const pin = (await Bun.file(new URL("../../.bun-version", import.meta.url)).text()).trim();

describe("doctor Bun runtime check (#207)", () => {
	for (const version of ["1.1.0", `${pin}-canary.1`]) {
		test(`warns for older Bun ${version} and names the tested pin`, async () => {
			const result = await bunRuntimeCheck(version);
			expect(result.status).toBe("warn");
			expect(result.detail).toContain(`bun ${version}; tested with Bun ${pin}`);
			expect(result.detail).toContain(`upgrade to ${pin} or newer`);
		});
	}
	test("warns when the runtime has no Semver comparison function", async () => {
		const original = Object.getOwnPropertyDescriptor(Bun.semver, "order");
		try {
			Object.defineProperty(Bun.semver, "order", { value: undefined, configurable: true });
			const result = await bunRuntimeCheck("1.0.0");
			expect(result.status).toBe("warn");
			expect(result.detail).toContain(`upgrade to ${pin} or newer`);
		} finally {
			if (original) Object.defineProperty(Bun.semver, "order", original);
		}
	});

	for (const version of [pin, "999.0.0"]) {
		test(`accepts Bun ${version} while still naming the tested pin`, async () => {
			const result = await bunRuntimeCheck(version);
			expect(result.status).toBe("ok");
			expect(result.detail).toBe(`bun ${version}; tested with Bun ${pin}`);
		});
	}
});
