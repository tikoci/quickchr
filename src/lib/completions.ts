/**
 * Shell completions — generation, detection, install, and uninstall.
 * Supports bash, zsh, and fish. No external dependencies.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { listMachineNames, getMachinesDir } from "./state.ts";

export type SupportedShell = "bash" | "zsh" | "fish";
const SUPPORTED_SHELLS: SupportedShell[] = ["bash", "zsh", "fish"];

// ─── Shell detection ────────────────────────────────────────────────────────

export interface ShellInfo {
	/** Value of $SHELL env var or parent-process name. */
	shell: string;
	/** Version string from `<shell> --version`, if available. */
	version: string | undefined;
	/** True if shell is one quickchr can install completions for. */
	supported: boolean;
}

/**
 * Detect the current interactive shell.
 *
 * $SHELL reflects the *login* shell, not the currently running one — e.g. it stays
 * "/bin/zsh" even inside a fish session. Shell-specific env vars exported by the
 * running shell are more reliable: fish exports FISH_VERSION, zsh exports ZSH_VERSION,
 * bash exports BASH_VERSION. We check those first, then fall back to $SHELL.
 */
export function detectCurrentShell(): ShellInfo {
	// Shell-specific env vars take priority over $SHELL (login shell).
	// These are exported by the *currently running* interactive shell.
	let detectedBinary: string | undefined;
	let version: string | undefined;

	if (process.env.FISH_VERSION) {
		detectedBinary = "fish";
		version = process.env.FISH_VERSION;
	} else if (process.env.ZSH_VERSION) {
		detectedBinary = "zsh";
		version = process.env.ZSH_VERSION;
	} else if (process.env.BASH_VERSION) {
		detectedBinary = "bash";
		const m = process.env.BASH_VERSION.match(/(\d+\.\d+[\w.]*)/);
		version = m?.[1] ?? process.env.BASH_VERSION.slice(0, 60);
	}

	// Resolve full path for the detected binary (or fall back to $SHELL).
	let shell: string;
	if (detectedBinary) {
		const probe = process.platform === "win32" ? ["where.exe", detectedBinary] : ["which", detectedBinary];
		const which = Bun.spawnSync(probe, { stdout: "pipe", stderr: "pipe" });
		shell = which.exitCode === 0
			? new TextDecoder().decode(which.stdout).trim().split(/\r?\n/)[0] ?? detectedBinary
			: detectedBinary;
	} else {
		const shellEnv = process.env.SHELL ?? "";
		shell = shellEnv || "unknown";
		// Get version from the login shell binary.
		if (shellEnv) {
			try {
				const result = Bun.spawnSync([shellEnv, "--version"], { stdout: "pipe", stderr: "pipe" });
				if (result.exitCode === 0) {
					const out = new TextDecoder().decode(result.stdout).trim();
					const firstLine = out.split("\n")[0] ?? "";
					const match = firstLine.match(/(\d+\.\d+[\w.]*)/);
					version = (match?.[1] ?? firstLine.slice(0, 60)) || undefined;
				}
			} catch {
				// version unavailable
			}
		}
	}

	// Handle both POSIX (/) and Windows (\) separators — `where.exe bash` on
	// windows-latest returns paths like "C:\Program Files\Git\bin\bash.exe".
	const binary = (shell.split(/[\\/]/).at(-1) ?? shell).replace(/\.exe$/i, "");
	const supported = (SUPPORTED_SHELLS as string[]).includes(binary);

	return { shell, version, supported };
}

/** Parse the shell binary name from a full path or name string. */
export function shellBinary(shellInfo: ShellInfo): string {
	const raw = shellInfo.shell.split(/[\\/]/).at(-1) ?? shellInfo.shell;
	return raw.replace(/\.exe$/i, "");
}

// ─── Install paths ──────────────────────────────────────────────────────────

