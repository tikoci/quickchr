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
			case "add":
				await cmdAdd(args.slice(1));
				break;
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
			case "console":
				await cmdConsole(args.slice(1));
				break;
			case "exec":
				await cmdExec(args.slice(1));
				break;
			case "qga":
				await cmdQga(args.slice(1));
				break;
			case "license":
				await cmdLicense(args.slice(1));
				break;
			case "disk":
				await cmdDisk(args.slice(1));
				break;
			case "setup":
				await cmdSetup();
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
				// No command — interactive setup on TTY, help otherwise
				if (isNoPrompt()) {
					printHelp();
				} else {
					await cmdSetup();
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

/** Print a machine table with a tip line — used when a command gets no name argument. */
function printMachineListWithTip(
	tipCommand: string,
	machines: Array<{ name: string; status: string; version: string; arch: string }>,
	hintFn?: (m: { name: string; status: string }) => string | undefined,
	allowAll = true,
) {
	if (machines.length === 0) {
		console.log("No matching instances.");
		return;
	}
	const rows = machines.map((m) => ({
		name: m.name,
		status: m.status,
		version: m.version,
		arch: m.arch,
		hint: hintFn?.(m),
	}));
	const [wName, wStatus, wVersion, wArch] = [
		Math.max(4, ...rows.map((r) => r.name.length)),
		Math.max(6, ...rows.map((r) => r.status.length)),
		Math.max(7, ...rows.map((r) => r.version.length)),
		Math.max(4, ...rows.map((r) => r.arch.length)),
	];
	const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));
	const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
	console.log(dim(`  ${pad("NAME", wName)}  ${pad("STATUS", wStatus)}  ${pad("VERSION", wVersion)}  ${pad("ARCH", wArch)}`));
	for (const r of rows) {
		const extra = r.hint ? `  ${dim(r.hint)}` : "";
		console.log(`  ${pad(r.name, wName)}  ${pad(r.status, wStatus)}  ${pad(r.version, wVersion)}  ${pad(r.arch, wArch)}${extra}`);
	}
	console.log();
	console.log(allowAll
		? `${dim("tip:")}  quickchr ${tipCommand} <name>  or  quickchr ${tipCommand} --all`
		: `${dim("tip:")}  quickchr ${tipCommand} <name>`);
}

