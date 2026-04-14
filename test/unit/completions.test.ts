import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { existsSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
	detectCurrentShell,
	shellBinary,
	completionInstallPath,
	completionStatusFor,
	allCompletionStatuses,
	generateCompletionScript,
	installCompletions,
	uninstallCompletions,
	listMachineNamesForCompletion,
	listRunningMachineNamesForCompletion,
	type SupportedShell,
} from "../../src/lib/completions.ts";

// Use a temp HOME to avoid touching real rc files
const tmpHome = join(import.meta.dir, "tmp-completions-home");
const SHELLS: SupportedShell[] = ["bash", "zsh", "fish"];

const originalHome = process.env.HOME;

// Collect any system-path (non-HOME) completion files written during a test
// so afterEach can clean them up and prevent filesystem leaks between tests.
const systemFilesWritten: string[] = [];

beforeEach(() => {
	systemFilesWritten.length = 0;
});

afterEach(() => {
	process.env.HOME = originalHome;
	if (existsSync(tmpHome)) {
		rmSync(tmpHome, { recursive: true, force: true });
	}
	// Clean up any system-path files written during the test
	for (const f of systemFilesWritten) {
		try {
			if (existsSync(f)) unlinkSync(f);
		} catch {
			// best-effort
		}
	}
});

describe("detectCurrentShell", () => {
	test("returns an object with shell, version, supported fields", () => {
		const info = detectCurrentShell();
		expect(info).toHaveProperty("shell");
		expect(info).toHaveProperty("supported");
		expect(typeof info.shell).toBe("string");
		expect(typeof info.supported).toBe("boolean");
		// version may be undefined if not available
		expect(info.version === undefined || typeof info.version === "string").toBe(true);
	});

	test("shell field is non-empty string", () => {
		const info = detectCurrentShell();
		expect(info.shell.length).toBeGreaterThan(0);
	});

	test("supported is true for bash/zsh/fish", () => {
		const savedShell = process.env.SHELL;
		for (const sh of ["/bin/bash", "/bin/zsh", "/usr/bin/fish"]) {
			process.env.SHELL = sh;
			const info = detectCurrentShell();
			expect(info.supported).toBe(true);
		}
		process.env.SHELL = savedShell;
	});

	test("supported is false for unknown shells", () => {
		const savedShell = process.env.SHELL;
		process.env.SHELL = "/usr/bin/nushell";
		const info = detectCurrentShell();
		expect(info.supported).toBe(false);
		process.env.SHELL = savedShell;
	});
});

describe("shellBinary", () => {
	test("extracts binary name from full path", () => {
		const info = { shell: "/bin/zsh", version: "5.9", supported: true };
		expect(shellBinary(info)).toBe("zsh");
	});

	test("returns shell as-is if no slash", () => {
		const info = { shell: "bash", version: undefined, supported: true };
		expect(shellBinary(info)).toBe("bash");
	});
});

describe("generateCompletionScript", () => {

	for (const shell of SHELLS) {
		test(`generates non-empty script for ${shell}`, () => {
			const script = generateCompletionScript(shell);
			expect(typeof script).toBe("string");
			expect(script.length).toBeGreaterThan(100);
		});
	}

	test("bash script contains _quickchr function and complete command", () => {
		const script = generateCompletionScript("bash");
		expect(script).toContain("_quickchr");
		expect(script).toContain("complete -F _quickchr quickchr");
	});

	test("zsh script starts with #compdef quickchr", () => {
		const script = generateCompletionScript("zsh");
		expect(script.startsWith("#compdef quickchr")).toBe(true);
	});

	test("fish script disables file completions", () => {
		const script = generateCompletionScript("fish");
		expect(script).toContain("complete -c quickchr -f");
	});

	test("scripts reference --machines and --running flags", () => {
		for (const shell of SHELLS) {
			const script = generateCompletionScript(shell);
			expect(script).toContain("--machines");
			expect(script).toContain("--running");
		}
	});

	test("scripts include all main subcommands", () => {
		const subcommands = ["start", "stop", "list", "remove", "console", "exec", "doctor", "completions"];
		for (const shell of SHELLS) {
			const script = generateCompletionScript(shell);
			for (const cmd of subcommands) {
				expect(script).toContain(cmd);
			}
		}
	});
});

describe("completionInstallPath", () => {
	test("returns a file path for each supported shell", () => {
		for (const shell of ["bash", "zsh", "fish"] as SupportedShell[]) {
			const loc = completionInstallPath(shell);
			expect(typeof loc.file).toBe("string");
			expect(loc.file.length).toBeGreaterThan(0);
		}
	});

	test("zsh file is named _quickchr", () => {
		const loc = completionInstallPath("zsh");
		expect(loc.file.endsWith("_quickchr")).toBe(true);
	});

	test("fish file is named quickchr.fish", () => {
		const loc = completionInstallPath("fish");
		expect(loc.file.endsWith("quickchr.fish")).toBe(true);
	});

	test("bash and zsh may include rcLine/rcFile when no system dir available", () => {
		// Use a temp HOME with no brew/xdg dirs to force fallback paths
		process.env.HOME = tmpHome;
		const bashLoc = completionInstallPath("bash");
		const zshLoc = completionInstallPath("zsh");
		// Fish never needs rc modification
		const fishLoc = completionInstallPath("fish");
		expect(fishLoc.rcLine).toBeUndefined();
		expect(fishLoc.rcFile).toBeUndefined();
		// bash/zsh in fallback mode should have rc info
		if (bashLoc.rcLine) {
			expect(typeof bashLoc.rcFile).toBe("string");
		}
		if (zshLoc.rcLine) {
			expect(zshLoc.rcLine).toContain("fpath");
			expect(typeof zshLoc.rcFile).toBe("string");
		}
	});
});

