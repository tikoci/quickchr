/**
 * Interactive wizard for quickchr — walks user through starting a CHR.
 */

import type { Arch, Channel, StartOptions } from "../lib/types.ts";
import { CHANNELS, ARCHES, KNOWN_PACKAGES } from "../lib/types.ts";

/** Run the interactive wizard using @clack/prompts. */
export async function runWizard(): Promise<void> {
	// Dynamic import — only loaded when wizard is actually used
	const clack = await import("@clack/prompts");
	const { QuickCHR } = await import("../lib/quickchr.ts");
	const { formatPorts, bold } = await import("./format.ts");

	clack.intro("quickchr — MikroTik CHR Manager");

	// 1. Version source: channel or direct version
	const versionSource = await clack.select({
		message: "How do you want to pick the RouterOS version?",
		options: [
			{ value: "channel", label: "By channel (stable, long-term, testing, development)" },
			{ value: "version", label: "Enter a specific version number" },
		],
	});
	if (clack.isCancel(versionSource)) { clack.cancel("Cancelled."); process.exit(0); }

	let version: string | undefined;
	let channel: Channel | undefined;

	if (versionSource === "channel") {
		const ch = await clack.select({
			message: "Select channel:",
			options: CHANNELS.map((c) => ({ value: c, label: c })),
			initialValue: "stable" as Channel,
		});
		if (clack.isCancel(ch)) { clack.cancel("Cancelled."); process.exit(0); }
		channel = ch;
	} else {
		const ver = await clack.text({
			message: "Enter RouterOS version (e.g., 7.22.1):",
			validate: (v) => {
				if (!/^\d+\.\d+(\.\d+)?(beta\d+|rc\d+)?$/.test(v)) {
					return "Invalid version format";
				}
			},
		});
		if (clack.isCancel(ver)) { clack.cancel("Cancelled."); process.exit(0); }
		version = ver;
	}

	// 2. Architecture
	const hostArch = process.arch === "arm64" ? "arm64" : "x86";
	const arch = await clack.select({
		message: "Architecture:",
		options: ARCHES.map((a) => ({
			value: a,
			label: a,
			hint: a === hostArch ? "host native" : "emulated (slower)",
		})),
		initialValue: hostArch as Arch,
	});
	if (clack.isCancel(arch)) { clack.cancel("Cancelled."); process.exit(0); }

	// 3. Name
	const name = await clack.text({
		message: "Instance name (leave empty for auto):",
		placeholder: "auto-generated",
		defaultValue: "",
	});
	if (clack.isCancel(name)) { clack.cancel("Cancelled."); process.exit(0); }

	// 4. Resources
	const cpu = await clack.text({
		message: "CPU cores:",
		defaultValue: "1",
		validate: (v) => {
			const n = Number(v);
			if (!Number.isInteger(n) || n < 1 || n > 16) return "1-16";
		},
	});
	if (clack.isCancel(cpu)) { clack.cancel("Cancelled."); process.exit(0); }

	const mem = await clack.text({
		message: "Memory (MB):",
		defaultValue: "512",
		validate: (v) => {
			const n = Number(v);
			if (!Number.isInteger(n) || n < 128) return "Minimum 128 MB";
		},
	});
	if (clack.isCancel(mem)) { clack.cancel("Cancelled."); process.exit(0); }

	// 5. Extra packages
	const packages = await clack.multiselect({
		message: "Extra packages (space to toggle, enter to confirm):",
		options: KNOWN_PACKAGES.map((p) => ({ value: p, label: p })),
		required: false,
	});
	if (clack.isCancel(packages)) { clack.cancel("Cancelled."); process.exit(0); }

	// 6. User setup
	const addUser = await clack.confirm({
		message: "Create a custom user?",
		initialValue: false,
	});
	if (clack.isCancel(addUser)) { clack.cancel("Cancelled."); process.exit(0); }

	let user: { name: string; password: string } | undefined;
	let disableAdmin = false;

	if (addUser) {
		const userName = await clack.text({
			message: "Username:",
			validate: (v) => {
				if (!v.trim()) return "Required";
			},
		});
		if (clack.isCancel(userName)) { clack.cancel("Cancelled."); process.exit(0); }

		const userPass = await clack.password({
			message: "Password:",
		});
		if (clack.isCancel(userPass)) { clack.cancel("Cancelled."); process.exit(0); }

		user = { name: userName, password: userPass };

		const disable = await clack.confirm({
			message: "Disable the default admin user?",
			initialValue: false,
		});
		if (clack.isCancel(disable)) { clack.cancel("Cancelled."); process.exit(0); }
		disableAdmin = disable;
	}

	// 7. Background/foreground
	const background = await clack.select({
		message: "Run mode:",
		options: [
			{ value: true, label: "Background", hint: "returns immediately" },
			{ value: false, label: "Foreground", hint: "serial console on stdio" },
		],
		initialValue: true,
	});
	if (clack.isCancel(background)) { clack.cancel("Cancelled."); process.exit(0); }

	// 8. Confirm
	const opts: StartOptions = {
		version,
		channel,
		arch,
		name: name || undefined,
		cpu: Number(cpu),
		mem: Number(mem),
		packages: packages as string[],
		user,
		disableAdmin,
		background: background as boolean,
	};

	const confirm = await clack.confirm({
		message: `Start CHR ${version ?? `(${channel})`} ${arch}${(packages as string[]).length > 0 ? ` +${(packages as string[]).join(",")}` : ""}?`,
	});
	if (clack.isCancel(confirm) || !confirm) { clack.cancel("Cancelled."); process.exit(0); }

	// Launch
	const spinner = clack.spinner();
	spinner.start("Starting CHR...");

	try {
		const instance = await QuickCHR.start(opts);
		spinner.stop(`${bold(instance.name)} started`);

		clack.note(
			[
				`Version: ${instance.state.version} (${instance.state.arch})`,
				`Ports:   ${formatPorts(instance.state.ports)}`,
				`REST:    ${instance.restUrl}`,
				`SSH:     ssh admin@127.0.0.1 -p ${instance.sshPort}`,
			].join("\n"),
			"Instance details",
		);

		clack.outro("Done!");
	} catch (e: unknown) {
		spinner.stop("Failed");
		if (e instanceof Error) {
			clack.log.error(e.message);
		}
		process.exit(1);
	}
}