export interface CompletionInstallPath {
	/** Absolute path where the completion file should be written. */
	file: string;
	/** If the rc file needs modification, this is the line to append. */
	rcLine?: string;
	/** The rc file to modify. */
	rcFile?: string;
}

function homeDir(): string {
	return process.env.HOME ?? process.env.USERPROFILE ?? "";
}

function brewPrefix(): string | undefined {
	// Check common Homebrew prefix locations; avoid spawning brew for speed.
	for (const p of ["/opt/homebrew", "/usr/local"]) {
		if (existsSync(p)) return p;
	}
	return undefined;
}

function quickchrCompletionsDir(): string {
	const dataDir = join(homeDir(), ".local", "share", "quickchr", "completions");
	return dataDir;
}

/**
 * Resolve the install path (and optional rc-file line) for a given shell.
 * Prefers Homebrew locations when available (no rc modification needed).
 */
export function completionInstallPath(shell: SupportedShell): CompletionInstallPath {
	const home = homeDir();
	const brew = brewPrefix();

	if (shell === "bash") {
		// Homebrew: files sourced automatically by bash-completion
		if (brew) {
			const brewDir = `${brew}/etc/bash_completion.d`;
			if (existsSync(brewDir)) {
				return { file: join(brewDir, "quickchr") };
			}
		}
		// XDG user dir: bash-completion ≥2 sources these automatically
		const xdgDir = join(home, ".local", "share", "bash-completion", "completions");
		if (existsSync(xdgDir)) {
			return { file: join(xdgDir, "quickchr") };
		}
		// Fallback: write to quickchr data dir and source from rc
		const file = join(quickchrCompletionsDir(), "quickchr.bash");
		const rcFile = process.platform === "darwin"
			? join(home, ".bash_profile")
			: join(home, ".bashrc");
		return {
			file,
			rcLine: `[ -f "${file}" ] && . "${file}"`,
			rcFile,
		};
	}

	if (shell === "zsh") {
		// Homebrew: files in site-functions are in default fpath
		if (brew) {
			const brewDir = `${brew}/share/zsh/site-functions`;
			if (existsSync(brewDir)) {
				return { file: join(brewDir, "_quickchr") };
			}
		}
		// User dir: must be added to fpath before compinit
		const file = join(quickchrCompletionsDir(), "_quickchr");
		const completionsDir = quickchrCompletionsDir();
		const rcFile = join(home, ".zshrc");
		return {
			file,
			rcLine: `fpath=("${completionsDir}" $fpath)`,
			rcFile,
		};
	}

	// fish: auto-sourced from this directory, no rc modification needed
	const fishDir = join(home, ".config", "fish", "completions");
	return { file: join(fishDir, "quickchr.fish") };
}

// ─── Status ─────────────────────────────────────────────────────────────────

export interface CompletionStatus {
	shell: SupportedShell;
	installed: boolean;
	/** Path where the completion file was found (or expected). */
	path: string;
}

/** Check whether completions are installed for a given shell. */
export function completionStatusFor(shell: SupportedShell): CompletionStatus {
	const { file } = completionInstallPath(shell);
	return {
		shell,
		installed: existsSync(file),
		path: file,
	};
}

/** Check completion status for all supported shells. */
export function allCompletionStatuses(): CompletionStatus[] {
	return SUPPORTED_SHELLS.map(completionStatusFor);
}

// ─── Install / Uninstall ────────────────────────────────────────────────────

export interface InstallResult {
	shell: SupportedShell;
	file: string;
	/** Line appended to rc file, if any. */
	rcLine?: string;
	rcFile?: string;
	/** True if the file was already present (skipped rewrite). */
	alreadyInstalled: boolean;
	/** True when --dry-run: nothing was written. */
	dryRun: boolean;
}

