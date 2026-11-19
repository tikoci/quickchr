/**
 * One home-directory rule for the data dir, the config dir and the completion
 * paths, none of which may resolve relative to the working directory (#276).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { getDataDir } from "../../src/lib/state.ts";
import { quickchrConfigDir, userHomeDir } from "../../src/lib/paths.ts";
import { completionInstallPath } from "../../src/lib/completions.ts";
import { QuickCHRError } from "../../src/lib/types.ts";

const KEYS = ["HOME", "USERPROFILE", "QUICKCHR_DATA_DIR", "LOCALAPPDATA"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
	for (const k of KEYS) {
		const v = saved[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

function clearHome(value?: string): void {
	delete process.env.QUICKCHR_DATA_DIR;
	delete process.env.USERPROFILE;
	if (value === undefined) delete process.env.HOME;
	else process.env.HOME = value;
}

describe.skipIf(process.platform === "win32")("home dir rule (#276)", () => {
	for (const [label, value] of [["unset", undefined], ["empty", ""], ["relative", "some/dir"]] as const) {
		test(`HOME ${label}: data, config and completions share an absolute home`, () => {
			clearHome(value);
			const home = homedir();
			if (!isAbsolute(home)) {
				// os.homedir() may echo a relative HOME back; then there is no home to use.
				expect(() => getDataDir()).toThrow(QuickCHRError);
				expect(() => quickchrConfigDir()).toThrow(QuickCHRError);
				return;
			}
			expect(userHomeDir()).toBe(home);
			expect(getDataDir()).toBe(join(home, ".local", "share", "quickchr"));
			expect(quickchrConfigDir()).toBe(join(home, ".config", "quickchr"));
			expect(isAbsolute(completionInstallPath("zsh").file)).toBe(true);
		});
	}

	test("an absolute HOME wins", () => {
		clearHome("/tmp/quickchr-home-test");
		expect(getDataDir()).toBe("/tmp/quickchr-home-test/.local/share/quickchr");
		expect(quickchrConfigDir()).toBe("/tmp/quickchr-home-test/.config/quickchr");
	});
});

describe("QUICKCHR_DATA_DIR must be absolute (#276)", () => {
	test("a relative value is a STATE_ERROR naming the variable", () => {
		process.env.QUICKCHR_DATA_DIR = "rel/quickchr";
		let err: unknown;
		try {
			getDataDir();
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(QuickCHRError);
		expect((err as QuickCHRError).code).toBe("STATE_ERROR");
		expect((err as QuickCHRError).message).toContain("QUICKCHR_DATA_DIR");
	});

	test("an absolute value is used as given", () => {
		const dir = join(homedir(), "quickchr-data-test");
		process.env.QUICKCHR_DATA_DIR = dir;
		expect(getDataDir()).toBe(dir);
	});
});
