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

function csvList(values: string[]): string[] {
	return [...new Set(values.flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean))];
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
			case "license":
				await cmdLicense(args.slice(1));
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
function printForegroundTips(hasProvisioning = false) {
	const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
	const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
	const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
	console.log();
	if (hasProvisioning) {
		console.log(bold("  Foreground mode — serial console will attach after provisioning"));
	} else {
		console.log(bold("  Foreground mode — QEMU serial console"));
	}
	console.log(`  ${cyan("Ctrl-A X")}  ${dim("exit QEMU and return to shell")}`);
	console.log(`  ${cyan("Ctrl-A C")}  ${dim("toggle QEMU monitor (type 'quit' to force-stop)")}`);
	console.log(`  ${cyan("Ctrl-A H")}  ${dim("list all QEMU serial shortcuts")}`);
	console.log(`  ${cyan("Ctrl-A S")}  ${dim("send break signal to serial port")}`);
	console.log();
	if (!hasProvisioning) {
		console.log(dim("  (screen clears when QEMU initializes)"));
		console.log();
	}
}

/** Attach stdin/stdout to a running background machine — replicates QEMU's Ctrl-A mux.
 *  serial.sock  — RouterOS console  (default mode)
 *  monitor.sock — QEMU monitor      (Ctrl-A C to toggle, connected on demand) */