describe("completionStatusFor", () => {
	test("returns installed:false when file does not exist", () => {
		process.env.HOME = tmpHome;
		for (const shell of SHELLS) {
			const loc = completionInstallPath(shell);
			// If the path is a system path (not under tmpHome), skip: we can't
			// control whether a prior system install exists there.
			if (!loc.file.startsWith(tmpHome)) continue;
			const status = completionStatusFor(shell);
			expect(status.shell).toBe(shell);
			expect(status.installed).toBe(false);
			expect(typeof status.path).toBe("string");
		}
	});
});

describe("allCompletionStatuses", () => {
	test("returns status for all three shells", () => {
		process.env.HOME = tmpHome;
		const statuses = allCompletionStatuses();
		expect(statuses).toHaveLength(3);
		const shells = statuses.map((s) => s.shell);
		expect(shells).toContain("bash");
		expect(shells).toContain("zsh");
		expect(shells).toContain("fish");
	});
});

describe("installCompletions / uninstallCompletions", () => {
	test("install writes file and uninstall removes it (bash, temp home)", () => {
		process.env.HOME = tmpHome;
		const result = installCompletions("bash");
		if (!result.file.startsWith(tmpHome)) systemFilesWritten.push(result.file);
		expect(result.shell).toBe("bash");
		expect(result.dryRun).toBe(false);
		expect(existsSync(result.file)).toBe(true);

		const removed = uninstallCompletions("bash");
		expect(removed.removed).toBe(true);
		expect(existsSync(result.file)).toBe(false);
	});

	test("install writes file and uninstall removes it (zsh, temp home)", () => {
		process.env.HOME = tmpHome;
		const result = installCompletions("zsh");
		if (!result.file.startsWith(tmpHome)) systemFilesWritten.push(result.file);
		expect(existsSync(result.file)).toBe(true);

		const removed = uninstallCompletions("zsh");
		expect(removed.removed).toBe(true);
	});

	test("install writes file and uninstall removes it (fish, temp home)", () => {
		process.env.HOME = tmpHome;
		const result = installCompletions("fish");
		expect(existsSync(result.file)).toBe(true);

		const removed = uninstallCompletions("fish");
		expect(removed.removed).toBe(true);
	});

	test("dry-run does not write file", () => {
		process.env.HOME = tmpHome;
		const result = installCompletions("zsh", { dryRun: true });
		expect(result.dryRun).toBe(true);
		expect(existsSync(result.file)).toBe(false);
	});

	test("install adds rc line to file and uninstall removes it", () => {
		process.env.HOME = tmpHome;
		const result = installCompletions("zsh");
		if (result.rcLine && result.rcFile) {
			const { readFileSync } = require("node:fs");
			const content = readFileSync(result.rcFile, "utf8") as string;
			expect(content).toContain(result.rcLine);

			uninstallCompletions("zsh");
			const after = readFileSync(result.rcFile, "utf8") as string;
			expect(after).not.toContain(result.rcLine);
		}
	});

	test("re-installing is idempotent (rc line not duplicated)", () => {
		process.env.HOME = tmpHome;
		installCompletions("bash");
		installCompletions("bash"); // second time
		const result = completionStatusFor("bash");
		if (result.installed) {
			// Check rc file has exactly one occurrence of the source line
			const { completionInstallPath } = require("../../src/lib/completions.ts");
			const loc = completionInstallPath("bash");
			if (loc.rcLine && loc.rcFile && existsSync(loc.rcFile)) {
				const { readFileSync } = require("node:fs");
				const content = readFileSync(loc.rcFile, "utf8") as string;
				const count = content.split(loc.rcLine).length - 1;
				expect(count).toBe(1);
			}
		}
	});

	test("uninstall returns removed:false when not installed", () => {
		process.env.HOME = tmpHome;
		const result = uninstallCompletions("fish");
		expect(result.removed).toBe(false);
	});
});

describe("listMachineNamesForCompletion", () => {
	test("returns an array (may be empty)", () => {
		const names = listMachineNamesForCompletion();
		expect(Array.isArray(names)).toBe(true);
	});
});

describe("listRunningMachineNamesForCompletion", () => {
	test("returns an array (may be empty)", () => {
		const names = listRunningMachineNamesForCompletion();
		expect(Array.isArray(names)).toBe(true);
	});
});
