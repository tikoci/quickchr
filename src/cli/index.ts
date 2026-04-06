#!/usr/bin/env bun
/**
 * quickchr CLI entry point — command router.
 */

import type { StartOptions, Arch, Channel, ServiceName } from "../lib/types.ts";

const args = process.argv.slice(2);
const command = args[0];

/** Parse --flag=value and --flag value pairs from args. */
function parseFlags(argv: string[]): { flags: Record<string, string | boolean | string[]>; positional: string[] } {
	const flags: Record<string, string | boolean | string[]> = {};
	const positional: string[] = [];

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === undefined) break;
		if (arg === "--") {
			positional.push(...argv.slice(i + 1));
			break;
		}
		if (arg.startsWith("--")) {
			const eqIdx = arg.indexOf("=");
			if (eqIdx !== -1) {
				const key = arg.slice(2, eqIdx);
				flags[key] = arg.slice(eqIdx + 1);
			} else if (arg.startsWith("--no-")) {
				flags[arg.slice(5)] = false;
			} else {
				const key = arg.slice(2);
				const next = argv[i + 1];
				if (next && !next.startsWith("--")) {
					// Check if this is a repeatable flag
					const existing = flags[key];
					if (Array.isArray(existing)) {
						existing.push(next);
					} else if (existing !== undefined && typeof existing === "string") {
						flags[key] = [existing, next];
					} else {
						flags[key] = next;
					}
					i++;
				} else {
					flags[key] = true;
				}
			}
		} else {
			positional.push(arg);
		}
	}

	return { flags, positional };
}

function flag(flags: Record<string, string | boolean | string[]>, key: string): string | undefined {
	const val = flags[key];
	if (typeof val === "string") return val;
	return undefined;
}

function flagBool(flags: Record<string, string | boolean | string[]>, key: string): boolean {
	return flags[key] === true || flags[key] === "true";
}

function flagList(flags: Record<string, string | boolean | string[]>, key: string): string[] {
	const val = flags[key];
	if (Array.isArray(val)) return val;
	if (typeof val === "string") return [val];
	return [];
}

/** True when interactive prompts must be suppressed (e.g. LLM / CI / pipe). */
function isNoPrompt(): boolean {
	return !!process.env.QUICKCHR_NO_PROMPT || !process.stdout.isTTY || !process.stdin.isTTY;
}

async function main() {
	try {
		switch (command) {
			case "start":
				await cmdStart(args.slice(1));
				break;
			case "stop":
				await cmdStop(args.slice(1));
				break;
			case "list":
			case "ls":
				await cmdList();
				break;
			case "status":
				await cmdStatus(args.slice(1));
				break;
			case "remove":
			case "rm":
				await cmdRemove(args.slice(1));
				break;
			case "clean":
				await cmdClean(args.slice(1));
				break;
			case "doctor":
				await cmdDoctor();
				break;
			case "version":
			case "--version":
			case "-v":
				await cmdVersion();
				break;
			case "help":
			case "--help":
			case "-h":
				printHelp(args[1]);
				break;
			case undefined:
				// No command — smart home screen if TTY, otherwise help
				// Delegates to cmdStart: existing machines → restart selector, none → wizard
				if (isNoPrompt()) {
					printHelp();
				} else {
					await cmdStart([]);
				}
				break;
			default:
				console.error(`Unknown command: ${command}\nRun 'quickchr help' for usage.`);
				process.exit(1);
		}
	} catch (e: unknown) {
		if (e && typeof e === "object" && "code" in e && "message" in e) {
			const err = e as { code: string; message: string; installHint?: string };
			console.error(`Error [${err.code}]: ${err.message}`);
			if (err.installHint) {
				console.error(`  Hint: ${err.installHint}`);
			}
			process.exit(1);
		}
		throw e;
	}
}

// --- Commands ---

/** Print QEMU keyboard shortcuts before foreground launch. Screen clears after QEMU starts. */
function printForegroundTips() {
	const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
	const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
	const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
	console.log();
	console.log(bold("  Foreground mode — QEMU serial console attached"));
	console.log(`  ${cyan("Ctrl-A X")}  ${dim("exit QEMU and return to shell")}`);
	console.log(`  ${cyan("Ctrl-A C")}  ${dim("toggle QEMU monitor (type 'quit' to force-stop)")}`);
	console.log(`  ${cyan("Ctrl-A H")}  ${dim("list all QEMU serial shortcuts")}`);
	console.log(`  ${cyan("Ctrl-A S")}  ${dim("send break signal to serial port")}`);
	console.log();
	console.log(dim("  (screen clears when QEMU initializes)"));
	console.log();
}