async function cmdAdd(argv: string[]) {
	const { flags, positional } = parseFlags(argv);
	const { QuickCHR } = await import("../lib/quickchr.ts");
	const { bold, formatPorts, dim } = await import("./format.ts");

	const opts: StartOptions = {
		version: flag(flags, "version"),
		channel: flag(flags, "channel") as Channel | undefined,
		arch: flag(flags, "arch") as Arch | undefined,
		name: flag(flags, "name") ?? positional[0],
		cpu: flag(flags, "cpu") ? Number(flag(flags, "cpu")) : undefined,
		mem: flag(flags, "mem") ? Number(flag(flags, "mem")) : undefined,
		packages: csvList(flagList(flags, "add-package")),
		installAllPackages: flagBool(flags, "install-all-packages"),
		portBase: flag(flags, "port-base") ? Number(flag(flags, "port-base")) : undefined,
		excludePorts: [
			...(flags.winbox === false ? ["winbox" as ServiceName] : []),
			...(flags["api-ssl"] === false ? ["api-ssl" as ServiceName] : []),
		],
		network: flag(flags, "vmnet-shared") !== undefined ? "vmnet-shared"
			: flag(flags, "vmnet-bridge") ? { type: "vmnet-bridge" as const, iface: flag(flags, "vmnet-bridge") as string }
			: undefined,
		bootSize: flag(flags, "boot-size"),
		extraDisks: flagList(flags, "add-disk").length > 0 ? flagList(flags, "add-disk") : undefined,
	};

	const deviceModeValue = flag(flags, "device-mode");
	const deviceModeEnable = csvList(flagList(flags, "device-mode-enable"));
	const deviceModeDisable = csvList(flagList(flags, "device-mode-disable"));
	if (deviceModeValue !== undefined || deviceModeEnable.length > 0 || deviceModeDisable.length > 0) {
		opts.deviceMode = {
			mode: deviceModeValue ?? "auto",
			enable: deviceModeEnable.length > 0 ? deviceModeEnable : undefined,
			disable: deviceModeDisable.length > 0 ? deviceModeDisable : undefined,
		};
	}

	const userStr = flag(flags, "add-user");
	if (userStr) {
		const [uname = "", password] = userStr.split(":");
		opts.user = { name: uname, password: password ?? "" };
	}
	opts.disableAdmin = flagBool(flags, "disable-admin");

	// --secure-login / --no-secure-login
	if (flags["secure-login"] === false) {
		opts.secureLogin = false;
	} else if (flagBool(flags, "secure-login")) {
		opts.secureLogin = true;
	}

	const state = await QuickCHR.add(opts);

	const { toChrPorts } = await import("../lib/network.ts");
	const ports = toChrPorts(state.ports);
	console.log(`${bold(state.name)} created`);
	console.log(`  Version: ${state.version} (${state.arch})`);
	console.log(`  CPU/Mem: ${state.cpu} vCPU${state.cpu > 1 ? "s" : ""}, ${state.mem} MB`);
	console.log(`  Ports:   ${formatPorts(state.ports)}`);
	console.log(`  REST:    http://127.0.0.1:${ports.http}  ${dim("(after start)")}`);
	console.log(`  Dir:     ${dim(state.machineDir)}`);
	if (state.packages.length > 0) console.log(`  Packages: ${state.packages.join(", ")}  ${dim("(applied on first start)")}`);
	if (state.deviceMode) console.log(`  Device-mode: ${state.deviceMode.mode ?? "auto"}  ${dim("(applied on first start)")}`);
	console.log();
	console.log(`${dim("tip:")}  quickchr start ${state.name}`);
}

async function cmdConsole(argv: string[]) {
	const { positional } = parseFlags(argv);
	const name = positional[0];

	if (!name) {
		console.error("Usage: quickchr console <name>\n  Attach to the serial console of a running machine.");
		process.exit(1);
	}

	if (!process.stdin.isTTY) {
		console.error("quickchr console requires an interactive terminal.");
		process.exit(1);
	}

	const { QuickCHR } = await import("../lib/quickchr.ts");
	const machine = QuickCHR.get(name);
	if (!machine) {
		console.error(`Machine "${name}" not found.`);
		process.exit(1);
	}
	if (machine.state.status !== "running") {
		console.error(`Machine "${name}" is not running. Start it first: quickchr start ${name}`);
		process.exit(1);
	}
	await attachSerial(name, machine.state.machineDir);
}

async function cmdExec(argv: string[]) {
	const { flags, positional } = parseFlags(argv);
	const name = positional[0];
	const commandParts = positional.slice(1);

	if (!name || commandParts.length === 0) {
		const running = await getRunningMachines();
		if (running.length > 0) {
			printMachineListWithTip("exec", running, undefined, false);
			console.log(`\nUsage: quickchr exec <name> <command...>`);
		} else {
			console.error("Usage: quickchr exec <name> <command...>\n  Run a RouterOS CLI command on a running instance.");
		}
		process.exit(1);
	}

	const { QuickCHR } = await import("../lib/quickchr.ts");
	const machine = QuickCHR.get(name);
	if (!machine) {
		console.error(`Machine "${name}" not found.`);
		process.exit(1);
	}
	if (machine.state.status !== "running") {
		console.error(`Machine "${name}" is not running. Start it first: quickchr start ${name}`);
		process.exit(1);
	}

	const command = commandParts.join(" ");
	const via = flag(flags, "via") as "auto" | "rest" | undefined;
	const user = flag(flags, "user");
	const password = flag(flags, "password");
	const timeout = flag(flags, "timeout") ? Number(flag(flags, "timeout")) * 1000 : undefined;

	const result = await machine.exec(command, { via, user, password, timeout });
	if (result.output) {
		process.stdout.write(result.output);
		// Ensure trailing newline for clean CLI output
		if (!result.output.endsWith("\n")) {
			process.stdout.write("\n");
		}
	}
}

