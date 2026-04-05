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
		const arg = argv[i]!;
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
				// No command — launch wizard if TTY, otherwise show help
				if (process.stdout.isTTY && process.stdin.isTTY) {
					const { runWizard } = await import("./wizard.ts");
					await runWizard();
				} else {
					printHelp();
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

async function cmdStart(argv: string[]) {
	const { flags, positional } = parseFlags(argv);
	const { QuickCHR } = await import("../lib/quickchr.ts");
	const { statusIcon, formatPorts, link, bold } = await import("./format.ts");

	const opts: StartOptions = {
		version: flag(flags, "version"),
		channel: flag(flags, "channel") as Channel | undefined,
		arch: flag(flags, "arch") as Arch | undefined,
		name: flag(flags, "name") ?? positional[0],
		cpu: flag(flags, "cpu") ? Number(flag(flags, "cpu")) : undefined,
		mem: flag(flags, "mem") ? Number(flag(flags, "mem")) : undefined,
		background: flags.bg !== undefined ? flagBool(flags, "bg") : flagBool(flags, "background"),
		packages: flagList(flags, "add-package"),
		portBase: flag(flags, "port-base") ? Number(flag(flags, "port-base")) : undefined,
		excludePorts: [
			...(flags.winbox === false ? ["winbox" as ServiceName] : []),
			...(flags["api-ssl"] === false ? ["api-ssl" as ServiceName] : []),
		],
		network: flag(flags, "vmnet-shared") !== undefined ? "vmnet-shared"
			: flag(flags, "vmnet-bridge") ? { type: "vmnet-bridge" as const, iface: flag(flags, "vmnet-bridge")! }
			: undefined,
		installDeps: flagBool(flags, "install-deps"),
		dryRun: flagBool(flags, "dry-run"),
	};

	// --add-user admin:pass
	const userStr = flag(flags, "add-user");
	if (userStr) {
		const [name, password] = userStr.split(":");
		opts.user = { name: name!, password: password ?? "" };
	}

	opts.disableAdmin = flagBool(flags, "disable-admin");

	// Handle --background default: true unless --no-background or foreground mode
	if (opts.background === false || flagBool(flags, "foreground") || flagBool(flags, "fg")) {
		opts.background = false;
	} else if (opts.background === undefined) {
		opts.background = true;
	}

	if (opts.dryRun) {
		console.log("Dry run — would start with options:", JSON.stringify(opts, null, 2));
		return;
	}

	const instance = await QuickCHR.start(opts);
	console.log(`${statusIcon("running")} ${bold(instance.name)} started`);
	console.log(`  Version: ${instance.state.version} (${instance.state.arch})`);
	console.log(`  Ports:   ${formatPorts(instance.state.ports)}`);
	console.log(`  REST:    ${link(instance.restUrl)}`);
	console.log(`  SSH:     ssh admin@127.0.0.1 -p ${instance.sshPort}`);
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

	const name = positional[0];
	if (!name) {
		console.error("Usage: quickchr stop <name|--all>");
		process.exit(1);
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

	const name = argv[0];
	if (!name) {
		// Show summary of all
		await cmdList();
		return;
	}

	const instance = QuickCHR.get(name);
	if (!instance) {
		console.error(`Machine "${name}" not found.`);
		process.exit(1);
	}

	const s = instance.state;
	console.log(`${statusIcon(s.status)} ${bold(s.name)}`);
	console.log(`  Version:    ${s.version} (${s.arch})`);
	console.log(`  CPU/Mem:    ${s.cpu} core${s.cpu > 1 ? "s" : ""}, ${s.mem} MB`);
	console.log(`  Network:    ${typeof s.network === "string" ? s.network : `vmnet-bridge (${s.network.iface})`}`);
	console.log(`  Ports:      ${formatPorts(s.ports)}`);
	console.log(`  Status:     ${s.status} ${s.pid ? `(PID ${s.pid})` : ""}`);
	console.log(`  Created:    ${s.createdAt}`);
	if (s.lastStartedAt) console.log(`  Last start: ${s.lastStartedAt}`);
	if (s.packages.length > 0) console.log(`  Packages:   ${s.packages.join(", ")}`);
	console.log(`  Dir:        ${dim(s.machineDir)}`);
	if (s.status === "running") {
		console.log(`  REST:       ${link(`http://127.0.0.1:${instance.ports.http}`)}`);
		console.log(`  SSH:        ssh admin@127.0.0.1 -p ${instance.sshPort}`);
	}
}

async function cmdRemove(argv: string[]) {
	const { QuickCHR } = await import("../lib/quickchr.ts");
	const { bold } = await import("./format.ts");

	const name = argv[0];
	if (!name) {
		console.error("Usage: quickchr remove <name>");
		process.exit(1);
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
	const { QuickCHR } = await import("../lib/quickchr.ts");
	const { bold } = await import("./format.ts");

	const name = argv[0];
	if (!name) {
		console.error("Usage: quickchr clean <name>");
		process.exit(1);
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
  start [options]     Start a new or existing CHR instance
  stop <name|--all>   Stop instance(s)
  list                List all instances
  status [name]       Detailed status of instance
  remove <name>       Remove instance and its disk
  clean <name>        Reset instance disk to fresh image
  doctor              Check prerequisites
  version             Show version info
  help [command]      Show help

Run 'quickchr help <command>' for command-specific help.`);
}

function printCommandHelp(command: string) {
	switch (command) {
		case "start":
			console.log(`quickchr start [options]

Options:
  --version <ver>       RouterOS version (e.g., 7.22.1)
  --channel <ch>        Channel: stable, long-term, testing, development
  --arch <arch>         Architecture: arm64, x86 (default: host native)
  --name <name>         Instance name (default: auto-generated)
  --cpu <n>             CPU cores (default: 1)
  --mem <mb>            Memory in MB (default: 512)
  --background, --bg    Run in background (default)
  --foreground, --fg    Run in foreground (serial on stdio)
  --add-package <pkg>   Add extra package (repeatable)
  --add-user <u:p>      Create user with name:password
  --disable-admin       Disable the admin user
  --port-base <port>    Starting port (default: auto-allocated)
  --no-winbox           Exclude WinBox port
  --no-api-ssl          Exclude API-SSL port
  --vmnet-shared        Use vmnet-shared networking (macOS)
  --vmnet-bridge <if>   Use vmnet-bridge networking (macOS)
  --dry-run             Show what would be done without doing it`);
			break;
		case "stop":
			console.log(`quickchr stop <name|--all>

Stop a running instance by name, or --all to stop everything.`);
			break;
		case "doctor":
			console.log(`quickchr doctor

Check system prerequisites: QEMU binaries, firmware, acceleration,
data directories, and cached images.`);
			break;
		default:
			console.log(`No detailed help for '${command}'.`);
	}
}

main();
