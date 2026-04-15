import { describe, test, expect } from "bun:test";
import { parseFlags } from "../../src/cli/index.ts";

describe("cmdExec flag parsing", () => {
	test("--via rest is parsed correctly", () => {
		const { flags } = parseFlags(["mymachine", "/system/identity/print", "--via", "rest"]);
		expect(flags.via).toBe("rest");
	});

	test("--user and --password are parsed", () => {
		const { flags } = parseFlags(["mymachine", ":put ok", "--user", "alice", "--password", "secret"]);
		expect(flags.user).toBe("alice");
		expect(flags.password).toBe("secret");
	});

	test("--timeout is parsed as string (caller converts to ms)", () => {
		const { flags } = parseFlags(["mymachine", ":put ok", "--timeout", "30"]);
		expect(flags.timeout).toBe("30");
	});

	test("positional args are separated from flags", () => {
		const { positional, flags } = parseFlags(["mymachine", "/ip/address/print", "--via", "rest"]);
		expect(positional[0]).toBe("mymachine");
		expect(positional[1]).toBe("/ip/address/print");
		expect(flags.via).toBe("rest");
	});

	test("--no-X flag sets key to false", () => {
		const { flags } = parseFlags(["mymachine", ":put ok", "--no-serialize"]);
		expect(flags.serialize).toBe(false);
	});
});