async function cmdQga(argv: string[]) {
	const { flags, positional } = parseFlags(argv);
	const name = positional[0];
	const operation = positional[1];

	const USAGE = `Usage: quickchr qga <name> <operation> [options]

Operations:
  ping                 Liveness check — confirm QGA is responding
  info                 List supported QGA commands reported by the agent
  osinfo               OS version, kernel, architecture
  hostname             RouterOS identity name
  time                 System time (nanoseconds since epoch)
  timezone             Timezone offset from UTC
  networks             Network interfaces with IP assignments
  fsfreeze-status      Filesystem freeze state (thawed|frozen)
  fsfreeze-freeze      Freeze filesystem for consistent snapshot
  fsfreeze-thaw        Thaw a frozen filesystem
  shutdown             Graceful VM shutdown (destructive)
  file-write           Write a file to RouterOS root (--path <name> --data <content>)
  file-read            Read a RouterOS root file (--path <name>)
  exec                 Run RouterOS script via QGA (--script <cmd>)

QGA is x86_64 only — ARM64 CHR support is planned pending MikroTik firmware.

Options:
  --timeout <seconds>  Operation timeout (default: 10)`;

	if (!name || !operation) {
		const running = await getRunningMachines();
		if (running.length > 0) {
			printMachineListWithTip("qga", running.filter((m) => m.arch !== "arm64"), undefined, false);
		}
		console.log(`\n${USAGE}`);
		process.exit(1);
	}

	const { QuickCHR } = await import("../lib/quickchr.ts");
	const machine = QuickCHR.get(name);
	if (!machine) {
		console.error(`Machine "${name}" not found.`);
		process.exit(1);
	}
	if (machine.state.status !== "running") {
		console.error(`Machine "${name}" is not running. Start it first: quickchr start ${name}`);
		process.exit(1);
	}

	const timeoutMs = flag(flags, "timeout") ? Number(flag(flags, "timeout")) * 1000 : 10_000;
	const {
		qgaPing,
		qgaInfo,
		qgaGetOsInfo,
		qgaGetHostName,
		qgaGetTime,
		qgaGetTimezone,
		qgaGetNetworkInterfaces,
		qgaFsFreezeStatus,
		qgaFsFreezeFreeze,
		qgaFsFreezeThaw,
		qgaShutdown,
		qgaFileWrite,
		qgaFileRead,
		qgaExec,
	} = await import("../lib/qga.ts");
	const { join } = await import("node:path");
	const socketPath = join(machine.state.machineDir, "qga.sock");

	if (machine.state.arch === "arm64") {
		console.error(`Error [QGA_UNSUPPORTED]: QEMU Guest Agent is not yet functional on ARM64 CHR.`);
		console.error(`  ARM64 QGA support is planned pending MikroTik firmware — x86_64 machines work today.`);
		process.exit(1);
	}

	switch (operation) {
		case "ping": {
			await qgaPing(socketPath, timeoutMs);
			console.log("pong — QGA is responding");
			break;
		}
		case "info": {
			const commands = await qgaInfo(socketPath, timeoutMs);
			const enabled = commands.filter((c) => c.enabled).map((c) => c.name).sort();
			const disabled = commands.filter((c) => !c.enabled).map((c) => c.name).sort();
			console.log(`Supported commands (${enabled.length} enabled):`);
			for (const cmd of enabled) console.log(`  ${cmd}`);
			if (disabled.length > 0) {
				console.log(`Disabled commands (${disabled.length}):`);
				for (const cmd of disabled) console.log(`  ${cmd}`);
			}
			break;
		}
		case "osinfo": {
			const info = await qgaGetOsInfo(socketPath, timeoutMs);
			console.log(`name:          ${info.name}`);
			console.log(`pretty-name:   ${info.prettyName}`);
			console.log(`id:            ${info.id}`);
			console.log(`kernel:        ${info.kernelRelease}`);
			console.log(`machine:       ${info.machine}`);
			break;
		}
		case "hostname": {
			const hostname = await qgaGetHostName(socketPath, timeoutMs);
			console.log(hostname);
			break;
		}
		case "time": {
			const ns = await qgaGetTime(socketPath, timeoutMs);
			const ms = Math.floor(ns / 1_000_000);
			const date = new Date(ms);
			console.log(`${ns} ns  (${date.toISOString()})`);
			break;
		}
		case "timezone": {
			const tz = await qgaGetTimezone(socketPath, timeoutMs);
			const sign = tz.offset >= 0 ? "+" : "-";
			const abs = Math.abs(tz.offset);
			const h = String(Math.floor(abs / 3600)).padStart(2, "0");
			const m = String(Math.floor((abs % 3600) / 60)).padStart(2, "0");
			const display = tz.zone ? `${tz.zone} (UTC${sign}${h}:${m})` : `UTC${sign}${h}:${m}`;
			console.log(display);
			break;
		}
		case "networks": {
			const ifaces = await qgaGetNetworkInterfaces(socketPath, timeoutMs);
			for (const iface of ifaces) {
				const mac = iface.mac ? `  mac: ${iface.mac}` : "";
				console.log(`${iface.name}${mac}`);
				for (const ip of iface.ipAddresses) {
					console.log(`  ${ip.type}  ${ip.address}/${ip.prefix}`);
				}
			}
			break;
		}
		case "fsfreeze-status": {
			const status = await qgaFsFreezeStatus(socketPath, timeoutMs);
			console.log(status);
			break;
		}
		case "fsfreeze-freeze": {
			const count = await qgaFsFreezeFreeze(socketPath, timeoutMs);
			console.log(`${count} filesystem(s) frozen`);
			break;
		}
		case "fsfreeze-thaw": {
			const count = await qgaFsFreezeThaw(socketPath, timeoutMs);
			console.log(`${count} filesystem(s) thawed`);
			break;
		}
		case "shutdown": {
			console.log(`Sending shutdown to "${name}"...`);
			await qgaShutdown(socketPath, timeoutMs);
			console.log(`Shutdown sent — machine will terminate shortly.`);
			break;
		}
		case "file-write": {
			const path = flag(flags, "path");
			const data = flag(flags, "data");
			if (!path || data === undefined) {
				console.error(`Usage: quickchr qga ${name} file-write --path <filename> --data <content>`);
				process.exit(1);
			}
			await qgaFileWrite(socketPath, path, data, timeoutMs);
			console.log(`Written: ${path}`);
			break;
		}
		case "file-read": {
			const path = flag(flags, "path");
			if (!path) {
				console.error(`Usage: quickchr qga ${name} file-read --path <filename>`);
				process.exit(1);
			}
			const content = await qgaFileRead(socketPath, path, timeoutMs);
			process.stdout.write(content);
			if (content && !content.endsWith("\n")) process.stdout.write("\n");
			break;
		}
		case "exec": {
			const script = flag(flags, "script");
			if (!script) {
				console.error(`Usage: quickchr qga ${name} exec --script <routeros-command>`);
				process.exit(1);
			}
			const result = await qgaExec(socketPath, script, timeoutMs);
			if (result.stdout) {
				process.stdout.write(result.stdout);
				if (!result.stdout.endsWith("\n")) process.stdout.write("\n");
			}
			if (result.stderr) process.stderr.write(result.stderr);
			if (result.exitcode !== 0) process.exit(result.exitcode);
			break;
		}
		default:
			console.error(`Unknown QGA operation: ${operation}\n\n${USAGE}`);
			process.exit(1);
	}
}