async function cmdStart(argv: string[]) {
	const { flags, positional } = parseFlags(argv);

	// --all: start every stopped machine in background
	if (flagBool(flags, "all")) {
		const { QuickCHR } = await import("../lib/quickchr.ts");
		const { statusIcon, link, bold } = await import("./format.ts");
		const stopped = QuickCHR.list().filter((m) => m.status !== "running");
		if (stopped.length === 0) {
			console.log("No stopped instances.");
			return;
		}
		for (const m of stopped) {
			console.log(`Starting ${bold(m.name)}...`);
			const instance = await QuickCHR.start({ name: m.name, background: true });
			console.log(`${statusIcon("running")} ${bold(instance.name)}  REST: ${link(instance.restUrl)}  SSH: ssh admin@127.0.0.1 -p ${instance.sshPort}`);
		}
		return;
	}

	// Determine if a specific target was requested via flags or positional
	const hasExplicitTarget =
		positional[0] !== undefined ||
		flag(flags, "name") !== undefined ||
		flag(flags, "version") !== undefined ||
		flag(flags, "channel") !== undefined;

	// No target + interactive → show selector (restart existing) or launch wizard
	if (!hasExplicitTarget && !isNoPrompt()) {
		const { QuickCHR } = await import("../lib/quickchr.ts");
		const stopped = QuickCHR.list().filter((m) => m.status !== "running");

		if (stopped.length > 0) {
			const clack = await import("@clack/prompts");
			clack.intro("quickchr start");
			const selected = await clack.select({
				message: "Restart a stopped machine or create a new CHR?",
				options: [
					{ value: "__new__", label: "Create new CHR", hint: "opens wizard" },
					...stopped.map((m) => ({
						value: m.name,
						label: m.name,
						hint: `${m.version} (${m.arch})`,
					})),
				],
			});
			if (clack.isCancel(selected)) { clack.cancel("Cancelled."); return; }
			if (selected === "__new__") {
				clack.outro("");
				const { runWizard } = await import("./wizard.ts");
				return runWizard();
			}
			clack.outro("");
			const { statusIcon, link, bold } = await import("./format.ts");
			const instance = await QuickCHR.start({ name: selected as string, background: true });
			console.log(`${statusIcon("running")} ${bold(instance.name)} started`);
			console.log(`  REST:   ${link(instance.restUrl)}`);
			console.log(`  SSH:    ssh admin@127.0.0.1 -p ${instance.sshPort}`);
			console.log(`  WinBox: 127.0.0.1:${instance.ports.winbox}`);
			return;
		}

		// No stopped machines → wizard
		const { runWizard } = await import("./wizard.ts");
		return runWizard();
	}

	// No target + not TTY → show help
	if (!hasExplicitTarget) {
		printCommandHelp("start");
		return;
	}

	// Build start options from flags
	const { QuickCHR } = await import("../lib/quickchr.ts");
	const { statusIcon, formatPorts, link, bold } = await import("./format.ts");

	const opts: StartOptions = {
		version: flag(flags, "version"),
		channel: flag(flags, "channel") as Channel | undefined,
		arch: flag(flags, "arch") as Arch | undefined,
		name: flag(flags, "name") ?? positional[0],
		cpu: flag(flags, "cpu") ? Number(flag(flags, "cpu")) : undefined,
		mem: flag(flags, "mem") ? Number(flag(flags, "mem")) : undefined,
		packages: flagList(flags, "add-package"),
		portBase: flag(flags, "port-base") ? Number(flag(flags, "port-base")) : undefined,
		excludePorts: [
			...(flags.winbox === false ? ["winbox" as ServiceName] : []),
			...(flags["api-ssl"] === false ? ["api-ssl" as ServiceName] : []),
		],
		network: flag(flags, "vmnet-shared") !== undefined ? "vmnet-shared"
			: flag(flags, "vmnet-bridge") ? { type: "vmnet-bridge" as const, iface: flag(flags, "vmnet-bridge") as string }
			: undefined,
		installDeps: flagBool(flags, "install-deps"),
		dryRun: flagBool(flags, "dry-run"),
	};

	// --add-user admin:pass
	const userStr = flag(flags, "add-user");
	if (userStr) {
		const [name = "", password] = userStr.split(":");
		opts.user = { name, password: password ?? "" };
	}

	opts.disableAdmin = flagBool(flags, "disable-admin");

	// Background default: true. Explicitly foreground only with --fg / --foreground / --no-background / --no-bg.
	const wantFg =
		flagBool(flags, "fg") ||
		flagBool(flags, "foreground") ||
		flags.background === false ||
		flags.bg === false;
	opts.background = !wantFg;

	if (opts.dryRun) {
		console.log("Dry run — would start with options:", JSON.stringify(opts, null, 2));
		return;
	}

	if (!opts.background) {
		printForegroundTips();
		// Brief pause so user can read tips before QEMU clears the screen
		await Bun.sleep(1500);
	}

	const instance = await QuickCHR.start(opts);

	if (!opts.background) {
		// QEMU exited — show session summary
		console.log(`\n${bold(instance.name)} session ended`);
		console.log(`  Tip: quickchr start ${instance.name}`);
	} else {
		console.log(`${statusIcon("running")} ${bold(instance.name)} started`);
		console.log(`  Version: ${instance.state.version} (${instance.state.arch})`);
		console.log(`  Ports:   ${formatPorts(instance.state.ports)}`);
		console.log(`  REST:    ${link(instance.restUrl)}`);
		console.log(`  SSH:     ssh admin@127.0.0.1 -p ${instance.sshPort}`);
		console.log(`  WinBox:  127.0.0.1:${instance.ports.winbox}`);
	}
}

