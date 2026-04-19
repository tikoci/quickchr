#!/usr/bin/env bun
/**
 * quickchr CLI entry point — command router.
 */

import type { StartOptions, Arch, Channel, ServiceName, NetworkSpecifier } from "../lib/types.ts";
import { parseNetworkSpecifier } from "../lib/network.ts";
import {
	MIN_PROVISION_VERSION,
	PROVISIONING_BOOT_ONLY_SUMMARY,
	PROVISIONING_FEATURE_SUMMARY,
	provisioningSupportHint,
	provisioningSupportSummary,
} from "../lib/versions.ts";

const args = process.argv.slice(2);
const command = args[0];

/** Parse --flag=value and --flag value pairs from args. */
export function parseFlags(argv: string[]): { flags: Record<string, string | boolean | string[]>; positional: string[] } {
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

/** Build networks array from --add-network, --no-network, and legacy vmnet flags. */
function buildNetworks(flags: Record<string, string | boolean | string[]>): NetworkSpecifier[] | undefined {
	const specs: NetworkSpecifier[] = [];

	// Legacy flags first
	if (flag(flags, "vmnet-shared") !== undefined) {
		specs.push(parseNetworkSpecifier("shared"));
	}
	const bridgeIface = flag(flags, "vmnet-bridge");
	if (bridgeIface) {
		specs.push(parseNetworkSpecifier(`bridged:${bridgeIface}`));
	}

	// New --add-network flags
	for (const raw of flagList(flags, "add-network")) {
		specs.push(parseNetworkSpecifier(raw));
	}

	// --no-network → explicitly empty
	if (flags.network === false) {
		return [];
	}

	// Nothing specified → undefined (library decides defaults)
	if (specs.length === 0) return undefined;
	return specs;
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
			case "status":
				await cmdList(args.slice(1));
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
			case "get":
				await cmdGet(args.slice(1));
				break;
			case "license":
				console.error("Note: 'quickchr license' is deprecated. Use 'quickchr set <name> --license' instead.");
				await cmdLicense(args.slice(1));
				break;
			case "set":
				await cmdSet(args.slice(1));
				break;
			case "disk":
				await cmdDisk(args.slice(1));
				break;
			case "snapshot":
			case "snap":
				await cmdSnapshot(args.slice(1));
				break;
			case "setup":
				await cmdSetup();
				break;
			case "completions":
				await cmdCompletions(args.slice(1));
				break;
			case "doctor":
				await cmdDoctor();
				break;
			case "logs":
				await cmdLogs(args.slice(1));
				break;
			case "networks":
			case "net":
				await cmdNetworks(args.slice(1));
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
			if (err.code === "PROVISIONING_VERSION_UNSUPPORTED") {
				console.error(`  Why this happened: ${provisioningSupportSummary(MIN_PROVISION_VERSION)}`);
				console.error(`  ${PROVISIONING_BOOT_ONLY_SUMMARY}`);
				console.error("  Try this:");
				console.error(`    1) ${provisioningSupportHint(MIN_PROVISION_VERSION)}`);
				console.error("    2) For older 7.x, run boot-only (no provisioning flags).");
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
	const { bold, formatPorts, formatNetworks, dim } = await import("./format.ts");

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
		networks: buildNetworks(flags),
		bootDiskFormat: (flag(flags, "boot-disk-format") as StartOptions["bootDiskFormat"] | undefined) ?? "qcow2",
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
	console.log(`  Network: ${formatNetworks(state.networks ?? [])}`);
	console.log(`  Ports:   ${formatPorts(state.ports)}`);
	console.log(`  REST:    http://127.0.0.1:${ports.http}  ${dim("(after start)")}`);
	console.log(`  Dir:     ${dim(state.machineDir)}`);
	if (state.packages.length > 0) console.log(`  Packages: ${state.packages.join(", ")}  ${dim("(applied on first start)")}`);
	if (state.deviceMode) console.log(`  Device-mode: ${state.deviceMode.mode ?? "auto"}  ${dim("(applied on first start)")}`);
	console.log();
	console.log(`${dim("tip:")}  quickchr start ${state.name}`);
}

async function cmdConsole(argv: string[]) {
	const { machineNotFoundMessage } = await import("./format.ts");
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
		console.error(machineNotFoundMessage(name));
		process.exit(1);
	}
	if (machine.state.status !== "running") {
		console.error(`Machine "${name}" is not running. Start it first: quickchr start ${name}`);
		process.exit(1);
	}
	await attachSerial(name, machine.state.machineDir);
}

async function cmdExec(argv: string[]) {
	const { machineNotFoundMessage } = await import("./format.ts");
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
		console.error(machineNotFoundMessage(name));
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
	const { machineNotFoundMessage } = await import("./format.ts");
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

QGA requires KVM on x86_64 — may not respond on macOS (HVF) or Windows. ARM64 CHR support is pending MikroTik implementation.

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
		console.error(machineNotFoundMessage(name));
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
		console.error(`  ARM64 QGA support is pending MikroTik implementation — x86_64 machines work today.`);
		process.exit(1);
	}

	// x86 on non-KVM platforms (macOS HVF, Windows): warn but proceed
	if (process.platform !== "linux") {
		const platform = process.platform === "darwin" ? "macOS (HVF)" : "Windows";
		console.warn(`Warning [QGA_TIMEOUT]: QGA requires KVM — RouterOS guest agent only starts under KVM hypervisors.`);
		console.warn(`  On ${platform} it will likely time out. Attempting anyway.`);
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
	const { runWizard } = await import("./wizard.ts");

	// Zero machines: jump straight into create flow with first-run intro
	if (QuickCHR.list().length === 0) {
		return runWizard({ firstRun: true });
	}

	const clack = await import("@clack/prompts");
	clack.intro("quickchr setup");

	// Main menu loops until cancel or create — Back from machine select returns here
	while (true) {
		const choice = await clack.select({
			message: "What would you like to do?",
			options: [
				{ value: "create", label: "Create a new machine" },
				{ value: "manage", label: "Manage machines (start / stop / remove / disks / snapshots)" },
				{ value: "networks", label: "Configure networks" },
			],
		});
		if (clack.isCancel(choice)) { clack.cancel("Cancelled."); return; }

		if (choice === "create") {
			clack.outro("");
			return runWizard();
		}

		if (choice === "networks") {
		const { detectPlatform, detectPhysicalInterfaces } = await import("../lib/platform.ts");
		const platform = await detectPlatform();
		const isMacOS = platform.os === "darwin";
		const hasSocketVmnet = !!platform.socketVmnet;

		clack.log.info("Network types available on this system:");
		clack.log.step("  user — port forwarding (always available, default)");
		if (isMacOS && hasSocketVmnet) {
			clack.log.step("  shared — rootless shared network via socket_vmnet");
		}
		if (isMacOS) {
			clack.log.step("  bridged:<iface> — bridge to a physical interface");
			const ifaces = detectPhysicalInterfaces();
			if (ifaces.length > 0) {
				for (const i of ifaces) {
					clack.log.step(`    ${i.device} — ${i.name}${i.alias ? ` (${i.alias})` : ""}`);
				}
			}
		}
		clack.log.step("  socket::<name> — named L2 link between VMs");

		clack.log.info("Use these with: quickchr add --add-network <spec>");
		continue; // back to main menu
		}

	// Manage flow
	const { statusIcon, bold, link, machineNotFoundMessage, resolveDisplayCredentials, formatRestUrl, formatSshCommand } = await import("./format.ts");
	const diskSummary = (m: ReturnType<typeof QuickCHR.list>[number]): string => {
		const bootFormat = m.bootDiskFormat ?? (m.bootSize ? "qcow2" : "raw");
		const boot = m.bootSize ? `${m.bootSize} (${bootFormat})` : `default (~128M, ${bootFormat})`;
		const extraCount = m.extraDisks?.length ?? 0;
		return extraCount > 0 ? `${boot} + ${extraCount} extra` : boot;
	};

	let machineList = QuickCHR.list();

	// Machine selection loop — loops until user explicitly backs out
	while (true) {
		if (machineList.length === 0) {
			clack.log.info("No machines. Create one with 'quickchr add'.");
			break;
		}

		const selectedName = await clack.select({
			message: "Select machine:",
			options: [
				...machineList.map((m) => ({
					value: m.name,
					label: m.name,
					hint: `${statusIcon(m.status)} ${m.version} (${m.arch}) • disk: ${diskSummary(m)}`,
				})),
				{ value: "back", label: "← Back" },
			],
		});
		if (clack.isCancel(selectedName) || selectedName === "back") break;

		// Capture disk layout once — disk format doesn't change between actions
		const foundTarget = machineList.find((m) => m.name === selectedName);
		if (!foundTarget) continue; // shouldn't happen; re-show machine select
		let target = foundTarget;
		const bootFormat = target.bootDiskFormat ?? (target.bootSize ? "qcow2" : "raw");
		const canSnapshot = bootFormat === "qcow2";

		clack.note(
			`Boot disk: ${target.bootSize ? `${target.bootSize} (${bootFormat})` : `default (~128M, ${bootFormat})`}` +
			(canSnapshot ? "" : "  ⚠ no snapshots (raw disk)") + "\n" +
			`Extra disks: ${target.extraDisks && target.extraDisks.length > 0 ? target.extraDisks.join(", ") : "none"}`,
			`${target.name} disk layout`,
		);

		// Action loop — refreshes machine status on each iteration
		while (true) {
			machineList = QuickCHR.list();
			const refreshed = machineList.find((m) => m.name === selectedName);
			if (!refreshed) break; // machine removed externally
			target = refreshed;

			const isRunning = target.status === "running";

			const runningActions = [
				{ value: "stop", label: "Stop" },
				...(canSnapshot ? [{ value: "snapshots", label: "Snapshots  (save / load / delete / list)" }] : []),
				{ value: "remove", label: "Remove  (stop first, then delete)" },
				{ value: "back", label: "← Back to machine list" },
			];
			const stoppedActions = [
				{ value: "start", label: "Start" },
				...(canSnapshot ? [{ value: "snapshots", label: "Snapshots  (list only — start for save / load / delete)" }] : []),
				{ value: "remove", label: "Remove" },
				{ value: "back", label: "← Back to machine list" },
			];
			const actions = isRunning ? runningActions : stoppedActions;

			const action = await clack.select({
				message: `${bold(target.name)} — ${target.status}. Choose action:`,
				options: actions,
			});
			if (clack.isCancel(action) || action === "back") break;

			const instance = QuickCHR.get(target.name);
			if (!instance) { clack.log.error(machineNotFoundMessage(target.name)); break; }

			if (action === "start") {
				const spinner = clack.spinner();
				spinner.start(`Starting ${target.name}...`);
				const started = await QuickCHR.start({ name: target.name, background: true });
				spinner.stop(`${statusIcon("running")} ${bold(started.name)} started`);
				const creds = await resolveDisplayCredentials(started.state);
				clack.note(`REST: ${link(formatRestUrl(started.ports.http, creds.user, creds.password))}\nSSH:  ${formatSshCommand(creds.user, started.sshPort)}`, "Instance details");
			} else if (action === "stop") {
				await instance.stop();
				clack.log.success(`${bold(target.name)} stopped`);
			} else if (action === "snapshots") {
				const { formatSnapshotTable, formatDiskSize } = await import("../lib/disk.ts");
				const MAX_WIZARD_SNAPSHOTS = 16;

				// Pre-fetch snapshot list so unavailable actions (load/delete) are hidden
				const snapSpinner = clack.spinner();
				snapSpinner.start("Loading snapshots...");
				let snaps = await instance.snapshot.list();
				snapSpinner.stop(`${snaps.length} snapshot${snaps.length === 1 ? "" : "s"}`);

				// Snapshot action loop — "back" returns to machine action menu
				while (true) {
					const hasSnaps = snaps.length > 0;
					const snapshotOptions = isRunning
						? [
							{ value: "list", label: "List snapshots" },
							{ value: "save", label: "Save snapshot" },
							...(hasSnaps ? [{ value: "load", label: "Load (restore) snapshot" }] : []),
							...(hasSnaps ? [{ value: "delete", label: "Delete snapshot" }] : []),
							{ value: "back", label: "← Back" },
						]
						: [
							{ value: "list", label: "List snapshots" },
							{ value: "back", label: "← Back  (start machine for save / load / delete)" },
						];

					const snapshotAction = await clack.select({
						message: `${bold(target.name)} snapshots:`,
						options: snapshotOptions,
					});
					if (clack.isCancel(snapshotAction) || snapshotAction === "back") break;

					if (snapshotAction === "list") {
						if (snaps.length === 0) {
							clack.log.info("No snapshots yet. Use \"Save snapshot\" to create one.");
						} else {
							const displaySnaps = snaps.slice(0, MAX_WIZARD_SNAPSHOTS);
							clack.note(formatSnapshotTable(displaySnaps), `${target.name} — ${snaps.length} snapshot${snaps.length === 1 ? "" : "s"}`);
							if (snaps.length > MAX_WIZARD_SNAPSHOTS) {
								clack.log.warn(`Showing ${MAX_WIZARD_SNAPSHOTS} of ${snaps.length}. Use 'quickchr snapshot ${target.name} list' for full output.`);
							}
						}
						snaps = await instance.snapshot.list();
						continue;
					}

					if (snapshotAction === "save") {
						const defaultName = new Date().toISOString().replace(/:/g, "-").replace(/\..+$/, "Z");
						const snapName = await clack.text({
							message: "Snapshot name:",
							placeholder: defaultName,
							defaultValue: defaultName,
							validate: (v) => {
								if (!v.trim()) return "Snapshot name is required";
								if (/\s/.test(v)) return "Use a name without spaces";
							},
						});
						if (clack.isCancel(snapName)) continue;

						const spinner = clack.spinner();
						spinner.start(`Saving snapshot ${snapName}...`);
						try {
							const snap = await instance.snapshot.save(snapName);
							spinner.stop(`Saved snapshot ${bold(snap.name)} (${formatDiskSize(snap.vmStateSize)})`);
							snaps = await instance.snapshot.list();
						} catch (e) {
							spinner.stop("Failed to save snapshot");
							clack.log.error(e instanceof Error ? e.message : String(e));
						}
						continue;
					}

					if (snapshotAction === "load") {
						const displaySnaps = snaps.slice(0, MAX_WIZARD_SNAPSHOTS);
						const selectedSnap = await clack.select({
							message: "Select snapshot to load:",
							options: displaySnaps.map((s) => ({
								value: s.name,
								label: s.name,
								hint: `${formatDiskSize(s.vmStateSize)} — ${s.date.replace("T", " ").replace(/:\d{2}(?:\.\d+)?Z$/, "").replace("Z", "")}`,
							})),
						});
						if (clack.isCancel(selectedSnap)) continue;

						const confirmed = await clack.confirm({
							message: `Load snapshot ${bold(selectedSnap)}? Current runtime state will be replaced.`,
							initialValue: false,
						});
						if (clack.isCancel(confirmed) || !confirmed) continue;

						const spinner = clack.spinner();
						spinner.start(`Loading snapshot ${selectedSnap}...`);
						try {
							await instance.snapshot.load(selectedSnap);
							const booted = await instance.waitForBoot(120_000);
							spinner.stop(booted
								? `Loaded snapshot ${bold(selectedSnap)}`
								: `Loaded snapshot ${bold(selectedSnap)} (boot readiness check timed out)`);
						} catch (e) {
							spinner.stop("Failed to load snapshot");
							clack.log.error(e instanceof Error ? e.message : String(e));
						}
						continue;
					}

					if (snapshotAction === "delete") {
						const displaySnaps = snaps.slice(0, MAX_WIZARD_SNAPSHOTS);
						const selectedSnap = await clack.select({
							message: "Select snapshot to delete:",
							options: displaySnaps.map((s) => ({
								value: s.name,
								label: s.name,
								hint: `${formatDiskSize(s.vmStateSize)} — ${s.date.replace("T", " ").replace(/:\d{2}(?:\.\d+)?Z$/, "").replace("Z", "")}`,
							})),
						});
						if (clack.isCancel(selectedSnap)) continue;

						const confirmed = await clack.confirm({
							message: `Delete snapshot ${bold(selectedSnap)}?`,
							initialValue: false,
						});
						if (clack.isCancel(confirmed) || !confirmed) continue;

						try {
							await instance.snapshot.delete(selectedSnap);
							clack.log.success(`Deleted snapshot ${bold(selectedSnap)}`);
							snaps = await instance.snapshot.list();
						} catch (e) {
							clack.log.error(e instanceof Error ? e.message : String(e));
						}
					}
				}
				// snapshot loop exited via "← Back" → continue action loop
			} else if (action === "remove") {
				const confirmed = await clack.confirm({
					message: `Remove ${bold(target.name)} and its disk? This cannot be undone.`,
					initialValue: false,
				});
				if (!clack.isCancel(confirmed) && confirmed) {
					await instance.remove();
					clack.log.success(`${bold(target.name)} removed`);
					break; // machine is gone — exit action loop
				}
				// declined: stay in action loop
			}
		}

		machineList = QuickCHR.list();
	}
	// machine select "← Back" → outer while continues → main menu re-shown
	}
}

async function cmdStart(argv: string[]) {
	const { flags, positional } = parseFlags(argv);

	// --all: start every stopped machine in background
	if (flagBool(flags, "all")) {
		const { QuickCHR } = await import("../lib/quickchr.ts");
		const { statusIcon, link, bold, resolveDisplayCredentials, formatRestUrl, formatSshCommand } = await import("./format.ts");
		const stopped = QuickCHR.list().filter((m) => m.status !== "running");
		if (stopped.length === 0) {
			console.log("No stopped instances.");
			return;
		}
		for (const m of stopped) {
			console.log(`Starting ${bold(m.name)}...`);
			const instance = await QuickCHR.start({ name: m.name, background: true });
			const creds = await resolveDisplayCredentials(instance.state);
			console.log(`${statusIcon("running")} ${bold(instance.name)}  REST: ${link(formatRestUrl(instance.ports.http, creds.user, creds.password))}  SSH: ${formatSshCommand(creds.user, instance.sshPort)}`);
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
	const { statusIcon, formatPorts, formatNetworks, link, bold, dim, resolveDisplayCredentials, formatRestUrl, formatSshCommand } = await import("./format.ts");

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
		networks: buildNetworks(flags),
		bootDiskFormat: (flag(flags, "boot-disk-format") as StartOptions["bootDiskFormat"] | undefined) ?? "qcow2",
		bootSize: flag(flags, "boot-size"),
		extraDisks: flagList(flags, "add-disk").length > 0 ? flagList(flags, "add-disk") : undefined,
		installDeps: flagBool(flags, "install-deps"),
		dryRun: flagBool(flags, "dry-run"),
		timeoutExtra: parseInt(flag(flags, "timeout-extra") ?? flag(flags, "T") ?? "0", 10) * 1000 || undefined,
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
		const creds = await resolveDisplayCredentials(instance.state);
		console.log(`${statusIcon("running")} ${bold(instance.name)} started`);
		console.log(`  Version: ${instance.state.version} (${instance.state.arch})`);
		console.log(`  Network: ${formatNetworks(instance.state.networks ?? [])}`);
		console.log(`  Ports:   ${formatPorts(instance.state.ports)}`);
		console.log(`  REST:    ${link(formatRestUrl(instance.ports.http, creds.user, creds.password))}`);
		console.log(`  SSH:     ${formatSshCommand(creds.user, instance.sshPort)}`);
		console.log(`  WinBox:  127.0.0.1:${instance.ports.winbox}`);
		if (creds.user !== "admin") {
			console.log(`  Login:   ${creds.user} / ${creds.password || "(no password)"}`);
			console.log(`  Run:     quickchr exec ${instance.name} /system/resource/print`);
		}
	}
}

async function cmdStop(argv: string[]) {
	const { flags, positional } = parseFlags(argv);
	const { QuickCHR } = await import("../lib/quickchr.ts");
	const { statusIcon, bold, machineNotFoundMessage } = await import("./format.ts");

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
		console.error(machineNotFoundMessage(name));
		process.exit(1);
	}
	await instance.stop();
	console.log(`${statusIcon("stopped")} ${bold(name)} stopped`);
}

async function cmdList(argv: string[] = []) {
	const { flags, positional } = parseFlags(argv);
	const asJson = flagBool(flags, "json");
	const name = positional[0];

	const { QuickCHR } = await import("../lib/quickchr.ts");

	if (name) {
		const { statusIcon, bold, dim, link, formatPorts, formatNetworks, machineNotFoundMessage, resolveDisplayCredentials, formatRestUrl, formatSshCommand } = await import("./format.ts");

		const instance = QuickCHR.get(name);
		if (!instance) {
			console.error(machineNotFoundMessage(name));
			process.exit(1);
		}

		const s = instance.state;

		if (asJson) {
			const creds = s.status === "running" ? await resolveDisplayCredentials(s) : null;
			console.log(JSON.stringify({
				name: s.name,
				status: s.status,
				version: s.version,
				arch: s.arch,
				cpu: s.cpu,
				mem: s.mem,
				networks: s.networks,
				ports: s.ports,
				pid: s.pid ?? null,
				packages: s.packages,
				machineDir: s.machineDir,
				createdAt: s.createdAt,
				lastStartedAt: s.lastStartedAt ?? null,
				credentials: creds,
			}, null, 2));
			return;
		}

		console.log(`\n${statusIcon(s.status)} ${bold(s.name)}`);
		console.log(`  Version:    ${s.version} (${s.arch})`);
		console.log(`  CPU/Mem:    ${s.cpu} vCPU${s.cpu > 1 ? "s" : ""}, ${s.mem} MB`);
		console.log(`  Network:    ${formatNetworks(s.networks)}`);
		console.log(`  Ports:      ${formatPorts(s.ports)}`);
		console.log(`  Status:     ${s.status}${s.pid ? ` (PID ${s.pid})` : ""}`);
		console.log(`  Created:    ${new Date(s.createdAt).toLocaleString()}`);
		if (s.lastStartedAt) console.log(`  Started:    ${new Date(s.lastStartedAt).toLocaleString()}`);
		if (s.packages.length > 0) console.log(`  Packages:   ${s.packages.join(", ")}`);
		console.log(`  Dir:        ${dim(s.machineDir)}`);
		console.log(`  Logs:       ${dim(`${s.machineDir}/qemu.log`)}`);

		if (s.status === "running") {
			const creds = await resolveDisplayCredentials(s);
			console.log();
			console.log(`  REST:       ${link(formatRestUrl(instance.ports.http, creds.user, creds.password))}`);
			console.log(`  WinBox:     127.0.0.1:${instance.ports.winbox}`);
			console.log(`  SSH:        ${formatSshCommand(creds.user, instance.sshPort)}`);
			if (creds.user !== "admin") {
				console.log(`  Login:      ${creds.user} / ${creds.password || "(no password)"}`);
			}
			console.log(`  Serial:     ${dim(`${s.machineDir}/serial.sock`)}`);
			console.log();
			console.log(`  ${dim("Tip:")} quickchr stop ${s.name}`);
		} else {
			console.log();
			console.log(`  ${dim("Tip:")} quickchr start ${s.name}  |  quickchr remove ${s.name}`);
		}
		console.log();
		return;
	}

	const { table, statusIcon, formatPorts, formatNetworks, dim } = await import("./format.ts");
	const machines = QuickCHR.list();

	if (machines.length === 0) {
		if (asJson) {
			console.log("[]");
		} else {
			console.log("No instances. Run 'quickchr start' to create one.");
		}
		return;
	}

	if (asJson) {
		console.log(JSON.stringify(machines, null, 2));
		return;
	}

	const headers = ["", "Name", "Version", "Arch", "Network", "Ports", "PID"];
	const rows = machines.map((m) => [
		statusIcon(m.status),
		m.name,
		m.version,
		m.arch,
		formatNetworks(m.networks ?? []),
		formatPorts(m.ports),
		m.pid ? String(m.pid) : dim("—"),
	]);

	console.log(table(headers, rows));
}


async function cmdGet(argv: string[]) {
	const { flags, positional } = parseFlags(argv);
	const { QuickCHR } = await import("../lib/quickchr.ts");
	const { bold, dim, machineNotFoundMessage } = await import("./format.ts");

	const name = positional[0];
	const group = positional[1] as "license" | "device-mode" | "admin" | undefined;
	const asJson = flagBool(flags, "json");

	if (!name) {
		console.error("Usage: quickchr get <name> [license|device-mode|admin] [--json]");
		process.exit(1);
	}

	const validGroups = ["license", "device-mode", "admin"];
	if (group && !validGroups.includes(group)) {
		console.error(`Unknown property group: "${group}". Valid groups: ${validGroups.join(", ")}`);
		process.exit(1);
	}

	const instance = QuickCHR.get(name);
	if (!instance) {
		console.error(machineNotFoundMessage(name));
		process.exit(1);
	}

	const s = instance.state;

	if (s.status !== "running") {
		// Offline — show what we know from persisted state
		const offlineData = {
			name: s.name,
			status: s.status,
			version: s.version,
			arch: s.arch,
			note: "machine is not running — live properties unavailable",
		};
		if (asJson) {
			console.log(JSON.stringify(offlineData, null, 2));
		} else {
			console.log(`\n${bold(s.name)} (${s.status})`);
			console.log(`  Version: ${s.version} (${s.arch})`);
			console.log(`  ${dim("Start the machine to query live properties.")}`);
			console.log();
		}
		return;
	}

	const { resolveAuth } = await import("../lib/auth.ts");
	const auth = resolveAuth(s);
	const base = `http://127.0.0.1:${instance.ports.http}/rest`;
	const authHeader = auth.header;

	async function fetchGroup(path: string): Promise<unknown> {
		try {
			const { restGet: rGet } = await import("../lib/rest.ts");
			const { status, body } = await rGet(`${base}${path}`, authHeader, 8_000);
			if (status >= 200 && status < 300) return JSON.parse(body);
		} catch { /* offline or auth error */ }
		return null;
	}

	const results: Record<string, unknown> = {};

	if (!group || group === "license") {
		const v = await fetchGroup("/system/license");
		if (v) results.license = v;
	}
	if (!group || group === "device-mode") {
		const v = await fetchGroup("/system/device-mode");
		if (v) results["device-mode"] = v;
	}
	if (!group || group === "admin") {
		// Show all users in group=full (admin-equivalent)
		const users = await fetchGroup("/user") as Array<Record<string, unknown>> | null;
		if (users) results.admin = users.filter((u) => u.group === "full");
	}

	if (asJson) {
		console.log(JSON.stringify(results, null, 2));
		return;
	}

	console.log(`\n${bold(s.name)} — live config`);

	if (results.license) {
		const lic = results.license as Record<string, unknown>;
		console.log(`\n  ${bold("License")}`);
		const level = lic.level ?? lic["upgradable-to"] ?? "free (1 Mbps)";
		console.log(`    Level:       ${level}`);
		if (lic["system-id"]) console.log(`    Software ID: ${lic["system-id"]}`);
		if (lic.deadline) console.log(`    Deadline:    ${lic.deadline}`);
	}

	if (results["device-mode"]) {
		const dm = results["device-mode"] as Record<string, unknown>;
		const mode = dm.mode ?? "(not set)";
		console.log(`\n  ${bold("Device Mode")}`);
		console.log(`    Mode: ${mode}`);
		const features = Object.entries(dm)
			.filter(([k, v]) => k !== "mode" && v === true)
			.map(([k]) => k);
		if (features.length > 0) console.log(`    Enabled: ${features.join(", ")}`);
	}

	if (results.admin) {
		const users = results.admin as Array<Record<string, unknown>>;
		console.log(`\n  ${bold("Admin Users")} (group=full)`);
		for (const u of users) {
			const status = u.disabled === "true" || u.disabled === true ? dim(" (disabled)") : "";
			console.log(`    ${u.name}${status}`);
		}
	}

	console.log();
}

async function cmdRemove(argv: string[]) {
	const { flags, positional } = parseFlags(argv);
	const { QuickCHR } = await import("../lib/quickchr.ts");
	const { bold, statusIcon, machineNotFoundMessage } = await import("./format.ts");

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
		console.error(machineNotFoundMessage(name));
		process.exit(1);
	}

	await instance.remove();
	console.log(`${bold(name)} removed.`);
}

