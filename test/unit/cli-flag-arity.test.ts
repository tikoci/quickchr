// cspell:ignore netdev verison
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
	ADD_FLAGS,
	NEGATABLE_VALUE_FLAGS,
	REMOVED_FLAGS,
	START_FLAGS,
	VALUE_FLAGS,
} from "../../src/cli/flags.ts";
import { parseFlags } from "../../src/cli/index.ts";

const CLI_SOURCE = readFileSync(join(import.meta.dir, "../../src/cli/index.ts"), "utf-8");

/** Every flag name passed to one of the CLI's flag readers. The audit that found
 *  `--vmnet-shared` was someone re-reading every call site by eye; this is that audit as
 *  an assertion, so the next one cannot be skipped. */
function readWith(helper: string): string[] {
	const pattern = new RegExp(`\\b${helper}\\(flags, "([a-z][a-z0-9-]*)"`, "g");
	return [...new Set([...CLI_SOURCE.matchAll(pattern)].map((m) => m[1] as string))].sort();
}

/** The same audit for flags read straight off the object — `flags["older-than"]`,
 *  `flags.accel` — which bypass the helpers entirely. This half is not optional: three
 *  `cache prune` flags were read this way, and a helpers-only scan declared the registry
 *  complete while `--older-than 7.24` had already stopped taking its value.
 *
 *  A read compared against `true`/`false` is the flag being used as a boolean; anything
 *  else is a value. `--no-device-mode` is the documented exception — a negation of a
 *  value-taking flag, not proof that it is boolean. */
function directReads(): { value: string[]; boolean: string[] } {
	const value = new Set<string>();
	const bool = new Set<string>();
	// The lookbehind keeps the `"./flags.ts"` import out of the results.
	for (const m of CLI_SOURCE.matchAll(/(?<![\w/])flags(?:\.([a-z][a-zA-Z0-9]*)|\["([a-z][a-z0-9-]*)"\])/g)) {
		const name = (m[1] ?? m[2]) as string;
		const start = (m.index ?? 0) + m[0].length;
		const isBoolTest = /^\s*[!=]==?\s*(?:true|false)/.test(CLI_SOURCE.slice(start, start + 24));
		(isBoolTest ? bool : value).add(name);
	}
	return { value: [...value].sort(), boolean: [...bool].sort() };
}

describe("flag arity is declared, not guessed (#164)", () => {
	test("every flag read as a value is in VALUE_FLAGS", () => {
		const valueReaders = ["flag", "flagList", "cacheTargetFlag"].flatMap(readWith);
		// A regex that matched nothing would pass this vacuously.
		expect(valueReaders.length).toBeGreaterThan(30);
		for (const name of valueReaders) {
			expect({ name, declared: VALUE_FLAGS.has(name) }).toEqual({ name, declared: true });
		}
	});

	test("no boolean flag is read through flag()", () => {
		// The mirror direction, and the one that makes the first check meaningful: a
		// name in both sets would let parseFlags consume an argument for a flag that
		// only ever answers yes/no.
		const boolReaders = readWith("flagBool");
		expect(boolReaders.length).toBeGreaterThan(5);
		for (const name of boolReaders) {
			expect({ name, valueTaking: VALUE_FLAGS.has(name) }).toEqual({ name, valueTaking: false });
		}
	});

	test("a flag read straight off the object is declared too", () => {
		const direct = directReads();
		expect(direct.value.length).toBeGreaterThan(3);
		expect(direct.boolean.length).toBeGreaterThan(5);
		for (const name of direct.value) {
			expect({ name, declared: VALUE_FLAGS.has(name) }).toEqual({ name, declared: true });
		}
		for (const name of direct.boolean) {
			if (NEGATABLE_VALUE_FLAGS.has(name)) continue;
			expect({ name, valueTaking: VALUE_FLAGS.has(name) }).toEqual({ name, valueTaking: false });
		}
	});

	test("a boolean flag does not consume the following positional", () => {
		const { flags, positional } = parseFlags(["--dry-run", "lab"]);
		expect(flags["dry-run"]).toBe(true);
		expect(positional).toEqual(["lab"]);
	});

	test("a value flag still consumes its value", () => {
		const { flags, positional } = parseFlags(["--version", "7.24.3", "lab"]);
		expect(flags.version).toBe("7.24.3");
		expect(positional).toEqual(["lab"]);
	});

	test("a repeatable value flag collects every occurrence", () => {
		const { flags, positional } = parseFlags(["--add-network", "user", "--add-network", "shared", "lab"]);
		expect(flags["add-network"]).toEqual(["user", "shared"]);
		expect(positional).toEqual(["lab"]);
	});

	test("an unknown flag is boolean, so a typo cannot swallow the machine name", () => {
		// It is still rejected by ADD_FLAGS/START_FLAGS on the creating commands (#156);
		// the point here is that the name survives long enough to be reported.
		const { flags, positional } = parseFlags(["--verison", "lab"]);
		expect(flags.verison).toBe(true);
		expect(positional).toEqual(["lab"]);
	});

	test("--flag=value is a value whatever the arity table says", () => {
		expect(parseFlags(["--json=true"]).flags.json).toBe("true");
	});

	test("the caller can supply its own arity table", () => {
		const { flags, positional } = parseFlags(["--only-here", "x"], new Set(["only-here"]));
		expect(flags["only-here"]).toBe("x");
		expect(positional).toEqual([]);
	});
});

