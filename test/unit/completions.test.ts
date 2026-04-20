import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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
const originalDataDir = process.env.QUICKCHR_DATA_DIR;
const originalShell = process.env.SHELL;
const originalFishVersion = process.env.FISH_VERSION;
const originalZshVersion = process.env.ZSH_VERSION;
const originalBashVersion = process.env.BASH_VERSION;

// Collect any system-path (non-HOME) completion files written during a test
// so afterEach can clean them up and prevent filesystem leaks between tests.
const systemFilesWritten: string[] = [];

beforeEach(() => {
	systemFilesWritten.length = 0;
});

afterEach(() => {
	process.env.HOME = originalHome;
	if (originalDataDir === undefined) delete process.env.QUICKCHR_DATA_DIR;
	else process.env.QUICKCHR_DATA_DIR = originalDataDir;
	process.env.SHELL = originalShell;
	if (originalFishVersion === undefined) delete process.env.FISH_VERSION;
	else process.env.FISH_VERSION = originalFishVersion;
	if (originalZshVersion === undefined) delete process.env.ZSH_VERSION;
	else process.env.ZSH_VERSION = originalZshVersion;
	if (originalBashVersion === undefined) delete process.env.BASH_VERSION;
	else process.env.BASH_VERSION = originalBashVersion;
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

	test("prefers shell-specific env vars over $SHELL", () => {
		process.env.SHELL = "/bin/zsh";

		process.env.FISH_VERSION = "4.0.1";
		delete process.env.ZSH_VERSION;
		delete process.env.BASH_VERSION;
		expect(shellBinary(detectCurrentShell())).toBe("fish");
		expect(detectCurrentShell().version).toBe("4.0.1");

		delete process.env.FISH_VERSION;
		process.env.ZSH_VERSION = "5.9";
		expect(shellBinary(detectCurrentShell())).toBe("zsh");
		expect(detectCurrentShell().version).toBe("5.9");

		delete process.env.ZSH_VERSION;
		process.env.BASH_VERSION = "5.2.37(1)-release";
		const bashInfo = detectCurrentShell();
		expect(shellBinary(bashInfo)).toBe("bash");
		expect(bashInfo.version).toBe("5.2.37");
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

	test("bash uses XDG completions dir when available", () => {
		process.env.HOME = tmpHome;
		mkdirSync(join(tmpHome, ".local", "share", "bash-completion", "completions"), { recursive: true });

		const bashLoc = completionInstallPath("bash");
		if (bashLoc.file.startsWith(tmpHome)) {
			expect(bashLoc.file).toBe(join(tmpHome, ".local", "share", "bash-completion", "completions", "quickchr"));
			expect(bashLoc.rcLine).toBeUndefined();
			expect(bashLoc.rcFile).toBeUndefined();
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

	test("returns installed:true after installation (fish — always under HOME)", () => {
		// Fish completions always go to ~/.config/fish/completions/quickchr.fish,
		// so this test runs unconditionally regardless of Homebrew or system paths.
		process.env.HOME = tmpHome;
		installCompletions("fish");
		const status = completionStatusFor("fish");
		expect(status.shell).toBe("fish");
		expect(status.installed).toBe(true);
		expect(status.path).toContain("quickchr.fish");
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
			const content = readFileSync(result.rcFile, "utf8");
			expect(content).toContain(result.rcLine);

			uninstallCompletions("zsh");
			const after = readFileSync(result.rcFile, "utf8");
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
			const loc = completionInstallPath("bash");
			if (loc.rcLine && loc.rcFile && existsSync(loc.rcFile)) {
				const content = readFileSync(loc.rcFile, "utf8");
				const count = content.split(loc.rcLine).length - 1;
				expect(count).toBe(1);
			}
		}
	});

	test("install appends rc lines after files without a trailing newline", () => {
		// Tests appendRcLine's separator logic: if the existing rc file doesn't end
		// with a newline, the appended line should be separated by one.
		// Uses bash because its fallback path (no Homebrew bash_completion.d, no XDG dir)
		// is more common than zsh's fallback (macOS always has /usr/local/share/zsh/site-functions).
		process.env.HOME = tmpHome;
		mkdirSync(tmpHome, { recursive: true });
		const rcFile = join(tmpHome, process.platform === "darwin" ? ".bash_profile" : ".bashrc");
		writeFileSync(rcFile, "export PATH=/usr/local/bin");

		const result = installCompletions("bash");
		if (result.rcLine && result.rcFile === rcFile) {
			expect(readFileSync(rcFile, "utf8")).toBe(`export PATH=/usr/local/bin\n${result.rcLine}\n`);
		}
		// Note: on macOS with Homebrew bash-completion@2 installed, completionInstallPath("bash")
		// resolves to the Homebrew dir and no rc file is written — the assertion above is skipped.
	});

	test("uninstall returns removed:false when not installed", () => {
		process.env.HOME = tmpHome;
		const result = uninstallCompletions("fish");
		expect(result.removed).toBe(false);
	});
});

describe("listMachineNamesForCompletion", () => {
	test("lists machine directories from quickchr state", () => {
		process.env.HOME = tmpHome;
		process.env.QUICKCHR_DATA_DIR = join(tmpHome, ".local", "share", "quickchr");
		const machinesDir = join(tmpHome, ".local", "share", "quickchr", "machines");
		for (const name of ["alpha", "beta"]) {
			mkdirSync(join(machinesDir, name), { recursive: true });
			writeFileSync(join(machinesDir, name, "machine.json"), JSON.stringify({ name, status: "stopped" }));
		}

		expect(listMachineNamesForCompletion().sort()).toEqual(["alpha", "beta"]);
	});
});

describe("listRunningMachineNamesForCompletion", () => {
	test("returns only running machines and skips unreadable state files", () => {
		process.env.HOME = tmpHome;
		process.env.QUICKCHR_DATA_DIR = join(tmpHome, ".local", "share", "quickchr");
		const machinesDir = join(tmpHome, ".local", "share", "quickchr", "machines");
		mkdirSync(join(machinesDir, "alpha"), { recursive: true });
		writeFileSync(join(machinesDir, "alpha", "machine.json"), JSON.stringify({ status: "running" }));
		mkdirSync(join(machinesDir, "beta"), { recursive: true });
		writeFileSync(join(machinesDir, "beta", "machine.json"), JSON.stringify({ status: "stopped" }));
		mkdirSync(join(machinesDir, "gamma"), { recursive: true });
		writeFileSync(join(machinesDir, "gamma", "machine.json"), "{not-json");

		expect(listRunningMachineNamesForCompletion()).toEqual(["alpha"]);
	});
});