async function cmdClean(argv: string[]) {
	const { flags, positional } = parseFlags(argv);
	const { QuickCHR } = await import("../lib/quickchr.ts");
	const { bold, statusIcon, machineNotFoundMessage } = await import("./format.ts");

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
		console.error(machineNotFoundMessage(name));
		process.exit(1);
	}

	await instance.clean();
	console.log(`${bold(name)} reset to fresh image.`);
}

async function applyLicense(argv: string[]) {
	const { flags, positional } = parseFlags(argv);
	const { QuickCHR } = await import("../lib/quickchr.ts");
	const { bold, machineNotFoundMessage } = await import("./format.ts");

	const name = positional[0] ?? flag(flags, "name");

	if (!name) {
		console.error("Usage: quickchr set <name> --license [--level=p1|p10|unlimited]");
		process.exit(1);
	}

	const instance = QuickCHR.get(name);
	if (!instance) {
		console.error(machineNotFoundMessage(name));
		process.exit(1);
	}
	if (instance.state.status !== "running") {
		console.error(`Machine "${name}" is not running.`);
		process.exit(1);
	}

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

	const before = instance.state.licenseLevel ?? "free";
	console.log(`Applying license level=${level} to ${bold(name)}...`);
	await instance.license({ account: account as string, password: password as string, level });
	console.log(`License applied: ${before} → ${level}`);
}