/** Get running machines for list hints. */
async function getRunningMachines() {
	const { QuickCHR } = await import("../lib/quickchr.ts");
	return QuickCHR.list().filter((m) => m.status === "running");
}

async function cmdSetup() {
	const { QuickCHR } = await import("../lib/quickchr.ts");
	const machines = QuickCHR.list();
	const { runWizard } = await import("./wizard.ts");

	// Zero machines: jump straight into create flow
	if (machines.length === 0) {
		return runWizard();
	}

	const clack = await import("@clack/prompts");
	clack.intro("quickchr setup");

	const choice = await clack.select({
		message: "What would you like to do?",
		options: [
			{ value: "create", label: "Create a new machine" },
			{ value: "manage", label: "Manage machines (start / stop / remove)" },
			{ value: "networks", label: "Configure networks" },
		],
	});
	if (clack.isCancel(choice)) { clack.cancel("Cancelled."); return; }

	if (choice === "create") {
		clack.outro("");
		return runWizard();
	}

	if (choice === "networks") {
		clack.log.warn("Network configuration is not yet implemented. Use --vmnet-shared / --vmnet-bridge flags with 'add'.");
		clack.outro("");
		return;
	}

	// Manage flow
	const { statusIcon, bold } = await import("./format.ts");
	const selected = await clack.select({
		message: "Select machine:",
		options: machines.map((m) => ({
			value: m.name,
			label: m.name,
			hint: `${statusIcon(m.status)} ${m.version} (${m.arch})`,
		})),
	});
	if (clack.isCancel(selected)) { clack.cancel("Cancelled."); return; }

	const target = machines.find((m) => m.name === selected);
	if (!target) return;

	const { statusIcon: si } = await import("./format.ts");
	const actions = target.status === "running"
		? [
			{ value: "stop", label: "Stop" },
			{ value: "remove", label: "Remove  (stop first, then delete)" },
		]
		: [
			{ value: "start", label: "Start" },
			{ value: "remove", label: "Remove" },
		];

	const action = await clack.select({
		message: `${bold(target.name)} — ${target.status}. Choose action:`,
		options: actions,
	});
	if (clack.isCancel(action)) { clack.cancel("Cancelled."); return; }

	const { link } = await import("./format.ts");
	const instance = QuickCHR.get(target.name);
	if (!instance) { clack.log.error("Machine not found."); return; }

	if (action === "start") {
		const spinner = clack.spinner();
		spinner.start(`Starting ${target.name}...`);
		const started = await QuickCHR.start({ name: target.name, background: true });
		spinner.stop(`${si("running")} ${bold(started.name)} started`);
		clack.note(`REST: ${link(started.restUrl)}\nSSH:  ssh admin@127.0.0.1 -p ${started.sshPort}`, "Instance details");
	} else if (action === "stop") {
		await instance.stop();
		clack.log.success(`${bold(target.name)} stopped`);
	} else if (action === "remove") {
		const confirmed = await clack.confirm({ message: `Remove ${bold(target.name)} and its disk? This cannot be undone.`, initialValue: false });
		if (!clack.isCancel(confirmed) && confirmed) {
			await instance.remove();
			clack.log.success(`${bold(target.name)} removed`);
		} else {
			clack.cancel("Cancelled.");
		}
	}

	clack.outro("Done!");
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

	// No target → list stopped machines with tip
	if (!hasExplicitTarget) {
		const { QuickCHR } = await import("../lib/quickchr.ts");
		const stopped = QuickCHR.list().filter((m) => m.status !== "running");
		printMachineListWithTip("start", stopped);
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
		bootSize: flag(flags, "boot-size"),
		extraDisks: flagList(flags, "add-disk").length > 0 ? flagList(flags, "add-disk") : undefined,
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
	const licenseAccount = flag(flags, "license-account") ?? process.env.MIKROTIK_WEB_ACCOUNT;
	const licensePassword = flag(flags, "license-password") ?? process.env.MIKROTIK_WEB_PASSWORD;
	if (licenseLevel || licenseAccount) {
		if (!licenseAccount || !licensePassword) {
			console.error("Error: --license-level requires --license-account and --license-password (or MIKROTIK_WEB_ACCOUNT/MIKROTIK_WEB_PASSWORD env vars).");
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

	// --secure-login / --no-secure-login
	if (flags["secure-login"] === false) {
		opts.secureLogin = false;
	} else if (flagBool(flags, "secure-login")) {
		opts.secureLogin = true;
	}

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
		printMachineListWithTip("stop", running);
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

	const name = argv[0];

	if (!name) {
		await cmdList();
		return;
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
		printMachineListWithTip("remove", machines, (m) => m.status === "running" ? "(stop first)" : undefined);
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

	// --all: clean every machine
	if (flagBool(flags, "all")) {
		const machines = QuickCHR.list();
		if (machines.length === 0) {
			console.log("No instances.");
			return;
		}
		for (const m of machines) {
			const instance = QuickCHR.get(m.name);
			if (instance) {
				await instance.clean();
				console.log(`${statusIcon("stopped")} ${bold(m.name)} reset to fresh image.`);
			}
		}
		return;
	}

	const name = positional[0] ?? flag(flags, "name");

	if (!name) {
		const machines = QuickCHR.list();
		printMachineListWithTip("clean", machines);
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

	const name = positional[0] ?? flag(flags, "name");

	if (!name) {
		console.error("Usage: quickchr license <name> [--level=p1|p10|unlimited]");
		process.exit(1);
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
	let account = flag(flags, "account") ?? process.env.MIKROTIK_WEB_ACCOUNT;
	let password = flag(flags, "password") ?? process.env.MIKROTIK_WEB_PASSWORD;
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
			console.error("No credentials found. Set MIKROTIK_WEB_ACCOUNT and MIKROTIK_WEB_PASSWORD, or pass --account/--password.");
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

async function cmdDisk(argv: string[]) {
	const { positional } = parseFlags(argv);
	const name = positional[0];

	if (!name) {
		const { QuickCHR } = await import("../lib/quickchr.ts");
		const machines = QuickCHR.list();
		printMachineListWithTip("disk", machines, undefined, false);
		return;
	}

	const { QuickCHR } = await import("../lib/quickchr.ts");
	const { bold, dim } = await import("./format.ts");
	const { getDiskInfo } = await import("../lib/disk.ts");
	const { join } = await import("node:path");
	const { existsSync } = await import("node:fs");
	const { findQemuImg } = await import("../lib/platform.ts");

	const machine = QuickCHR.get(name);
	if (!machine) {
		console.error(`Machine "${name}" not found.`);
		process.exit(1);
	}

	const state = machine.state;
	const qemuImg = findQemuImg();

	const formatSize = (bytes: number) => {
		if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
		if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
		return `${(bytes / 1024).toFixed(1)} KB`;
	};

	console.log(bold(`Disks for ${name}\n`));

	// Boot disk
	const bootPath = state.bootDiskFormat === "qcow2"
		? join(state.machineDir, "boot.qcow2")
		: join(state.machineDir, "disk.img");
	const bootFormat = state.bootDiskFormat ?? "raw";

	if (qemuImg && existsSync(bootPath)) {
		try {
			const info = await getDiskInfo(bootPath);
			console.log(`  boot    ${bootFormat.padEnd(6)}  virtual: ${formatSize(info.virtualSize).padEnd(10)}  actual: ${formatSize(info.actualSize)}`);
		} catch {
			console.log(`  boot    ${bootFormat.padEnd(6)}  ${bootPath}`);
		}
	} else {
		console.log(`  boot    ${bootFormat.padEnd(6)}  ${bootPath}`);
	}

	// Extra disks
	if (state.extraDisks && state.extraDisks.length > 0) {
		for (let i = 0; i < state.extraDisks.length; i++) {
			const diskPath = join(state.machineDir, `disk${i + 1}.qcow2`);
			const label = `disk${i + 1}`;
			if (qemuImg && existsSync(diskPath)) {
				try {
					const info = await getDiskInfo(diskPath);
					console.log(`  ${label.padEnd(6)}  qcow2   virtual: ${formatSize(info.virtualSize).padEnd(10)}  actual: ${formatSize(info.actualSize)}`);
				} catch {
					console.log(`  ${label.padEnd(6)}  qcow2   ${diskPath}`);
				}
			} else {
				console.log(`  ${label.padEnd(6)}  qcow2   ${dim("(not created)")}`);
			}
		}
	}

	if (!qemuImg) {
		console.log(dim(`\n  (install qemu-img for disk size details)`));
	}
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
  setup                   Interactive setup wizard (TTY only)
  add [options]           Create a new CHR machine (without starting)
  start [<name>|options]  Start or restart a CHR instance
  stop [<name>|--all]     Stop instance(s) — print list if no name
  list                    List all instances (plain table)
  status [<name>]         Detailed status — list all if no name
  console <name>          Attach to serial console of a running instance
  exec <name> <command>   Run a RouterOS CLI command on a running instance
  remove [<name>|--all]   Remove instance(s) and disk
  clean [<name>|--all]    Reset instance disk to fresh image
  license <name>          Apply/renew CHR trial license
  disk <name>             Show disk details for an instance
  doctor                  Check prerequisites
  version                 Show version info
  help [command]          Show help

Environment:
  MIKROTIK_WEB_ACCOUNT    MikroTik.com account email (for license)
  MIKROTIK_WEB_PASSWORD   MikroTik.com password (for license)

Run 'quickchr help <command>' for command-specific help.`);
}

function printCommandHelp(command: string) {
	switch (command) {
		case "add":
			console.log(`quickchr add [options]

Create a new CHR machine without starting it.
Use 'quickchr start <name>' to boot it afterwards.

Options:
  --name <name>         Instance name (required)
  --version <ver>       RouterOS version (e.g., 7.22.1)
  --channel <ch>        Channel: stable, long-term, testing, development
  --arch <arch>         Architecture: arm64, x86 (default: host native)
  --cpu <n>             vCPU count (default: 1)
  --mem <mb>            RAM in MB (default: 512)
	--boot-size <size>    Resize boot disk (e.g., 512M, 2G) — requires qemu-img
	--add-disk <size>     Add an extra blank qcow2 disk (repeatable, requires qemu-img)
  --add-package <pkg>   Extra package to install on first boot (repeatable)
  --install-all-packages  Install all packages on first boot
  --add-user <u:p>      Create user on first boot (name:password)
  --disable-admin       Disable the default admin account on first boot
  --no-secure-login     Keep admin with no password (skip managed account)
  --port-base <port>    Starting port number (default: auto-allocated from 9100)
  --no-winbox           Exclude WinBox port mapping
  --no-api-ssl          Exclude API-SSL port mapping
  --device-mode <m>     Set device-mode on first boot: rose|advanced|basic|home|auto|skip
  --vmnet-shared        vmnet-shared networking (macOS)
  --vmnet-bridge <if>   vmnet-bridge networking (macOS), e.g. en0`);
			break;
		case "setup":
			console.log(`quickchr setup

Launch the interactive wizard (requires a TTY).
If machines already exist, shows a menu to manage them.`);
			break;
		case "console":
			console.log(`quickchr console <name>

Attach to the serial console of a running CHR instance.
Requires a TTY. Exit with Ctrl-A X (QEMU monitor quit).`);
			break;
		case "exec":
			console.log(`quickchr exec <name> <command...> [options]

Run a RouterOS CLI command on a running CHR instance.
Uses the REST /execute endpoint (no SSH needed).

  <name>              Name of a running CHR instance (required).
  <command...>        RouterOS CLI command to execute.

Options:
  --via <transport>   Transport: auto, rest (default: auto)
  --user <user>       Override username
  --password <pass>   Override password
  --timeout <secs>    Timeout in seconds (default: 30)

Examples:
  quickchr exec my-chr /system/resource/print
  quickchr exec my-chr ":put [:serialize to=json [/ip/address/print]]"
  quickchr exec my-chr "/log/info message=hello"`);
			break;
		case "start":
			console.log(`quickchr start [<name>] [options]

  <name>              Restart an existing stopped machine by name.
                      Omit to see a list of stopped machines.

Creation flags below apply when using 'start' to create a new machine in one step.
For a clearer create-then-boot flow, prefer 'quickchr add' followed by 'quickchr start <name>'.

Options:
  --all                 Start all stopped machines
  --bg / --background   Run in background (default)
  --fg / --foreground   Run in foreground — serial console on stdio
  --version <ver>       RouterOS version (e.g., 7.22.1)
  --channel <ch>        Channel: stable, long-term, testing, development
  --arch <arch>         Architecture: arm64, x86 (default: host native)
  --name <name>         Instance name
  --cpu <n>             vCPU count (default: 1)
  --mem <mb>            RAM in MB (default: 512)
	--boot-size <size>    Resize boot disk (e.g., 512M, 2G) — requires qemu-img
	--add-disk <size>     Add an extra blank qcow2 disk (repeatable, requires qemu-img)
  --add-package <pkg>   Extra package to install (repeatable)
  --add-user <u:p>      Create user with name:password
  --disable-admin       Disable the default admin account
  --no-secure-login     Keep admin with no password (skip managed account)
  --port-base <port>    Starting port number (default: auto-allocated from 9100)
  --no-winbox           Exclude WinBox port mapping
  --no-api-ssl          Exclude API-SSL port mapping
  --vmnet-shared        vmnet-shared networking (macOS)
  --vmnet-bridge <if>   vmnet-bridge networking (macOS), e.g. en0
  --install-all-packages  Install all packages from all_packages.zip
  --license-level <l>   Apply trial license: p1 (1 Gbps), p10 (10 Gbps), unlimited
  --license-account <a> MikroTik account email (or use MIKROTIK_WEB_ACCOUNT env var)
  --license-password <p> MikroTik password (or use MIKROTIK_WEB_PASSWORD env var)
  --device-mode <m>     Configure device-mode: rose|advanced|basic|home|auto|skip
  --device-mode-enable <f>  Set one or more device-mode flags to yes
  --device-mode-disable <f> Set one or more device-mode flags to no
  --no-device-mode      Skip device-mode provisioning entirely
  --dry-run             Print what would run without starting`);
			break;
		case "stop":
			console.log(`quickchr stop [<name>] [--all]

  <name>      Stop a specific running instance.
              Omit to see a list of running instances.
  --all       Stop all running instances.`);
			break;
		case "status":
			console.log(`quickchr status [<name>]

  <name>      Show detailed status for a specific instance.
              Omit to list all instances.`);
			break;
		case "doctor":
			console.log(`quickchr doctor

Check system prerequisites: QEMU binaries, firmware, acceleration,
sshpass (for package upload), qemu-img (for disk operations), data directories,
and cached images.`);
			break;
		case "disk":
			console.log(`quickchr disk <name>

Show disk details (format, virtual size, actual size) for an instance.

  <name>      Show disks for a specific instance.
	              Omit to list all instances.

Install qemu-img to include virtual/actual size details in the output.`);
			break;
		case "license":
			console.log(`quickchr license <name> [options]

Apply or renew a CHR trial license via MikroTik.com.
Free CHR runs at 1 Mbps — a trial license unlocks full speed.
No reboot required. Takes effect immediately.

  <name>              Name of a running CHR instance (required).

Options:
  --level <level>     License level: p1 (1 Gbps), p10 (10 Gbps), unlimited (default: p1)
  --account <email>   MikroTik.com account email
  --password <pass>   MikroTik.com password

Credential resolution order (highest priority first):
  1. --account / --password flags
  2. MIKROTIK_WEB_ACCOUNT / MIKROTIK_WEB_PASSWORD environment variables
  3. OS native secret store (macOS Keychain, Linux GNOME Keyring, Windows Credential Manager)
  4. ~/.config/quickchr/credentials.json (fallback)`);
			break;
		case "clean":
			console.log(`quickchr clean [<name>] [--all]

  <name>      Reset an instance's disk to a fresh image (removes all data).
              Omit to see a list of instances.
  --all       Clean all instances.`);
			break;
		case "remove":
			console.log(`quickchr remove [<name>] [--all]

  <name>      Remove an instance (stops if running, deletes disk and state).
              Omit to see a list of instances.
  --all       Remove all instances.`);
			break;
		default:
			console.log(`No detailed help for '${command}'.`);
	}
}

main();

