import { describe, test, expect } from "bun:test";
import { resolveUserChoiceOptions } from "../../src/cli/wizard.ts";

describe("resolveUserChoiceOptions", () => {
	test("\"managed\" sets both disableAdmin AND secureLogin — provision() only auto-creates the replacement account when secureLogin is true", () => {
		expect(resolveUserChoiceOptions("managed")).toEqual({ disableAdmin: true, secureLogin: true });
	});

	test("\"custom\" sets disableAdmin and carries the supplied user, no secureLogin opinion", () => {
		const result = resolveUserChoiceOptions("custom", { name: "alice", password: "secret" });
		expect(result).toEqual({ user: { name: "alice", password: "secret" }, disableAdmin: true });
	});

	test("\"admin\" keeps the default admin account with no password", () => {
		expect(resolveUserChoiceOptions("admin")).toEqual({ disableAdmin: false, secureLogin: false });
	});
});