async function cmdStop(argv: string[]) {
	const { flags, positional } = parseFlags(argv);
	const { QuickCHR } = await import("../lib/quickchr.ts");
	const { statusIcon, bold } = await import("./format.ts");

	if (flagBool(flags, "all")) {
		const machines = QuickCHR.list().filter((m) => m.status === "running");
		if (machines.length === 0) {
			console.log("No running instances.");
			return;
		}
		for (const m of machines) {
			const instance = QuickCHR.get(m.name);
			if (instance) {
				await instance.stop();
				console.log(`${statusIcon("stopped")} ${bold(m.name)} stopped`);
			}
		}
		return;
	}

	const name = positional[0] ?? flag(flags, "name");

	if (!name) {
		const running = QuickCHR.list().filter((m) => m.status === "running");
		if (running.length === 0) {
			console.log("No running instances.");
			return;
		}
		if (isNoPrompt()) {
			console.error("Usage: quickchr stop <name|--all>");
			process.exit(1);
		}

		const clack = await import("@clack/prompts");
		clack.intro("quickchr stop");
		const selected = await clack.select({
			message: "Select instance to stop:",
			options: running.map((m) => ({
				value: m.name,
				label: m.name,
				hint: `${m.version} (${m.arch})  PID ${m.pid}`,
			})),
		});
		if (clack.isCancel(selected)) { clack.cancel("Cancelled."); return; }
		clack.outro("");
		const target = QuickCHR.get(selected as string);
		if (target) {
			await target.stop();
			console.log(`${statusIcon("stopped")} ${bold(selected as string)} stopped`);
		}
		return;
	}

	const instance = QuickCHR.get(name);
	if (!instance) {
		console.error(`Machine "${name}" not found.`);
		process.exit(1);
	}
	await instance.stop();
	console.log(`${statusIcon("stopped")} ${bold(name)} stopped`);
}

async function cmdList() {
	const { QuickCHR } = await import("../lib/quickchr.ts");
	const { table, statusIcon, formatPorts, dim } = await import("./format.ts");

	const machines = QuickCHR.list();

	if (machines.length === 0) {
		console.log("No instances. Run 'quickchr start' to create one.");
		return;
	}

	const headers = ["", "Name", "Version", "Arch", "Ports", "PID"];
	const rows = machines.map((m) => [
		statusIcon(m.status),
		m.name,
		m.version,
		m.arch,
		formatPorts(m.ports),
		m.pid ? String(m.pid) : dim("—"),
	]);

	console.log(table(headers, rows));
}

