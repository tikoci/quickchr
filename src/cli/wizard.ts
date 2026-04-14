/**
 * Interactive wizard for quickchr — walks user through starting a CHR.
 */

import type { Arch, Channel, DeviceModeOptions, LicenseLevel, LicenseOptions, NetworkSpecifier, StartOptions } from "../lib/types.ts";
import { CHANNELS, ARCHES, knownPackagesForArch } from "../lib/types.ts";

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
		defaultValue: "256",
		validate: (v) => {
			const n = Number(v);
			if (!Number.isInteger(n) || n < 128) return "Minimum 128 MB";
		},
	});
	if (clack.isCancel(mem)) { clack.cancel("Cancelled."); process.exit(0); }

	// 4b. Disk configuration — requires qemu-img; skip gracefully if absent
	let bootSize: string | undefined;
	const extraDisks: string[] = [];

	const { findQemuImg, getQemuInstallHint } = await import("../lib/platform.ts");
	const { isValidDiskSize } = await import("../lib/disk.ts");
	const qemuImg = findQemuImg();

	if (!qemuImg) {
		clack.log.warn(`Disk features (boot resize, extra disks) require qemu-img. Run 'quickchr doctor' to confirm setup. ${getQemuInstallHint()}`);
	} else {
		const wantBootResize = await clack.confirm({
			message: "Resize the boot disk? (default is ~128 MB)",
			initialValue: false,
		});
		if (clack.isCancel(wantBootResize)) { clack.cancel("Cancelled."); process.exit(0); }

		if (wantBootResize) {
			const size = await clack.text({
				message: "Boot disk size (e.g., 512M, 1G, 2G):",
				validate: (v) => {
					if (!isValidDiskSize(v)) return "Size like 512M, 1G, or 2048";
				},
			});
			if (clack.isCancel(size)) { clack.cancel("Cancelled."); process.exit(0); }
			bootSize = size.trim();
		}

		const wantExtraDisks = await clack.confirm({
			message: "Add extra blank disks?",
			initialValue: false,
		});
		if (clack.isCancel(wantExtraDisks)) { clack.cancel("Cancelled."); process.exit(0); }

		if (wantExtraDisks) {
			let addMore = true;
			while (addMore) {
				const diskSize = await clack.text({
					message: `Extra disk ${extraDisks.length + 1} size (e.g., 64M, 512M, 1G):`,
					validate: (v) => {
						if (!isValidDiskSize(v)) return "Size like 64M, 512M, or 1G";
					},
				});
				if (clack.isCancel(diskSize)) { clack.cancel("Cancelled."); process.exit(0); }
				extraDisks.push(diskSize.trim());

				const another = await clack.confirm({
					message: "Add another disk?",
					initialValue: false,
				});
				if (clack.isCancel(another)) { clack.cancel("Cancelled."); process.exit(0); }
				addMore = another;
			}
		}
	}

	// 5. Extra packages — arch-specific list from 7.22.1 baseline.
	//    Special value "__all__" means install everything from all_packages.zip
	//    (useful for API schema generation — see restraml project).
	const pkgOptions = [
		{
			value: "__all__",
			label: "All packages",
			hint: "installs everything from all_packages.zip — best for API schema generation",
		},
		...knownPackagesForArch(arch as Arch).map((p) => ({ value: p, label: p })),
	];
	const pkgSelection = await clack.multiselect({
		message: "Extra packages (space to toggle, enter to confirm):",
		options: pkgOptions,
		required: false,
	});
	if (clack.isCancel(pkgSelection)) { clack.cancel("Cancelled."); process.exit(0); }

	const installAllPackages = (pkgSelection as string[]).includes("__all__");
	const packages = installAllPackages ? [] : (pkgSelection as string[]);

	// 6. Device mode — opt-in; CHR ships with mode=advanced by default.
	//    Device-mode provisioning requires a hard power-cycle, so only do it when the user
	//    actually needs features beyond what the default advanced mode provides (e.g. containers).
	//    See: https://help.mikrotik.com/docs/spaces/ROS/pages/93749258/Device-mode
	const wantDeviceMode = await clack.confirm({
		message: "Configure device-mode? (needed for containers and some restricted features)",
		initialValue: false,
	});
	if (clack.isCancel(wantDeviceMode)) { clack.cancel("Cancelled."); process.exit(0); }

	let deviceMode: DeviceModeOptions | undefined;
	if (wantDeviceMode) {
		const modeChoice = await clack.select({
			message: "Device-mode profile:",
			options: [
				{ value: "rose", label: "rose", hint: "includes container; recommended for most users" },
				{ value: "advanced", label: "advanced", hint: "CHR default — no container" },
				{ value: "basic", label: "basic" },
				{ value: "home", label: "home" },
			],
			initialValue: "rose",
		});
		if (clack.isCancel(modeChoice)) { clack.cancel("Cancelled."); process.exit(0); }

		deviceMode = { mode: modeChoice as string };

		// Offer extra features that are always disabled regardless of mode.
		// MikroTik docs: traffic-gen, partitions, routerboard are ❌ in all modes.
		// container is ❌ in all modes except rose.
		// We show the subset most useful for CHR users — CLI --device-mode-enable
		// handles the rest (partitions, install-any-version).
		const extraFeatures = modeChoice === "rose"
			? [
				{ value: "traffic-gen", label: "traffic-gen", hint: "/tool traffic-gen" },
				{ value: "routerboard", label: "routerboard", hint: "/system routerboard settings" },
			]
			: [
				{ value: "container", label: "container", hint: "/container — required for running containers" },
				{ value: "traffic-gen", label: "traffic-gen", hint: "/tool traffic-gen" },
				{ value: "routerboard", label: "routerboard", hint: "/system routerboard settings" },
			];

		const enableExtras = await clack.multiselect({
			message: `Enable extra features beyond ${modeChoice} mode? (space to toggle, enter to confirm)`,
			options: extraFeatures,
			required: false,
		});
		if (clack.isCancel(enableExtras)) { clack.cancel("Cancelled."); process.exit(0); }

		if ((enableExtras as string[]).length > 0) {
			deviceMode.enable = enableExtras as string[];
		}

		clack.log.info("Not all features shown. Use CLI --device-mode-enable for additional settings.");
	}

	// 7. User setup — quickchr managed login is the default; keeps admin:empty as opt-in
	const userChoice = await clack.select({
		message: "CHR login setup:",
		options: [
			{ value: "managed", label: "quickchr managed login", hint: "auto-generated password (recommended)" },
			{ value: "custom", label: "Custom user", hint: "you provide username + password" },
			{ value: "admin", label: "Keep admin with no password", hint: "less secure" },
		],
		initialValue: "managed",
	});
	if (clack.isCancel(userChoice)) { clack.cancel("Cancelled."); process.exit(0); }

	let user: { name: string; password: string } | undefined;
	let disableAdmin = false;
	let secureLogin: boolean | undefined;

	if (userChoice === "custom") {
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
	} else if (userChoice === "admin") {
		secureLogin = false;
	}
	// "managed" uses defaults (secureLogin=undefined → true)

	// 8. License — optional trial license via MikroTik.com account.
	//    Free CHR runs at 1 Mbps. A trial license unlocks 1/10 Gbps or unlimited.
	let license: LicenseOptions | undefined;

	const wantLicense = await clack.confirm({
		message: "Apply a CHR trial license? (unlocks speed above 1 Mbps)",
		initialValue: false,
	});
	if (clack.isCancel(wantLicense)) { clack.cancel("Cancelled."); process.exit(0); }

	if (wantLicense) {
		// Check for stored credentials first
		const { getStoredCredentials, saveCredentials, credentialStorageLabel } = await import("../lib/credentials.ts");
		const stored = await getStoredCredentials();

		let licAccount = "";
		let licPassword = "";

		if (stored) {
			const useStored = await clack.confirm({
				message: `Use saved credentials for ${stored.account} (${credentialStorageLabel()})?`,
				initialValue: true,
			});
			if (clack.isCancel(useStored)) { clack.cancel("Cancelled."); process.exit(0); }

			if (useStored) {
				licAccount = stored.account;
				licPassword = stored.password;
			} else {
				const acct = await clack.text({ message: "MikroTik account (email):", validate: (v) => v.trim() ? undefined : "Required" });
				if (clack.isCancel(acct)) { clack.cancel("Cancelled."); process.exit(0); }
				const pass = await clack.password({ message: "MikroTik password:" });
				if (clack.isCancel(pass)) { clack.cancel("Cancelled."); process.exit(0); }
				licAccount = acct;
				licPassword = pass;
				const saveCreds = await clack.confirm({ message: "Save these credentials?", initialValue: true });
				if (!clack.isCancel(saveCreds) && saveCreds) {
					await saveCredentials(licAccount, licPassword);
					clack.log.success(`Saved to ${credentialStorageLabel()}`);
				}
			}
		} else {
			const acct = await clack.text({ message: "MikroTik account (email):", validate: (v) => v.trim() ? undefined : "Required" });
			if (clack.isCancel(acct)) { clack.cancel("Cancelled."); process.exit(0); }
			const pass = await clack.password({ message: "MikroTik password:" });
			if (clack.isCancel(pass)) { clack.cancel("Cancelled."); process.exit(0); }
			licAccount = acct;
			licPassword = pass;
			const saveCreds = await clack.confirm({ message: "Save these credentials?", initialValue: true });
			if (!clack.isCancel(saveCreds) && saveCreds) {
				await saveCredentials(licAccount, licPassword);
				clack.log.success(`Saved to ${credentialStorageLabel()}`);
			}
		}

		const licLevel = await clack.select({
			message: "License level:",
			options: [
				{ value: "p1", label: "p1 — 1 Gbps", hint: "trial, 60 days" },
				{ value: "p10", label: "p10 — 10 Gbps", hint: "trial, 60 days" },
				{ value: "unlimited", label: "unlimited — no cap", hint: "trial, 60 days" },
			] as Array<{ value: LicenseLevel; label: string; hint: string }>,
			initialValue: "p1" as LicenseLevel,
		});
		if (clack.isCancel(licLevel)) { clack.cancel("Cancelled."); process.exit(0); }
			license = { account: licAccount, password: licPassword, level: licLevel };
	}

	// 9. Networks — build up NetworkSpecifier[] interactively
	const networks: NetworkSpecifier[] = [];
	const { detectPlatform, detectPhysicalInterfaces } = await import("../lib/platform.ts");
	const { parseNetworkSpecifier } = await import("../lib/network.ts");
	const platform = await detectPlatform();
	const isMacOS = platform.os === "darwin";
	const hasSocketVmnet = !!platform.socketVmnet;

	const wantNetwork = await clack.confirm({
		message: "Configure networking? (default is user-mode with port forwarding)",
		initialValue: false,
	});
	if (clack.isCancel(wantNetwork)) { clack.cancel("Cancelled."); process.exit(0); }

	if (wantNetwork) {
		let addMore = true;
		while (addMore) {
			const netOptions: Array<{ value: string; label: string; hint?: string }> = [
				{ value: "user", label: "user", hint: "port forwarding (default)" },
			];
			if (isMacOS && hasSocketVmnet) {
				netOptions.push({ value: "shared", label: "shared", hint: "rootless shared network via socket_vmnet" });
			}
			if (isMacOS) {
				netOptions.push({ value: "bridged", label: "bridged", hint: "bridge to a physical interface" });
			}
			netOptions.push({ value: "socket", label: "socket", hint: "named L2 link between VMs" });

			const netType = await clack.select({
				message: `Network ${networks.length + 1} type:`,
				options: netOptions,
			});
			if (clack.isCancel(netType)) { clack.cancel("Cancelled."); process.exit(0); }

			if (netType === "user") {
				if (networks.includes("user")) {
					clack.log.warn("Only one user-mode network is supported. Please choose a different type.");
					continue;
				}
				networks.push("user");
			} else if (netType === "shared") {
				if (networks.includes("shared")) {
					clack.log.warn("Only one shared network is supported.");
					continue;
				}
				networks.push("shared");
			} else if (netType === "bridged") {
				const ifaces = detectPhysicalInterfaces();
				if (ifaces.length === 0) {
					clack.log.warn("No physical interfaces detected. Enter device name manually.");
					const manualIface = await clack.text({
						message: "Interface device name (e.g. en0):",
						validate: (v) => { if (!v.trim()) return "Required"; },
					});
					if (clack.isCancel(manualIface)) { clack.cancel("Cancelled."); process.exit(0); }
					networks.push(parseNetworkSpecifier(`bridged:${manualIface}`));
				} else {
					const ifaceChoice = await clack.select({
						message: "Bridge to which interface?",
						options: ifaces.map((i) => ({
							value: i.device,
							label: `${i.device} — ${i.name}`,
							hint: i.alias ?? undefined,
						})),
					});
					if (clack.isCancel(ifaceChoice)) { clack.cancel("Cancelled."); process.exit(0); }
					networks.push(parseNetworkSpecifier(`bridged:${ifaceChoice}`));
				}
			} else if (netType === "socket") {
				const socketName = await clack.text({
					message: "Socket link name (VMs sharing a name get L2 connectivity):",
					validate: (v) => { if (!v.trim()) return "Required"; },
				});
				if (clack.isCancel(socketName)) { clack.cancel("Cancelled."); process.exit(0); }
				networks.push(parseNetworkSpecifier(`socket::${socketName}`));
			}

			const another = await clack.confirm({
				message: "Add another network interface?",
				initialValue: false,
			});
			if (clack.isCancel(another)) { clack.cancel("Cancelled."); process.exit(0); }
			addMore = another;
		}
	}

	// 10. Background/foreground
	const background = await clack.select({
		message: "Run mode:",
		options: [
			{ value: true, label: "Background", hint: "returns immediately" },
			{ value: false, label: "Foreground", hint: "serial console on stdio" },
		],
		initialValue: true,
	});
	if (clack.isCancel(background)) { clack.cancel("Cancelled."); process.exit(0); }

	// 11. Confirm
	const opts: StartOptions = {
		version,
		channel,
		arch,
		name: name || undefined,
		cpu: Number(cpu),
		mem: Number(mem),
		bootSize,
		extraDisks: extraDisks.length > 0 ? extraDisks : undefined,
		packages,
		installAllPackages,
		deviceMode,
		user,
		disableAdmin,
		secureLogin,
		license,
		networks: networks.length > 0 ? networks : undefined,
		background: background as boolean,
	};

	const pkgSummary = installAllPackages ? "all packages" : packages.length > 0 ? `+${packages.join(",")}` : "";
	const deviceModeSummary = deviceMode
		? ` (device-mode: ${deviceMode.mode}${deviceMode.enable?.length ? `, +${deviceMode.enable.join(",")}` : ""})`
		: "";
	const netSummary = networks.length > 0
		? ` (nets: ${networks.map((n) => typeof n === "string" ? n : n.type).join(",")})`
		: "";
	const confirm = await clack.confirm({
		message: `Start CHR ${version ?? `(${channel})`} ${arch}${pkgSummary ? ` ${pkgSummary}` : ""}${license ? ` (license: ${license.level})` : ""}${deviceModeSummary}${netSummary}?`,
	});
	if (clack.isCancel(confirm) || !confirm) { clack.cancel("Cancelled."); process.exit(0); }

	// Pre-warm image cache BEFORE starting any spinner so that download progress
	// prints cleanly without interleaving with spinner escape codes.
	const { resolveVersion } = await import("../lib/versions.ts");
	const { ensureCachedImage } = await import("../lib/images.ts");
	const resolvedVersion = opts.version ?? await resolveVersion(opts.channel ?? "stable");
	opts.version = resolvedVersion; // pin so QuickCHR.start doesn't resolve again

	try {
		await ensureCachedImage(resolvedVersion, arch as Arch);
	} catch (e: unknown) {
		clack.log.error(e instanceof Error ? e.message : String(e));
		process.exit(1);
	}

	// Foreground: skip spinner — QEMU takes over the terminal
	if (opts.background === false) {
		const b = (s: string) => `\x1b[1m${s}\x1b[0m`;
		const d = (s: string) => `\x1b[2m${s}\x1b[0m`;
		const c = (s: string) => `\x1b[36m${s}\x1b[0m`;

		const hasProvisioning = !!(
			opts.installAllPackages ||
			(opts.packages && opts.packages.length > 0) ||
			opts.user ||
			opts.disableAdmin ||
			opts.license ||
			opts.deviceMode
		);

		console.log();
		if (hasProvisioning) {
			console.log(b("  Foreground mode — serial console will attach after provisioning"));
		} else {
			console.log(b("  Foreground mode — QEMU serial console"));
		}
		console.log(`  ${c("Ctrl-A X")}  ${d("exit QEMU and return to shell")}`);
		console.log(`  ${c("Ctrl-A C")}  ${d("toggle QEMU monitor (type 'quit' to force-stop)")}`);
		console.log(`  ${c("Ctrl-A H")}  ${d("list all QEMU serial shortcuts")}`);
		console.log();
		if (hasProvisioning) {
			clack.log.info("Provisioning in progress — CHR will boot, configure, then hand over the console...");
		}
		// Brief pause so user can read tips before QEMU clears the screen
		await Bun.sleep(2000);
		try {
			const instance = await QuickCHR.start(opts);
			console.log(`\n${b(instance.name)} session ended`);
			console.log(`  ${d("Tip: resume session")}   quickchr start ${instance.name} --fg`);
			console.log(`  ${d("Tip: run background")}   quickchr start ${instance.name}`);
		} catch (e: unknown) {
			if (e instanceof Error) clack.log.error(e.message);
			process.exit(1);
		}
		clack.outro("Done!");
		return;
	}

	// Background: spin while CHR boots
	const spinner = clack.spinner();
	const spinMsg = installAllPackages ? "Booting CHR and installing all packages..." : "Booting CHR...";
	spinner.start(spinMsg);

	try {
		const instance = await QuickCHR.start(opts);
		spinner.stop(`${bold(instance.name)} started`);

		const { hasUserModeNetwork } = await import("../lib/network.ts");
		const userMode = hasUserModeNetwork(instance.state.networks);

		const details = [
			`Version: ${instance.state.version} (${instance.state.arch})`,
		];
		if (userMode) {
			details.push(
				`Ports:   ${formatPorts(instance.state.ports)}`,
				`REST:    ${instance.restUrl}`,
				`SSH:     ssh admin@127.0.0.1 -p ${instance.sshPort}`,
				`WinBox:  127.0.0.1:${instance.ports.winbox}`,
			);
		} else {
			details.push("Network: shared/bridged — VM has a DHCP address (no localhost port forwarding)");
			details.push("Tip:     Check IP via RouterOS console: /ip/dhcp-client/print");
		}

		clack.note(details.join("\n"), "Instance details");

		clack.outro("Done!");
	} catch (e: unknown) {
		spinner.stop("Failed");
		if (e instanceof Error) {
			clack.log.error(e.message);
		}
		process.exit(1);
	}
}