/** Install completions for the given shell. Returns what was done. */
export function installCompletions(
	shell: SupportedShell,
	opts: { dryRun?: boolean } = {},
): InstallResult {
	const { file, rcLine, rcFile } = completionInstallPath(shell);
	const alreadyInstalled = existsSync(file);
	const dryRun = opts.dryRun ?? false;

	if (!dryRun) {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, generateCompletionScript(shell), "utf8");

		if (rcLine && rcFile) {
			appendRcLine(rcFile, rcLine);
		}
	}

	return { shell, file, rcLine, rcFile, alreadyInstalled, dryRun };
}

/** Remove completions for the given shell. Returns true if the file existed. */
export function uninstallCompletions(shell: SupportedShell): { removed: boolean; file: string; rcLine?: string; rcFile?: string } {
	const { file, rcLine, rcFile } = completionInstallPath(shell);
	const removed = existsSync(file);
	if (removed) {
		unlinkSync(file);
	}
	if (rcLine && rcFile && existsSync(rcFile)) {
		removeRcLine(rcFile, rcLine);
	}
	return { removed, file, rcLine, rcFile };
}

/** Append a line to an rc file, only if it's not already present. */
function appendRcLine(rcFile: string, line: string): void {
	let content = "";
	if (existsSync(rcFile)) {
		content = readFileSync(rcFile, "utf8");
	}
	if (content.includes(line)) return;
	const sep = content.endsWith("\n") || content.length === 0 ? "" : "\n";
	writeFileSync(rcFile, `${content}${sep}${line}\n`, "utf8");
}

/** Remove a previously-appended line from an rc file (exact match). */
function removeRcLine(rcFile: string, line: string): void {
	if (!existsSync(rcFile)) return;
	const content = readFileSync(rcFile, "utf8");
	const filtered = content
		.split("\n")
		.filter((l) => l !== line)
		.join("\n");
	writeFileSync(rcFile, filtered, "utf8");
}

// ─── Machine name helpers (used by completion scripts) ──────────────────────

/** List all machine names for completion. */
export function listMachineNamesForCompletion(): string[] {
	try {
		return listMachineNames();
	} catch {
		return [];
	}
}