describe("--vmnet-shared / --vmnet-bridge are removed, not repaired (#164)", () => {
	test("neither name is a known flag any more", () => {
		for (const name of REMOVED_FLAGS.keys()) {
			expect({ name, inAdd: ADD_FLAGS.includes(name) }).toEqual({ name, inAdd: false });
			expect({ name, inStart: START_FLAGS.includes(name) }).toEqual({ name, inStart: false });
			expect({ name, valueTaking: VALUE_FLAGS.has(name) }).toEqual({ name, valueTaking: false });
		}
	});

	test("every spelling errors with the replacement rather than being ignored", () => {
		// Three doors into parseFlags, and a removed flag that slipped through any one of
		// them would be accepted and do nothing — the defect it is being removed for.
		for (const argv of [
			["--vmnet-shared"],
			["--vmnet-shared", "lab"],
			["--vmnet-shared=yes"],
			["--no-vmnet-shared"],
		]) {
			expect(() => parseFlags(argv)).toThrow(/--vmnet-shared was removed. Use: --add-network shared/);
		}
		expect(() => parseFlags(["--vmnet-bridge", "en0"]))
			.toThrow(/--vmnet-bridge was removed. Use: --add-network bridged:<iface>/);
	});

	test("the error carries INVALID_ARGUMENT so the CLI prints it as an error, not a stack", () => {
		try {
			parseFlags(["--vmnet-shared"]);
			throw new Error("expected parseFlags to throw");
		} catch (e) {
			expect((e as { code?: string }).code).toBe("INVALID_ARGUMENT");
		}
	});

	test("the CLI flag is gone; the QEMU netdev of the same name is not", async () => {
		// `vmnet-shared` is three things at once: the removed CLI flag, QEMU's own netdev
		// name, and a legacy `machine.json` value. Only the first was removed, and the
		// name collision is exactly what makes an over-eager deletion easy — so both
		// survivors are pinned here, next to the removal that threatens them.
		const { networkModeToConfigs, resolveNetworkConfig } = await import("../../src/lib/network.ts");

		// The `machine.json` migration: a machine created before `networks[]` existed.
		expect(networkModeToConfigs("vmnet-shared")).toEqual([{ specifier: "vmnet-shared", id: "net0" }]);
		expect(networkModeToConfigs({ type: "vmnet-bridge", iface: "en0" })[0]?.specifier)
			.toEqual({ type: "vmnet-bridged", iface: "en0" });

		// The root-QEMU fallback path: the netdev QEMU itself is given.
		const resolved = resolveNetworkConfig(
			{ specifier: "vmnet-shared", id: "net0" },
			{ platform: { os: "darwin", hostArch: "x64", packageManager: "brew", accelAvailable: ["hvf"] } },
		);
		expect(resolved.resolved?.qemuNetdevArgs.join(" ")).toContain("vmnet-shared,id=net0");
	});
});