async function cmdSet(argv: string[]) {
	const { flags, positional } = parseFlags(argv);
	const name = positional[0];

	if (!name) {
		console.error("Usage: quickchr set <name> --license [--level=p1|p10|unlimited]");
		process.exit(1);
	}

	const wantsLicense = flagBool(flags, "license");

	if (!wantsLicense) {
		console.error("Nothing to set. Available flags: --license");
		process.exit(1);
	}

	if (wantsLicense) {
		const subcmdArgs = [name, ...Object.entries(flags).flatMap(([k, v]) => v === true ? [`--${k}`] : [`--${k}=${v}`]), ...positional.slice(1)];
		await applyLicense(subcmdArgs);
	}
}

async function cmdLicense(argv: string[]) {
	await applyLicense(argv);
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
	const { bold, dim, machineNotFoundMessage } = await import("./format.ts");
	const { getDiskInfo } = await import("../lib/disk.ts");
	const { join } = await import("node:path");
	const { existsSync } = await import("node:fs");
	const { findQemuImg } = await import("../lib/platform.ts");

	const machine = QuickCHR.get(name);
	if (!machine) {
		console.error(machineNotFoundMessage(name));
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

async function cmdSnapshot(argv: string[]) {
	const { flags, positional } = parseFlags(argv);
	const name = positional[0];
	const subcmd = positional[1] ?? "list";
	const snapName = positional[2];
	const jsonOutput = flags.json === true;

	if (!name || name === "help" || name === "--help" || name === "-h") {
		printCommandHelp("snapshot");
		return;
	}

	const { QuickCHR } = await import("../lib/quickchr.ts");
	const { bold, dim, machineNotFoundMessage } = await import("./format.ts");
	const { formatSnapshotTable, formatDiskSize } = await import("../lib/disk.ts");

	const instance = QuickCHR.get(name);
	if (!instance) {
		console.error(machineNotFoundMessage(name));
		process.exit(1);
	}

	const format = instance.state.bootDiskFormat ?? (instance.state.bootSize ? "qcow2" : "raw");
	if (format !== "qcow2") {
		console.error(`Snapshots require a qcow2 boot disk. "${name}" uses ${format}.`);
		console.error(dim("Hint: recreate with --boot-disk-format=qcow2 or --boot-size=<size>."));
		process.exit(1);
	}

	switch (subcmd) {
		case "list":
		case "ls": {
			const snaps = await instance.snapshot.list();
			if (jsonOutput) {
				console.log(JSON.stringify(snaps, null, 2));
			} else if (snaps.length === 0) {
				console.log("No snapshots.");
			} else {
				console.log(bold(`Snapshots for ${name}\n`));
				console.log(formatSnapshotTable(snaps));
			}
			break;
		}
		case "save": {
			const snap = await instance.snapshot.save(snapName);
			if (jsonOutput) {
				console.log(JSON.stringify(snap, null, 2));
			} else {
				console.log(`Saved snapshot ${bold(snap.name)} (${formatDiskSize(snap.vmStateSize)})`);
			}
			break;
		}
		case "load": {
			if (!snapName) {
				const snaps = await instance.snapshot.list();
				if (snaps.length > 0 && snaps.length <= 5) {
					console.error(`Usage: quickchr snapshot ${name} load <snapshot-name>`);
					console.error(dim(`  Available: ${snaps.map((s) => s.name).join(", ")}`));
				} else {
					console.error(`Usage: quickchr snapshot ${name} load <snapshot-name>`);
					if (snaps.length > 5) console.error(dim(`  Run 'quickchr snapshot ${name} list' to see all snapshots.`));
					else console.error(dim(`  No snapshots yet. Run: quickchr snapshot ${name} save`));
				}
				process.exit(1);
			}
			await instance.snapshot.load(snapName);
			if (!jsonOutput) console.log(`Loaded snapshot ${bold(snapName)}`);
			break;
		}
		case "delete":
		case "rm": {
			if (!snapName) {
				const snaps = await instance.snapshot.list();
				if (snaps.length > 0 && snaps.length <= 5) {
					console.error(`Usage: quickchr snapshot ${name} delete <snapshot-name>`);
					console.error(dim(`  Available: ${snaps.map((s) => s.name).join(", ")}`));
				} else {
					console.error(`Usage: quickchr snapshot ${name} delete <snapshot-name>`);
					if (snaps.length > 5) console.error(dim(`  Run 'quickchr snapshot ${name} list' to see all snapshots.`));
				}
				process.exit(1);
			}
			await instance.snapshot.delete(snapName);
			if (!jsonOutput) console.log(`Deleted snapshot ${bold(snapName)}`);
			break;
		}
		default:
			console.error(`Unknown snapshot subcommand: ${subcmd}`);
			printCommandHelp("snapshot");
			process.exit(1);
	}
}

async function cmdNetworks(argv: string[]) {
	const subcmd = argv[0];

	if (subcmd === "help" || subcmd === "--help" || subcmd === "-h") {
		showNetworksHelp();
		return;
	}

	if (subcmd === "interfaces") {
		await showInterfaces();
		return;
	}

	if (subcmd === "sockets") {
		await handleSockets(argv.slice(1));
		return;
	}

	if (subcmd && subcmd !== "--help") {
		console.error(`Unknown networks subcommand: ${subcmd}\nRun 'quickchr networks help' for usage.`);
		process.exit(1);
	}

	await showNetworkOverview();
}

async function showNetworkOverview() {
	const { detectPlatform, detectPhysicalInterfaces } = await import("../lib/platform.ts");
	const { listNamedSockets } = await import("../lib/socket-registry.ts");
	const { statusIcon, bold, dim } = await import("./format.ts");

	const platform = await detectPlatform();
	const interfaces = detectPhysicalInterfaces();
	const sockets = listNamedSockets();
	const vmnet = platform.socketVmnet;

	const osLabel = platform.os === "darwin" ? "macOS" : platform.os === "linux" ? "Linux" : "Windows";

	console.log(bold("Network Capabilities:\n"));

	console.log(`  Platform:       ${osLabel} (${platform.os}/${platform.hostArch})`);

	if (platform.os === "darwin") {
		if (vmnet) {
			console.log(`  socket_vmnet:   ${statusIcon("ok")} installed (${dim(vmnet.client)})`);
			if (vmnet.sharedSocket) {
				console.log(`    Shared daemon:  ${statusIcon("ok")} running (${dim(vmnet.sharedSocket)})`);
			} else {
				console.log(`    Shared daemon:  ${statusIcon("error")} not running`);
			}
			const bridgedEntries = Object.entries(vmnet.bridgedSockets);
			if (bridgedEntries.length > 0) {
				console.log(`    Bridged daemons:`);
				for (const [iface, sock] of bridgedEntries) {
					console.log(`      ${iface}: ${dim(sock)}`);
				}
			} else {
				console.log("    Bridged daemons: none");
			}
		} else {
			console.log(`  socket_vmnet:   ${statusIcon("error")} not installed`);
			console.log(`    Hint: brew install socket_vmnet`);
		}
	} else {
		console.log(`  socket_vmnet:   ${dim("n/a (macOS only)")}`);
	}

	console.log();

	if (interfaces.length > 0) {
		console.log("  Physical Interfaces:");
		for (const iface of interfaces) {
			const aliasStr = iface.alias ? dim(`  (alias: ${iface.alias})`) : "";
			console.log(`    ${iface.device.padEnd(6)}${iface.name}${aliasStr}`);
		}
	} else {
		console.log(`  Physical Interfaces: ${dim("none detected")}`);
	}

	console.log();
	console.log("  Available Specifiers:");
	console.log("    user              User-mode networking with port forwarding (default)");
	if (platform.os === "darwin") {
		if (vmnet?.sharedSocket) {
			console.log("    shared            Shared network via socket_vmnet (rootless)");
		} else if (vmnet) {
			console.log(`    shared            ${dim("Shared daemon not running")}`);
		} else {
			console.log(`    shared            ${dim("Requires socket_vmnet")}`);
		}
		console.log("    bridged:<iface>   Bridge to host interface (e.g., bridged:en0, bridged:wifi)");
	}
	console.log("    socket::<name>    Named L2 link between CHR instances");
	console.log("    socket:listen:<port>  QEMU socket listen");
	console.log("    socket:connect:<port> QEMU socket connect");
	console.log("    socket:mcast:<group>:<port>  Multicast socket");

	console.log();
	if (sockets.length > 0) {
		console.log("  Named Sockets:");
		for (const s of sockets) {
			const members = s.members.length > 0 ? dim(`  members: ${s.members.join(", ")}`) : "";
			console.log(`    ${s.name.padEnd(16)}${s.mode} port:${s.port}${members}`);
		}
	} else {
		console.log("  Named Sockets:");
		console.log("    (none)");
	}
}

async function showInterfaces() {
	const { detectPhysicalInterfaces } = await import("../lib/platform.ts");
	const { table, dim } = await import("./format.ts");

	const interfaces = detectPhysicalInterfaces();
	if (interfaces.length === 0) {
		console.log("No physical interfaces detected.");
		return;
	}

	const rows = interfaces.map((iface) => [
		iface.device,
		iface.name,
		iface.alias ?? "",
		iface.mac ?? dim("n/a"),
	]);
	console.log(table(["Device", "Name", "Alias", "MAC"], rows));
}

async function handleSockets(argv: string[]) {
	const { listNamedSockets, createNamedSocket, removeNamedSocket } = await import("../lib/socket-registry.ts");
	const { bold, dim, table: fmtTable } = await import("./format.ts");

	const action = argv[0];

	if (!action) {
		const sockets = listNamedSockets();
		if (sockets.length === 0) {
			console.log("No named sockets.");
			return;
		}
		const rows = sockets.map((s) => [
			s.name,
			s.mode,
			String(s.port),
			s.mcastGroup ?? "",
			s.members.join(", ") || dim("none"),
		]);
		console.log(fmtTable(["Name", "Mode", "Port", "Group", "Members"], rows));
		return;
	}

	if (action === "create") {
		const name = argv[1];
		if (!name) {
			console.error("Usage: quickchr networks sockets create <name>");
			process.exit(1);
		}
		const entry = createNamedSocket(name);
		console.log(`Created named socket: ${bold(entry.name)} (${entry.mode} port:${entry.port})`);
		return;
	}

	if (action === "remove") {
		const name = argv[1];
		if (!name) {
			console.error("Usage: quickchr networks sockets remove <name>");
			process.exit(1);
		}
		const removed = removeNamedSocket(name);
		if (removed) {
			console.log(`Removed named socket: ${bold(name)}`);
		} else {
			console.error(`Named socket "${name}" not found.`);
			process.exit(1);
		}
		return;
	}

	console.error(`Unknown sockets subcommand: ${action}\nRun 'quickchr networks help' for usage.`);
	process.exit(1);
}

function showNetworksHelp() {
	console.log(`quickchr networks — network discovery and socket management

Usage:
  quickchr networks                     Show network overview
  quickchr networks interfaces          List physical interfaces
  quickchr networks sockets             List named sockets
  quickchr networks sockets create <n>  Create a named socket
  quickchr networks sockets remove <n>  Remove a named socket

Aliases: quickchr net`);
}

async function cmdCompletions(argv: string[]) {
	const { flags } = parseFlags(argv);
	const {
		installCompletions,
		uninstallCompletions,
		allCompletionStatuses,
		completionStatusFor,
		detectCurrentShell,
		shellBinary,
		listMachineNamesForCompletion,
		listRunningMachineNamesForCompletion,
	} = await import("../lib/completions.ts");
	type SupportedShell = import("../lib/completions.ts").SupportedShell;

	// Hidden flags used by the completion scripts themselves
	if (flags.machines === true) {
		const names = listMachineNamesForCompletion();
		if (names.length > 0) console.log(names.join("\n"));
		return;
	}
	if (flags.running === true) {
		const names = listRunningMachineNamesForCompletion();
		if (names.length > 0) console.log(names.join("\n"));
		return;
	}

	const shellInfo = detectCurrentShell();
	const binary = shellBinary(shellInfo);

	if (flags.install === true) {
		const shellOverride = flag(flags, "shell") as SupportedShell | undefined;
		const targetShell: SupportedShell = shellOverride ?? (shellInfo.supported ? binary as SupportedShell : undefined) ?? "bash";
		const dryRun = flagBool(flags, "dry-run");

		if (dryRun) {
			const { completionInstallPath } = await import("../lib/completions.ts");
			const loc = completionInstallPath(targetShell);
			console.log(`Would write: ${loc.file}`);
			if (loc.rcLine && loc.rcFile) {
				console.log(`Would append to ${loc.rcFile}:`);
				console.log(`  ${loc.rcLine}`);
			}
			return;
		}

		const result = installCompletions(targetShell, { dryRun: false });
		if (result.alreadyInstalled) {
			console.log(`Completions already installed (refreshed): ${result.file}`);
		} else {
			console.log(`Installed ${result.shell} completions: ${result.file}`);
		}
		if (result.rcLine && result.rcFile) {
			console.log(`Added to ${result.rcFile}:`);
			console.log(`  ${result.rcLine}`);
		}
		console.log("Restart your shell or open a new terminal to activate completions.");
		return;
	}

	if (flags.uninstall === true) {
		const shellOverride = flag(flags, "shell") as SupportedShell | undefined;
		const targetShell: SupportedShell = shellOverride ?? (shellInfo.supported ? binary as SupportedShell : undefined) ?? "bash";

		const result = uninstallCompletions(targetShell);
		if (result.removed) {
			console.log(`Removed ${targetShell} completions: ${result.file}`);
			if (result.rcLine && result.rcFile) {
				console.log(`Removed line from ${result.rcFile}:`);
				console.log(`  ${result.rcLine}`);
			}
		} else {
			console.log(`Completions were not installed for ${targetShell}.`);
		}
		return;
	}

	// Default: show status for all shells
	const statuses = allCompletionStatuses();
	console.log("Shell completion status:\n");
	for (const s of statuses) {
		const mark = s.installed ? "✓" : "✗";
		const note = s.installed ? "installed" : "not installed";
		console.log(`  ${mark} ${s.shell.padEnd(5)}  ${note.padEnd(15)}  ${s.path}`);
	}

	const detected = completionStatusFor(shellInfo.supported ? binary as SupportedShell : "bash");
	console.log();
	if (!shellInfo.supported) {
		console.log(`Current shell (${binary}) is not supported for auto-install.`);
		console.log(`Supported: bash, zsh, fish`);
	} else if (!detected.installed) {
		console.log(`Run 'quickchr completions --install' to install for ${binary}.`);
	} else {
		console.log(`Completions active. Restart shell if recently installed.`);
	}
}

async function cmdLogs(argv: string[]) {
	const { flags, positional } = parseFlags(argv);
	const name = positional[0];

	if (!name) {
		console.error("Usage: quickchr logs <name> [--follow] [-n <lines>]");
		process.exit(1);
	}

	const { QuickCHR } = await import("../lib/quickchr.ts");
	const { join } = await import("node:path");
	const { existsSync } = await import("node:fs");
	const { machineNotFoundMessage } = await import("./format.ts");

	const instance = QuickCHR.get(name);
	if (!instance) {
		console.error(machineNotFoundMessage(name));
		process.exit(1);
	}

	const logPath = join(instance.state.machineDir, "qemu.log");

	if (!existsSync(logPath)) {
		console.log("No log file yet.");
		return;
	}

	let follow = flagBool(flags, "follow");
	let lines = flag(flags, "lines") ? Number(flag(flags, "lines")) : 50;

	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "-f") follow = true;
		if (argv[i] === "-n" && argv[i + 1]) {
			lines = Number(argv[i + 1]);
			i++;
		}
	}

	if (follow) {
		const tail = Bun.spawn(["tail", "-f", "-n", String(lines), logPath], {
			stdout: "inherit",
			stderr: "inherit",
		});
		await tail.exited;
	} else {
		const tail = Bun.spawnSync(["tail", "-n", String(lines), logPath], { stdout: "pipe" });
		process.stdout.write(tail.stdout);
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
  list [<name>] [--json]  List all instances, or detail for one
  status                  Alias for list
  console <name>          Attach to serial console of a running instance
  exec <name> <command>   Run a RouterOS CLI command on a running instance
  remove [<name>|--all]   Remove instance(s) and disk
  clean [<name>|--all]    Reset instance disk to fresh image
  get <name> [group]          Show machine config (license, device-mode, admin)
  set <name> --license    Apply/renew CHR trial license
  license <name>          Deprecated — use 'set <name> --license'
  disk <name>             Show disk details for an instance
  snapshot <name> [cmd]   Manage snapshots (list/save/load/delete)
  networks                Network discovery & socket management
  completions             Manage shell completions (Tab completion)
  logs <name>             Tail the QEMU log for an instance
  doctor                  Check prerequisites
  version                 Show version info
  help [command]          Show help

Environment:
  MIKROTIK_WEB_ACCOUNT    MikroTik.com account email (for license)
  MIKROTIK_WEB_PASSWORD   MikroTik.com password (for license)

Provisioning support:
  ${provisioningSupportSummary(MIN_PROVISION_VERSION)}
  ${PROVISIONING_BOOT_ONLY_SUMMARY}
  Prefer --channel long-term when you plan to use ${PROVISIONING_FEATURE_SUMMARY}.

Run 'quickchr help <command>' for command-specific help.`);
}

function printCommandHelp(command: string) {
	switch (command) {
		case "add":
			console.log(`quickchr add [options]

Create a new CHR machine without starting it.
Use 'quickchr start <name>' to boot it afterwards.

Post-boot provisioning flags in this command (--add-package, --install-all-packages,
--add-user, --disable-admin, managed login, and device-mode) are validated on
RouterOS ${MIN_PROVISION_VERSION}+ only. Older 7.x remains boot-only. Disk and network
options still work on older versions when the required host tools are installed.

Options:
  --name <name>         Instance name (required)
  --version <ver>       RouterOS version (e.g., 7.22.1)
  --channel <ch>        Channel: stable, long-term, testing, development
  --arch <arch>         Architecture: arm64, x86 (default: host native)
  --cpu <n>             vCPU count (default: 1)
  --mem <mb>            RAM in MB (default: 512)
	--boot-disk-format <f> Boot disk format: qcow2|raw (default: qcow2)
	--boot-size <size>    Resize boot disk (e.g., 512M, 2G) — qcow2 only, requires qemu-img
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
  --add-network <spec>  Add a network NIC (repeatable). Specs: user, shared, bridged:<if>,
                        socket::<name>, tap:<if>. Default: single user NIC.
  --no-network          Start with no NICs (headless)
  --vmnet-shared        [deprecated] Use --add-network shared
  --vmnet-bridge <if>   [deprecated] Use --add-network bridged:<if>`);
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
  --via <transport>   Transport: auto, rest, qga (default: auto) — qga requires KVM
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

Post-boot provisioning flags in this command (${PROVISIONING_FEATURE_SUMMARY}) are
validated on RouterOS ${MIN_PROVISION_VERSION}+ only. Older 7.x remains boot-only.
Disk and network options still work on older versions when the required host tools
are installed.

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
	--boot-disk-format <f> Boot disk format: qcow2|raw (default: qcow2)
	--boot-size <size>    Resize boot disk (e.g., 512M, 2G) — qcow2 only, requires qemu-img
	--add-disk <size>     Add an extra blank qcow2 disk (repeatable, requires qemu-img)
  --add-package <pkg>   Extra package to install (repeatable)
  --add-user <u:p>      Create user with name:password
  --disable-admin       Disable the default admin account
  --no-secure-login     Keep admin with no password (skip managed account)
  --port-base <port>    Starting port number (default: auto-allocated from 9100)
  --no-winbox           Exclude WinBox port mapping
  --no-api-ssl          Exclude API-SSL port mapping
  --add-network <spec>  Add a network NIC (repeatable). Specs: user, shared, bridged:<if>,
                        socket::<name>, tap:<if>. Default: single user NIC.
  --no-network          Start with no NICs (headless)
  --vmnet-shared        [deprecated] Use --add-network shared
  --vmnet-bridge <if>   [deprecated] Use --add-network bridged:<if>
  --install-all-packages  Install all packages from all_packages.zip
  --license-level <l>   Apply trial license: p1 (1 Gbps), p10 (10 Gbps), unlimited
  --license-account <a> MikroTik account email (or use MIKROTIK_WEB_ACCOUNT env var)
  --license-password <p> MikroTik password (or use MIKROTIK_WEB_PASSWORD env var)
  --device-mode <m>     Configure device-mode: rose|advanced|basic|home|auto|skip
  --device-mode-enable <f>  Set one or more device-mode flags to yes
  --device-mode-disable <f> Set one or more device-mode flags to no
  --no-device-mode      Skip device-mode provisioning entirely
  --timeout-extra <s>, -T <s>  Add extra seconds to the auto-computed boot timeout
  --dry-run             Print what would run without starting`);
			break;
		case "stop":
			console.log(`quickchr stop [<name>] [--all]

  <name>      Stop a specific running instance.
              Omit to see a list of running instances.
  --all       Stop all running instances.`);
			break;
		case "status":
			console.log(`quickchr status [<name>] [--json]

Alias for 'quickchr list'. See 'quickchr help list'.`);
			break;
		case "list":
			console.log(`quickchr list [<name>] [--json]

List all CHR instances or show detailed info for one.

  <name>      Show detailed status for a specific instance.
              Omit to list all instances in a table.
  --json      Output JSON (array of all machines, or object for one).

'quickchr status' is an alias for this command.`);
			break;
		case "doctor":
			console.log(`quickchr doctor

Check system prerequisites: QEMU binaries, firmware, acceleration,
sshpass (for package upload), qemu-img (for disk operations), data directories,
and cached images. Also reports the current shell and completion install status.`);
			break;
		case "logs":
			console.log(`quickchr logs <name> [options]

Tail the QEMU log for a CHR instance.

  <name>              Instance name (required).

Options:
  --follow, -f        Follow log output (tail -f style).
  --lines=<N>, -n <N> Number of lines to show (default: 50).`);
			break;
		case "completions":
			console.log(`quickchr completions [options]

Manage shell Tab completions for quickchr.

Options:
  --install             Install completions for the detected shell
  --install --shell <s> Install for a specific shell: bash, zsh, fish
  --uninstall           Remove completions (and undo rc-file changes)
  --status              Show install status for all shells
  --dry-run             Show what --install would do without writing anything

Machine name completions are always up to date — the scripts call quickchr
at completion time to list your machines.`);
			break;
		case "disk":
			console.log(`quickchr disk <name>

Show disk details (format, virtual size, actual size) for an instance.

  <name>      Show disks for a specific instance.
	              Omit to list all instances.

Install qemu-img to include virtual/actual size details in the output.`);
			break;
		case "snapshot":
		case "snap":
			console.log(`quickchr snapshot <name> [list|save|load|delete] [snapshot-name] [--json]

Manage VM snapshots on a CHR instance's qcow2 boot disk.

  <name>              Instance name (required).

Subcommands:
  list                List all snapshots (default if no subcommand given).
  save [snap-name]    Save a snapshot. Name auto-generated (ISO date) if omitted.
  load <snap-name>    Restore a snapshot. Machine must be running.
  delete <snap-name>  Delete a snapshot. Machine must be running.

Options:
  --json              Machine-readable JSON output.

Requires qcow2 boot disk (--boot-disk-format=qcow2 or --boot-size=<size>).
Alias: quickchr snap`);
			break;
		case "get":
			console.log(`quickchr get <name> [license|device-mode|admin] [--json]

Query live machine configuration from a running CHR instance.

  <name>           Name of a running CHR instance (required).
  license          Show license level, software ID, and deadline.
  device-mode      Show device-mode settings and enabled features.
  admin            Show users in the full (admin) group.

Options:
  --json           Structured JSON output.

When no group is given, all properties are shown.
The machine must be running to query live properties.`);
			break;
		case "set":
			console.log(`quickchr set <name> --license [options]

Set properties on a CHR instance.

  <name>              Name of a running CHR instance (required).

Flags:
  --license           Apply or renew a CHR trial license.

License options (used with --license):
  --level <level>     License level: p1 (1 Gbps), p10 (10 Gbps), unlimited (default: p1)
  --account <email>   MikroTik.com account email
  --password <pass>   MikroTik.com password

Credential resolution order:
  1. --account / --password flags
  2. MIKROTIK_WEB_ACCOUNT / MIKROTIK_WEB_PASSWORD environment variables
  3. OS native secret store (macOS Keychain / Linux Keyring)
  4. ~/.config/quickchr/credentials.json (fallback)`);
			break;
		case "license":
			console.log(`quickchr license <name> [options]

Deprecated. Use 'quickchr set <name> --license' instead.

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
		case "networks":
		case "net":
			showNetworksHelp();
			break;
		default:
			console.log(`No detailed help for '${command}'.`);
	}
}

main();