async function attachSerial(name: string, machineDir: string): Promise<void> {
	const { join } = await import("node:path");
	const { existsSync } = await import("node:fs");
	const { connect } = await import("node:net");
	const { bold, dim, cyan } = await import("./format.ts");

	const serialSock = join(machineDir, "serial.sock");
	const monitorSock = join(machineDir, "monitor.sock");

	if (!existsSync(serialSock)) {
		console.error(`\n  "${name}" has no serial socket — is it running in background mode?`);
		console.error(`  Expected: ${dim(serialSock)}`);
		process.exit(1);
	}

	if (!process.stdin.isTTY) {
		console.error("Serial attach requires an interactive terminal.");
		process.exit(1);
	}

	const hasMonitor = existsSync(monitorSock);

	console.log();
	console.log(bold(`  Attached to: ${name}`));
	console.log(`  ${cyan("Ctrl-A X")}  ${dim("detach and return to shell")}`);
	if (hasMonitor) {
		console.log(`  ${cyan("Ctrl-A C")}  ${dim("toggle QEMU monitor / serial console")}`);
	}
	console.log(`  ${cyan("Ctrl-A H")}  ${dim("show this help")}`);
	console.log();
	await Bun.sleep(600);

	const serialConn = connect({ path: serialSock });
	await new Promise<void>((resolve, reject) => {
		serialConn.once("connect", resolve);
		serialConn.once("error", reject);
	}).catch((err: Error) => {
		console.error(`\nFailed to connect to serial socket: ${err.message}`);
		process.exit(1);
	});

	// Send CR to nudge RouterOS into re-printing its current prompt.
	// Without this the socket delivers nothing until RouterOS receives input.
	// RouterOS treats a bare CR at "Login:" as an empty entry → re-displays "Login: ".
	serialConn.write(Buffer.from([0x0d]));

	process.stdin.setRawMode(true);
	process.stdin.resume();

	// Yield one event-loop tick BEFORE attaching the data listener.
	// Node.js/Bun streams discard data events that fire while no 'data' listener
	// is registered (flowing mode + no listener = data lost). This cleanly drops
	// any stale bytes buffered in stdin from a prior session that left raw mode
	// enabled — those are what caused the spurious "\01" login in RouterOS logs.
	await new Promise<void>((res) => setImmediate(res));

	let mode: "serial" | "monitor" = "serial";
	type Sock = ReturnType<typeof connect>;
	let monitorConn: Sock | null = null;
	let gotCtrlA = false;
	let done = false;
	let resolveExit!: () => void;
	const exitPromise = new Promise<void>((res) => { resolveExit = res; });

	const cleanup = () => {
		if (done) return;
		done = true;
		serialConn.destroy();
		if (monitorConn) monitorConn.destroy();
		try { process.stdin.setRawMode(false); } catch { /* ignore */ }
		process.stdin.pause();
		resolveExit();
	};

	// Always restore TTY on process exit — guards against SIGINT crash leaving raw mode
	const sigHandler = () => cleanup();
	process.once("SIGINT", sigHandler);
	process.once("SIGTERM", sigHandler);

	const printHelp = () => {
		process.stdout.write(`\r\n  ${cyan("Ctrl-A X")}  detach\r\n`);
		if (hasMonitor) process.stdout.write(`  ${cyan("Ctrl-A C")}  toggle monitor / serial console\r\n`);
		process.stdout.write(`  ${cyan("Ctrl-A H")}  this help\r\n`);
	};

	/** Connect to monitor socket on demand (first Ctrl-A C press). */
	const openMonitor = () => {
		if (monitorConn && !monitorConn.destroyed) {
			// Reconnect to existing live socket — just switch mode and nudge prompt
			mode = "monitor";
			process.stdout.write("\r\n\x1b[2m[QEMU monitor — Ctrl-A C to return to console]\x1b[0m\r\n");
			monitorConn.write("\n");
			return;
		}
		if (!existsSync(monitorSock)) {
			process.stdout.write("\r\n\x1b[2m[monitor socket not found]\x1b[0m\r\n");
			return;
		}
		const mc = connect({ path: monitorSock });
		monitorConn = mc;
		mc.on("data", (d: Buffer) => { if (mode === "monitor") process.stdout.write(d); });
		mc.on("error", () => {
			process.stdout.write("\r\n\x1b[2m[monitor unavailable]\x1b[0m\r\n");
			if (mode === "monitor") mode = "serial";
			monitorConn = null;
		});
		mc.on("close", () => {
			if (mode === "monitor") {
				// QEMU exited via 'quit' — serial socket will close next, triggering cleanup
				process.stdout.write("\r\n\x1b[2m[QEMU exited]\x1b[0m\r\n");
			}
			monitorConn = null;
		});
		mc.once("connect", () => {
			mode = "monitor";
			process.stdout.write("\r\n\x1b[2m[QEMU monitor — Ctrl-A C to return to console]\x1b[0m\r\n");
			// Don't nudge with "\n" here — the (qemu) banner arrives naturally on connect
		});
	};

	serialConn.on("data", (d: Buffer) => { if (mode === "serial") process.stdout.write(d); });
	serialConn.on("close", cleanup);
	serialConn.on("error", cleanup);

	const stdinHandler = (chunk: Buffer) => {
		if (done) return;
		for (let i = 0; i < chunk.length; i++) {
			const byte = chunk[i] as number;
			if (gotCtrlA) {
				gotCtrlA = false;
				// Match QEMU's mux_proc_byte exactly: unrecognised escapes are eaten (return 0).
				// QEMU never forwards [0x01, unknown] — only listed keys trigger actions.
				switch (byte) {
					case 0x78: case 0x58: // x/X — detach
						process.stdout.write("\r\n");
						cleanup();
						return;
					case 0x68: case 0x48: // h/H — help
						printHelp();
						break;
					case 0x63: case 0x43: // c/C — toggle monitor
						if (!hasMonitor) {
							process.stdout.write("\r\n\x1b[2m[monitor not available]\x1b[0m\r\n");
						} else if (mode === "serial") {
							openMonitor();
						} else {
							mode = "serial";
							process.stdout.write("\r\n\x1b[2m[serial console]\x1b[0m\r\n");
						}
						break;
					case 0x01: // Ctrl-A Ctrl-A — send literal 0x01 to active channel
						if (mode === "serial" && !serialConn.destroyed) serialConn.write(Buffer.from([0x01]));
						else if (monitorConn && !monitorConn.destroyed) monitorConn.write(Buffer.from([0x01]));
						break;
					// All other Ctrl-A + X: silently eat (matches QEMU mux_proc_byte behaviour)
					default:
						break;
				}
			} else if (byte === 0x01) {
				gotCtrlA = true;
			} else {
				const dest = mode === "serial" ? serialConn : monitorConn;
				if (dest && !dest.destroyed) dest.write(Buffer.from([byte]));
			}
		}
	};

	process.stdin.on("data", stdinHandler);
	await exitPromise;
	process.stdin.removeListener("data", stdinHandler);
	process.removeListener("SIGINT", sigHandler);
	process.removeListener("SIGTERM", sigHandler);
	if (!done) cleanup();

	console.log(`\n${bold(name)} console detached`);
	console.log(`  ${dim("Tip: resume session")}   quickchr start ${name} --fg`);
	console.log(`  ${dim("Tip: run background")}   quickchr start ${name}`);
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
	const { statusIcon, formatPorts, link, bold, dim } = await import("./format.ts");

	const opts: StartOptions = {
		version: flag(flags, "version"),
		channel: flag(flags, "channel") as Channel | undefined,
		arch: flag(flags, "arch") as Arch | undefined,
		name: flag(flags, "name") ?? positional[0],
		cpu: flag(flags, "cpu") ? Number(flag(flags, "cpu")) : undefined,
		mem: flag(flags, "mem") ? Number(flag(flags, "mem")) : undefined,
		packages: flagList(flags, "add-package"),
		installAllPackages: flagBool(flags, "install-all-packages"),
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

	const deviceModeValue = flag(flags, "device-mode");
	const deviceModeEnable = csvList(flagList(flags, "device-mode-enable"));
	const deviceModeDisable = csvList(flagList(flags, "device-mode-disable"));
	const noDeviceMode = flags["device-mode"] === false;
	if (noDeviceMode) {
		if (deviceModeEnable.length > 0 || deviceModeDisable.length > 0) {
			console.warn("Warning: --device-mode-enable/--device-mode-disable ignored because --no-device-mode was set.");
		}
	} else if (deviceModeValue !== undefined || deviceModeEnable.length > 0 || deviceModeDisable.length > 0) {
		opts.deviceMode = {
			mode: deviceModeValue ?? "auto",
			enable: deviceModeEnable.length > 0 ? deviceModeEnable : undefined,
			disable: deviceModeDisable.length > 0 ? deviceModeDisable : undefined,
		};
	}

	// --license-* flags (credentials from env if not supplied)
	const licenseLevel = flag(flags, "license-level");
	const licenseAccount = flag(flags, "license-account") ?? process.env.MIKROTIK_ACCOUNT;
	const licensePassword = flag(flags, "license-password") ?? process.env.MIKROTIK_PASSWORD;
	if (licenseLevel || licenseAccount) {
		if (!licenseAccount || !licensePassword) {
			console.error("Error: --license-level requires --license-account and --license-password (or MIKROTIK_ACCOUNT/MIKROTIK_PASSWORD env vars).");
			process.exit(1);
		}
		opts.license = {
			account: licenseAccount,
			password: licensePassword,
			level: licenseLevel as import("../lib/types.ts").LicenseLevel | undefined,
		};
	}

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

	// --fg on already-running machine: attach to its serial console
	if (!opts.background && opts.name) {
		const runningMachine = QuickCHR.list().find((m) => m.name === opts.name && m.status === "running");
		if (runningMachine) {
			await attachSerial(runningMachine.name, runningMachine.machineDir);
			return;
		}
	}

	if (!opts.background) {
		const wantsDeviceMode = !!opts.deviceMode && !["skip", "none", "off", "disabled"].includes((opts.deviceMode.mode ?? "auto").toLowerCase());
		const hasProv = !!(
			opts.installAllPackages ||
			(opts.packages?.length ?? 0) > 0 ||
			opts.user ||
			opts.disableAdmin ||
			opts.license ||
			wantsDeviceMode
		);
		printForegroundTips(hasProv);
		if (hasProv) {
			console.log("\x1b[2m  (CHR will boot and configure itself before the console appears)\x1b[0m");
			console.log();
		}
		// Brief pause so user can read tips before QEMU clears the screen
		await Bun.sleep(1500);
	}

	const instance = await QuickCHR.start(opts);

	if (!opts.background) {
		console.log(`\n${bold(instance.name)} session ended`);
		console.log(`  ${dim("Tip: resume session")}   quickchr start ${instance.name} --fg`);
		console.log(`  ${dim("Tip: run background")}   quickchr start ${instance.name}`);
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
		console.log(`  Serial:     ${dim(`${s.machineDir}/serial.sock`)}`);
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

async function cmdLicense(argv: string[]) {
	const { flags, positional } = parseFlags(argv);
	const { QuickCHR } = await import("../lib/quickchr.ts");
	const { bold } = await import("./format.ts");

	let name = positional[0] ?? flag(flags, "name");

	// Interactive selector if no name given
	if (!name) {
		const running = QuickCHR.list().filter((m) => m.status === "running");
		if (running.length === 0) {
			console.error("No running instances. Start a CHR first.");
			process.exit(1);
		}
		if (isNoPrompt()) {
			console.error("Usage: quickchr license <name> [--level=p1|p10|unlimited]");
			process.exit(1);
		}
		const clack = await import("@clack/prompts");
		clack.intro("quickchr license");
		const sel = await clack.select({
			message: "Select running instance:",
			options: running.map((m) => ({
				value: m.name,
				label: m.name,
				hint: `${m.version} (${m.arch})`,
			})),
		});
		if (clack.isCancel(sel)) { clack.cancel("Cancelled."); return; }
		clack.outro("");
		name = sel as string;
	}

	const instance = QuickCHR.get(name);
	if (!instance) {
		console.error(`Machine "${name}" not found.`);
		process.exit(1);
	}
	if (instance.state.status !== "running") {
		console.error(`Machine "${name}" is not running.`);
		process.exit(1);
	}

	// Resolve credentials: explicit flags → env vars → stored credentials
	let account = flag(flags, "account") ?? process.env.MIKROTIK_ACCOUNT;
	let password = flag(flags, "password") ?? process.env.MIKROTIK_PASSWORD;
	const level = (flag(flags, "level") as import("../lib/types.ts").LicenseLevel | undefined) ?? "p1";

	if (!account || !password) {
		const { getStoredCredentials, credentialStorageLabel } = await import("../lib/credentials.ts");
		const stored = await getStoredCredentials();
		if (stored) {
			account = stored.account;
			password = stored.password;
			console.log(`Using stored credentials for ${stored.account} (${credentialStorageLabel()})`);
		}
	}

	if (!account || !password) {
		if (isNoPrompt()) {
			console.error("No credentials found. Set MIKROTIK_ACCOUNT and MIKROTIK_PASSWORD, or pass --account/--password.");
			process.exit(1);
		}

		const clack = await import("@clack/prompts");
		clack.intro("quickchr license — credentials needed");
		const acct = await clack.text({ message: "MikroTik account (email):", validate: (v) => v.trim() ? undefined : "Required" });
		if (clack.isCancel(acct)) { clack.cancel("Cancelled."); return; }
		const pass = await clack.password({ message: "MikroTik password:" });
		if (clack.isCancel(pass)) { clack.cancel("Cancelled."); return; }
		account = acct;
		password = pass;

		const save = await clack.confirm({ message: "Save credentials to system secret store?", initialValue: true });
		if (!clack.isCancel(save) && save) {
			const { saveCredentials, credentialStorageLabel } = await import("../lib/credentials.ts");
			await saveCredentials(account, password);
			clack.log.success(`Saved to ${credentialStorageLabel()}`);
		}
		clack.outro("");
	}

	console.log(`Applying license level=${level} to ${bold(name)}...`);
	await instance.license({ account: account as string, password: password as string, level });
	console.log(`License applied: ${level}`);
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
  license [<name>]        Apply/renew CHR trial license — interactive selector if no name
  doctor                  Check prerequisites
  version                 Show version info
  help [command]          Show help

Environment:
  QUICKCHR_NO_PROMPT=1    Disable interactive selectors (for scripts/LLMs)
  MIKROTIK_ACCOUNT        MikroTik.com account email (for license)
  MIKROTIK_PASSWORD       MikroTik.com password (for license)

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
  --install-all-packages  Install all packages from all_packages.zip (mutually exclusive with --add-package)
  --license-level <l>   Apply trial license: p1 (1 Gbps), p10 (10 Gbps), unlimited
  --license-account <a> MikroTik account email (or use MIKROTIK_ACCOUNT env var)
  --license-password <p> MikroTik password (or use MIKROTIK_PASSWORD env var)
	--device-mode <m>     Configure device-mode: rose|advanced|basic|home|auto|skip
	                      CHR default is advanced. rose enables containers. auto resolves to rose.
	                      Not configured unless explicitly requested.
	--device-mode-enable <f>  Set one or more device-mode flags to yes (repeatable or comma-separated)
	--device-mode-disable <f> Set one or more device-mode flags to no (repeatable or comma-separated)
	--no-device-mode      Skip device-mode provisioning entirely
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
		case "license":
			console.log(`quickchr license [<name>] [options]

Apply or renew a CHR trial license via MikroTik.com.
Free CHR runs at 1 Mbps — a trial license unlocks full speed.
No reboot required. Takes effect immediately.

  <name>              Name of a running CHR instance.
                      Omit to get an interactive selector.

Options:
  --level <level>     License level: p1 (1 Gbps), p10 (10 Gbps), unlimited (default: p1)
  --account <email>   MikroTik.com account email
  --password <pass>   MikroTik.com password

Credential resolution order (highest priority first):
  1. --account / --password flags
  2. MIKROTIK_ACCOUNT / MIKROTIK_PASSWORD environment variables
  3. OS native secret store (macOS Keychain, Linux GNOME Keyring, Windows Credential Manager)
  4. ~/.config/quickchr/credentials.json (fallback)`);
			break;
		default:
			console.log(`No detailed help for '${command}'.`);
	}
}

main();