async function cmdStatus(argv: string[]) {
	const { QuickCHR } = await import("../lib/quickchr.ts");
	const { statusIcon, bold, dim, link, formatPorts } = await import("./format.ts");

	let name = argv[0];

	if (!name) {
		const machines = QuickCHR.list();
		if (machines.length === 0) {
			console.log("No instances. Run 'quickchr start' to create one.");
			return;
		}
		if (!isNoPrompt()) {
			const clack = await import("@clack/prompts");
			clack.intro("quickchr status");
			const selected = await clack.select({
				message: "Select instance:",
				options: machines.map((m) => ({
					value: m.name,
					label: m.name,
					hint: `${m.status} · ${m.version} (${m.arch})`,
				})),
			});
			if (clack.isCancel(selected)) { clack.cancel("Cancelled."); return; }
			clack.outro("");
			name = selected as string;
		} else {
			await cmdList();
			return;
		}
	}

	const instance = QuickCHR.get(name);
	if (!instance) {
		console.error(`Machine "${name}" not found.`);
		process.exit(1);
	}

	const s = instance.state;
	console.log(`\n${statusIcon(s.status)} ${bold(s.name)}`);
	console.log(`  Version:    ${s.version} (${s.arch})`);
	console.log(`  CPU/Mem:    ${s.cpu} vCPU${s.cpu > 1 ? "s" : ""}, ${s.mem} MB`);
	console.log(`  Network:    ${typeof s.network === "string" ? s.network : `vmnet-bridge (${s.network.iface})`}`);
	console.log(`  Ports:      ${formatPorts(s.ports)}`);
	console.log(`  Status:     ${s.status}${s.pid ? ` (PID ${s.pid})` : ""}`);
	console.log(`  Created:    ${new Date(s.createdAt).toLocaleString()}`);
	if (s.lastStartedAt) console.log(`  Started:    ${new Date(s.lastStartedAt).toLocaleString()}`);
	if (s.packages.length > 0) console.log(`  Packages:   ${s.packages.join(", ")}`);
	console.log(`  Dir:        ${dim(s.machineDir)}`);
	console.log(`  Logs:       ${dim(`${s.machineDir}/qemu.log`)}`);

	if (s.status === "running") {
		console.log();
		console.log(`  REST:       ${link(`http://127.0.0.1:${instance.ports.http}`)}`);
		console.log(`  WinBox:     127.0.0.1:${instance.ports.winbox}`);
		console.log(`  SSH:        ssh admin@127.0.0.1 -p ${instance.sshPort}`);
		console.log();
		console.log(`  ${dim("Tip:")} quickchr stop ${s.name}`);
	} else {
		console.log();
		console.log(`  ${dim("Tip:")} quickchr start ${s.name}  |  quickchr remove ${s.name}`);
	}
	console.log();
}

async function cmdRemove(argv: string[]) {
	const { flags, positional } = parseFlags(argv);
	const { QuickCHR } = await import("../lib/quickchr.ts");
	const { bold, statusIcon } = await import("./format.ts");

	// --all: remove every machine (warn about running ones)
	if (flagBool(flags, "all")) {
		const machines = QuickCHR.list();
		if (machines.length === 0) {
			console.log("No instances.");
			return;
		}
		for (const m of machines) {
			const instance = QuickCHR.get(m.name);
			if (instance) {
				await instance.remove();
				console.log(`${statusIcon("stopped")} ${bold(m.name)} removed`);
			}
		}
		return;
	}

	const name = positional[0] ?? flag(flags, "name");

	if (!name) {
		const machines = QuickCHR.list();
		if (machines.length === 0) {
			console.log("No instances.");
			return;
		}
		if (isNoPrompt()) {
			console.error("Usage: quickchr remove <name|--all>");
			process.exit(1);
		}

		const clack = await import("@clack/prompts");
		clack.intro("quickchr remove");
		const selected = await clack.select({
			message: "Select instance to remove:",
			options: machines.map((m) => ({
				value: m.name,
				label: m.name,
				hint: `${m.status} · ${m.version} (${m.arch})`,
			})),
		});
		if (clack.isCancel(selected)) { clack.cancel("Cancelled."); return; }
		clack.outro("");
		const target = QuickCHR.get(selected as string);
		if (target) {
			await target.remove();
			console.log(`${bold(selected as string)} removed.`);
		}
		return;
	}

	const instance = QuickCHR.get(name);
	if (!instance) {
		console.error(`Machine "${name}" not found.`);
		process.exit(1);
	}

	await instance.remove();
	console.log(`${bold(name)} removed.`);
}

async function cmdClean(argv: string[]) {
	const { flags, positional } = parseFlags(argv);
	const { QuickCHR } = await import("../lib/quickchr.ts");
	const { bold, statusIcon } = await import("./format.ts");

	const name = positional[0] ?? flag(flags, "name");

	if (!name) {
		const machines = QuickCHR.list();
		if (machines.length === 0) {
			console.log("No instances.");
			return;
		}
		if (isNoPrompt()) {
			console.error("Usage: quickchr clean <name>");
			process.exit(1);
		}

		const clack = await import("@clack/prompts");
		clack.intro("quickchr clean");
		const selected = await clack.select({
			message: "Select instance to reset to fresh image:",
			options: machines.map((m) => ({
				value: m.name,
				label: m.name,
				hint: `${m.status} · ${m.version} (${m.arch})`,
			})),
		});
		if (clack.isCancel(selected)) { clack.cancel("Cancelled."); return; }
		clack.outro("");
		const target = QuickCHR.get(selected as string);
		if (target) {
			await target.clean();
			console.log(`${statusIcon("stopped")} ${bold(selected as string)} reset to fresh image.`);
		}
		return;
	}

	const instance = QuickCHR.get(name);
	if (!instance) {
		console.error(`Machine "${name}" not found.`);
		process.exit(1);
	}

	await instance.clean();
	console.log(`${bold(name)} reset to fresh image.`);
}

async function cmdDoctor() {
	const { QuickCHR } = await import("../lib/quickchr.ts");
	const { statusIcon, bold } = await import("./format.ts");

	const result = await QuickCHR.doctor();

	console.log(bold("quickchr doctor\n"));
	for (const check of result.checks) {
		console.log(`${statusIcon(check.status)} ${check.label}: ${check.detail}`);
	}

	console.log();
	if (result.ok) {
		console.log("All checks passed.");
	} else {
		console.log("Some checks failed. Fix the errors above, then retry.");
		process.exit(1);
	}
}

async function cmdVersion() {
	const pkg = await import("../../package.json");
	console.log(`quickchr ${pkg.version}`);

	try {
		const { resolveAllVersions } = await import("../lib/versions.ts");
		const versions = await resolveAllVersions();
		console.log("\nLatest RouterOS versions:");
		for (const [channel, version] of Object.entries(versions)) {
			console.log(`  ${channel.padEnd(12)} ${version}`);
		}
	} catch {
		// Offline — skip version lookup
	}
}

// --- Help ---

function printHelp(command?: string) {
	if (command) {
		printCommandHelp(command);
		return;
	}

	console.log(`quickchr — MikroTik CHR QEMU Manager

Usage:
  quickchr                         Interactive wizard (TTY only)
  quickchr <command> [options]

Commands:
  start [<name>|options]  Restart existing or start new CHR instance
  stop [<name>|--all]     Stop instance(s) — interactive selector if no name
  list                    List all instances (plain table)
  status [<name>]         Detailed status — interactive selector if no name
  remove [<name>|--all]   Remove instance(s) and disk — interactive selector if no name
  clean [<name>]          Reset instance disk to fresh image — interactive selector if no name
  doctor                  Check prerequisites
  version                 Show version info
  help [command]          Show help

Environment:
  QUICKCHR_NO_PROMPT=1    Disable interactive selectors (for scripts/LLMs)

Run 'quickchr help <command>' for command-specific help.`);
}

function printCommandHelp(command: string) {
	switch (command) {
		case "start":
			console.log(`quickchr start [<name>] [options]

  <name>              Restart an existing machine by name, or use as name for new.
                      Omit to get an interactive selector (TTY) or wizard.

Options:
  --version <ver>       RouterOS version (e.g., 7.22.1)
  --channel <ch>        Channel: stable, long-term, testing, development
  --arch <arch>         Architecture: arm64, x86 (default: host native)
  --name <name>         Instance name for a new machine
  --cpu <n>             vCPU count (default: 1)
  --mem <mb>            RAM in MB (default: 512)
  --bg / --background   Run in background (default)
  --fg / --foreground   Run in foreground — serial console on stdio
  --all                 Start all stopped machines
  --add-package <pkg>   Extra package to install (repeatable)
  --add-user <u:p>      Create user with name:password
  --disable-admin       Disable the default admin account
  --port-base <port>    Starting port number (default: auto-allocated from 9100)
  --no-winbox           Exclude WinBox port mapping
  --no-api-ssl          Exclude API-SSL port mapping
  --vmnet-shared        vmnet-shared networking (macOS)
  --vmnet-bridge <if>   vmnet-bridge networking (macOS), e.g. en0
  --dry-run             Print what would run without starting`);
			break;
		case "stop":
			console.log(`quickchr stop [<name>] [--all]

  <name>      Stop a specific running instance.
              Omit to get an interactive selector.
  --all       Stop all running instances.`);
			break;
		case "status":
			console.log(`quickchr status [<name>]

  <name>      Show detailed status for a specific instance.
              Omit to get an interactive selector.`);
			break;
		case "doctor":
			console.log(`quickchr doctor

Check system prerequisites: QEMU binaries, firmware, acceleration,
sshpass (for package upload), data directories, and cached images.`);
			break;
		default:
			console.log(`No detailed help for '${command}'.`);
	}
}

main();

