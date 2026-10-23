import { describe, expect, test } from "bun:test";
import { bunRuntimeCheck } from "../../src/lib/platform.ts";

const pin = (await Bun.file(new URL("../../.bun-version", import.meta.url)).text()).trim();

describe("doctor Bun runtime check (#207)", () => {
	for (const version of ["1.0.0", `${pin}-canary.1`]) {
		test(`warns for older Bun ${version} and names the tested pin`, async () => {
			const result = await bunRuntimeCheck(version);
			expect(result.status).toBe("warn");
			expect(result.detail).toContain(`bun ${version}; tested with Bun ${pin}`);
			expect(result.detail).toContain(`upgrade to ${pin} or newer`);
		});
	}
	for (const version of [pin, "999.0.0"]) {
		test(`accepts Bun ${version} while still naming the tested pin`, async () => {
			const result = await bunRuntimeCheck(version);
			expect(result.status).toBe("ok");
			expect(result.detail).toBe(`bun ${version}; tested with Bun ${pin}`);
		});
	}
});
