import { describe, expect, test } from "bun:test";
import { parseFlags } from "../../src/cli/index.ts";

describe("--receive / --no-receive parsing (#299)", () => {
	test("--receive is a repeatable value flag", () => {
		const { flags, positional } = parseFlags(["lab", "--receive", "tzsp", "--receive", "syslog:5515"]);
		expect(positional).toEqual(["lab"]);
		expect(flags.receive).toEqual(["tzsp", "syslog:5515"]);
	});

	test("--no-receive takes a name instead of negating --receive", () => {
		const { flags, positional } = parseFlags(["lab", "--no-receive", "tzsp"]);
		expect(positional).toEqual(["lab"]);
		expect(flags["no-receive"]).toBe("tzsp");
		expect(flags.receive).toBeUndefined();
	});

	test("other --no-x flags still negate", () => {
		const { flags, positional } = parseFlags(["lab", "--no-winbox"]);
		expect(flags.winbox).toBe(false);
		expect(positional).toEqual(["lab"]);
	});
});