/** List running machine names for completion. */
export function listRunningMachineNamesForCompletion(): string[] {
	try {
		const machinesDir = getMachinesDir();
		if (!existsSync(machinesDir)) return [];

		const names: string[] = [];
		for (const entry of readdirSync(machinesDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const mjPath = join(machinesDir, entry.name, "machine.json");
			if (!existsSync(mjPath)) continue;
			try {
				const state = JSON.parse(readFileSync(mjPath, "utf8")) as { status?: string };
				if (state.status === "running") names.push(entry.name);
			} catch {
				// skip unreadable
			}
		}
		return names;
	} catch {
		return [];
	}
}

// ─── Completion script generators ───────────────────────────────────────────

/** Generate a completion script for the given shell. */
export function generateCompletionScript(shell: SupportedShell): string {
	switch (shell) {
		case "bash": return generateBashCompletion();
		case "zsh": return generateZshCompletion();
		case "fish": return generateFishCompletion();
	}
}

function generateBashCompletion(): string {
	// Use $ as a variable to embed ${...} patterns without triggering JS template interpolation.
	const D = "$";
	return `# quickchr bash completion
# Generated by quickchr. Source this file or let bash-completion do it automatically.

_quickchr() {
    local cur prev words cword
    _init_completion 2>/dev/null || {
        cur="${D}{COMP_WORDS[COMP_CWORD]}"
        prev="${D}{COMP_WORDS[COMP_CWORD-1]}"
        words=("${D}{COMP_WORDS[@]}")
        cword=${D}COMP_CWORD
    }

    local commands="add start stop list ls status remove rm clean console exec qga license disk snapshot snap networks net doctor setup completions version help"

    if [[ ${D}cword -eq 1 ]]; then
        COMPREPLY=( $(compgen -W "${D}commands" -- "${D}cur") )
        return
    fi

    local cmd="${D}{words[1]}"
    case "${D}cmd" in
        start|remove|rm|clean|console|exec|qga|license|disk|snapshot|snap|status)
            local machines
            machines=$(quickchr completions --machines 2>/dev/null)
            COMPREPLY=( $(compgen -W "${D}machines" -- "${D}cur") )
            ;;
        stop)
            local machines
            machines=$(quickchr completions --running 2>/dev/null)
            [[ -z "${D}machines" ]] && machines=$(quickchr completions --machines 2>/dev/null)
            COMPREPLY=( $(compgen -W "${D}machines" -- "${D}cur") )
            ;;
        completions)
            local opts="--install --uninstall --status --dry-run --shell"
            COMPREPLY=( $(compgen -W "${D}opts" -- "${D}cur") )
            ;;
        help)
            COMPREPLY=( $(compgen -W "${D}commands" -- "${D}cur") )
            ;;
    esac
}

complete -F _quickchr quickchr
`;
}

function generateZshCompletion(): string {
	// Use $ as a variable to embed ${...} patterns without triggering JS template interpolation.
	const D = "$";
	return `#compdef quickchr
# quickchr zsh completion
# Generated by quickchr.

_quickchr() {
    local state

    _arguments \\
        '(- *)'{-h,--help}'[Show help]' \\
        '(- *)'{-v,--version}'[Show version]' \\
        '1: :->command' \\
        '*: :->args'

    case ${D}state in
        command)
            local commands=(
                'add:Create a new CHR machine (without starting)'
                'start:Start or restart a CHR instance'
                'stop:Stop instance(s)'
                'list:List all instances'
                'ls:List all instances (alias)'
                'status:Detailed status'
                'remove:Remove instance(s) and disk'
                'rm:Remove instance(s) (alias)'
                'clean:Reset instance disk to fresh image'
                'console:Attach to serial console'
                'exec:Run a RouterOS CLI command'
                'qga:Guest agent command'
                'license:Apply/renew CHR trial license'
                'disk:Show disk details'
                'snapshot:Manage snapshots'
                'snap:Manage snapshots (alias)'
                'networks:Network discovery and socket management'
                'net:Network discovery (alias)'
                'doctor:Check prerequisites'
                'setup:Interactive setup wizard'
                'completions:Manage shell completions'
                'version:Show version info'
                'help:Show help'
            )
            _describe 'command' commands
            ;;
        args)
            local cmd="${D}{words[2]}"
            case ${D}cmd in
                start|remove|rm|clean|console|exec|qga|license|disk|snapshot|snap|status)
                    local machines
                    machines=(${D}{(f)"${D}(quickchr completions --machines 2>/dev/null)"})
                    _describe 'machine' machines
                    ;;
                stop)
                    local machines
                    machines=(${D}{(f)"${D}(quickchr completions --running 2>/dev/null)"})
                    (( ${D}{#machines} == 0 )) && machines=(${D}{(f)"${D}(quickchr completions --machines 2>/dev/null)"})
                    _describe 'machine' machines
                    ;;
                completions)
                    local opts=(
                        '--install:Install completions for the current shell'
                        '--uninstall:Remove completions'
                        '--status:Show install status for all shells'
                        '--dry-run:Show what would happen without writing'
                        '--shell:Specify shell (bash, zsh, fish)'
                    )
                    _describe 'option' opts
                    ;;
                help)
                    local commands=(add start stop list status remove clean console exec qga license disk snapshot networks doctor setup completions version)
                    _describe 'command' commands
                    ;;
            esac
            ;;
    esac
}

_quickchr "${D}@"
`;
}

function generateFishCompletion(): string {
	return `# quickchr fish completion
# Generated by quickchr. Fish auto-loads files from ~/.config/fish/completions/.

set -l quickchr_commands add start stop list ls status remove rm clean console exec qga license disk snapshot snap networks net doctor setup completions version help

# Disable file completions globally for quickchr
complete -c quickchr -f

# Subcommands
complete -c quickchr -n "not __fish_seen_subcommand_from $quickchr_commands" \\
    -a "add"         -d "Create a new CHR machine"
complete -c quickchr -n "not __fish_seen_subcommand_from $quickchr_commands" \\
    -a "start"       -d "Start or restart a CHR instance"
complete -c quickchr -n "not __fish_seen_subcommand_from $quickchr_commands" \\
    -a "stop"        -d "Stop instance(s)"
complete -c quickchr -n "not __fish_seen_subcommand_from $quickchr_commands" \\
    -a "list ls"     -d "List all instances"
complete -c quickchr -n "not __fish_seen_subcommand_from $quickchr_commands" \\
    -a "status"      -d "Detailed status"
complete -c quickchr -n "not __fish_seen_subcommand_from $quickchr_commands" \\
    -a "remove rm"   -d "Remove instance(s) and disk"
complete -c quickchr -n "not __fish_seen_subcommand_from $quickchr_commands" \\
    -a "clean"       -d "Reset instance disk to fresh image"
complete -c quickchr -n "not __fish_seen_subcommand_from $quickchr_commands" \\
    -a "console"     -d "Attach to serial console"
complete -c quickchr -n "not __fish_seen_subcommand_from $quickchr_commands" \\
    -a "exec"        -d "Run a RouterOS CLI command"
complete -c quickchr -n "not __fish_seen_subcommand_from $quickchr_commands" \\
    -a "qga"         -d "Guest agent command"
complete -c quickchr -n "not __fish_seen_subcommand_from $quickchr_commands" \\
    -a "license"     -d "Apply/renew CHR trial license"
complete -c quickchr -n "not __fish_seen_subcommand_from $quickchr_commands" \\
    -a "disk"        -d "Show disk details"
complete -c quickchr -n "not __fish_seen_subcommand_from $quickchr_commands" \\
    -a "snapshot snap" -d "Manage snapshots"
complete -c quickchr -n "not __fish_seen_subcommand_from $quickchr_commands" \\
    -a "networks net" -d "Network discovery and socket management"
complete -c quickchr -n "not __fish_seen_subcommand_from $quickchr_commands" \\
    -a "doctor"      -d "Check prerequisites"
complete -c quickchr -n "not __fish_seen_subcommand_from $quickchr_commands" \\
    -a "setup"       -d "Interactive setup wizard"
complete -c quickchr -n "not __fish_seen_subcommand_from $quickchr_commands" \\
    -a "completions" -d "Manage shell completions"
complete -c quickchr -n "not __fish_seen_subcommand_from $quickchr_commands" \\
    -a "version"     -d "Show version info"
complete -c quickchr -n "not __fish_seen_subcommand_from $quickchr_commands" \\
    -a "help"        -d "Show help"

# Machine name completions for commands that take a running machine
complete -c quickchr -n "__fish_seen_subcommand_from stop" \\
    -a "(quickchr completions --running 2>/dev/null; or quickchr completions --machines 2>/dev/null)" \\
    -d "machine"

# Machine name completions for commands that take any machine
complete -c quickchr -n "__fish_seen_subcommand_from start remove rm clean console exec qga license disk snapshot snap status" \\
    -a "(quickchr completions --machines 2>/dev/null)" \\
    -d "machine"

# completions subcommand options
complete -c quickchr -n "__fish_seen_subcommand_from completions" -l install   -d "Install completions"
complete -c quickchr -n "__fish_seen_subcommand_from completions" -l uninstall -d "Remove completions"
complete -c quickchr -n "__fish_seen_subcommand_from completions" -l status    -d "Show install status"
complete -c quickchr -n "__fish_seen_subcommand_from completions" -l dry-run   -d "Show what would happen"
complete -c quickchr -n "__fish_seen_subcommand_from completions" -l shell     -d "Specify shell" -a "bash zsh fish"
`;
}
