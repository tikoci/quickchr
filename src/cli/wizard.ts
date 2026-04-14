/**
 * Interactive wizard for quickchr — walks user through starting a CHR.
 */

import type { Arch, Channel, DeviceModeOptions, LicenseLevel, LicenseOptions, NetworkSpecifier, StartOptions } from "../lib/types.ts";
import { CHANNELS, ARCHES, knownPackagesForArch } from "../lib/types.ts";

/** Run the interactive wizard using @clack/prompts. */
export async function runWizard(wizardOpts?: { firstRun?: boolean }): Promise<void> {
	// Dynamic import — only loaded when wizard is actually used
	const clack = await import("@clack/prompts");
	const { QuickCHR } = await import("../lib/quickchr.ts");
	const { formatPorts, bold } = await import("./format.ts");

	clack.intro("quickchr — MikroTik CHR Manager");
	if (wizardOpts?.firstRun) {
		clack.log.info("No machines found — let's create your first CHR instance.");
	}

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

	// 4. Resources — detect host capabilities and offer sensible choices
	const os = await import("node:os");
	const hostCpus = os.cpus().length;
	const hostMemMb = Math.round(os.totalmem() / 1024 / 1024);

	const cpuOptions: Array<{ value: string; label: string; hint?: string }> = [];
	cpuOptions.push({ value: "1", label: "1 CPU", hint: "recommended for most use" });
	if (hostCpus >= 2) cpuOptions.push({ value: "2", label: "2 CPUs" });
	if (hostCpus >= 4) cpuOptions.push({ value: "4", label: "4 CPUs" });
	if (hostCpus >= 8) cpuOptions.push({ value: "8", label: "8 CPUs" });
	if (hostCpus >= 16) cpuOptions.push({ value: "16", label: "16 CPUs" });

	const cpu = await clack.select({
		message: `CPU cores (host: ${hostCpus}):`,
		options: cpuOptions,
		initialValue: "1",
	});
	if (clack.isCancel(cpu)) { clack.cancel("Cancelled."); process.exit(0); }

	const memOptions: Array<{ value: string; label: string; hint?: string }> = [];
	memOptions.push({ value: "256", label: "256 MB", hint: "recommended minimum" });
	if (hostMemMb >= 1024) memOptions.push({ value: "512", label: "512 MB" });
	if (hostMemMb >= 2048) memOptions.push({ value: "1024", label: "1 GB" });
	if (hostMemMb >= 4096) memOptions.push({ value: "2048", label: "2 GB" });
	if (hostMemMb >= 8192) memOptions.push({ value: "4096", label: "4 GB" });

	const mem = await clack.select({
		message: `Memory (host: ${(hostMemMb / 1024).toFixed(0)} GB):`,
		options: memOptions,
		initialValue: "256",
	});
	if (clack.isCancel(mem)) { clack.cancel("Cancelled."); process.exit(0); }

	// 4b. Disk configuration — requires qemu-img; skip gracefully if absent
	let bootSize: string | undefined;
	let bootDiskFormat: "qcow2" | "raw" = "qcow2";
	const extraDisks: string[] = [];

	const { findQemuImg, getQemuInstallHint } = await import("../lib/platform.ts");
	const { isValidDiskSize } = await import("../lib/disk.ts");
	const qemuImg = findQemuImg();

	if (!qemuImg) {
		clack.log.warn(`Disk features (boot resize, extra disks) require qemu-img. Run 'quickchr doctor' to confirm setup. ${getQemuInstallHint()}`);
	} else {
		const diskFormatChoice = await clack.select({
			message: "Boot disk format:",
			options: [
				{ value: "qcow2", label: "qcow2 (recommended)", hint: "supports snapshots and resize" },
				{ value: "raw", label: "raw", hint: "no resize support" },
			],
			initialValue: "qcow2",
		});
		if (clack.isCancel(diskFormatChoice)) { clack.cancel("Cancelled."); process.exit(0); }
		bootDiskFormat = diskFormatChoice as "qcow2" | "raw";

		if (bootDiskFormat === "qcow2") {
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
		} else {
			clack.log.info("Raw boot disk selected — boot resize is disabled.");
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

	// ── 5. Networking ────────────────────────────────────────────────────
	// User/SLiRP is always included (localhost port forwarding for REST, SSH, etc.).
	// The wizard only asks about *additional* networks. To remove the user-mode
	// interface, use `quickchr start --no-network --add-network <spec>`.
	const networks: NetworkSpecifier[] = ["user"];
	const { detectPlatform, detectPhysicalInterfaces, isSocketVmnetDaemonRunning } = await import("../lib/platform.ts");
	const { parseNetworkSpecifier } = await import("../lib/network.ts");
	const platform = await detectPlatform();
	const isMacOS = platform.os === "darwin";
	const hasSocketVmnet = !!platform.socketVmnet;

	// Only offer additional networks if the platform has options beyond user-mode
	const hasNetworkOptions = isMacOS || process.platform === "linux";
	if (hasNetworkOptions) {
		const defaultYes = isMacOS && hasSocketVmnet;
		const wantExtra = await clack.confirm({
			message: "Add a real network? (the CHR already has localhost port forwarding for REST/SSH/WinBox)",
			initialValue: defaultYes,
		});
		if (clack.isCancel(wantExtra)) { clack.cancel("Cancelled."); process.exit(0); }

		if (wantExtra) {
			let addMore = true;
			while (addMore) {
				const netOptions: Array<{ value: string; label: string; hint?: string }> = [];
				if (isMacOS && hasSocketVmnet) {
					netOptions.push({ value: "shared", label: "shared", hint: "routable IP via socket_vmnet (pingable from host)" });
				}
				if (isMacOS) {
					netOptions.push({ value: "bridged", label: "bridged", hint: "bridge to a physical interface (e.g. Wi-Fi)" });
				}
				netOptions.push({ value: "socket", label: "socket", hint: "named L2 link between VMs" });

				const netType = await clack.select({
					message: "Network mode:",
					options: netOptions,
				});
				if (clack.isCancel(netType)) { clack.cancel("Cancelled."); process.exit(0); }

				if (netType === "shared") {
					if (networks.includes("shared")) {
						clack.log.warn("Only one shared network is supported.");
						continue;
					}
					// Block until socket_vmnet daemon is running — don't proceed with a known-bad config
					let daemonOk = false;
					while (!daemonOk) {
						const socketPath = platform.socketVmnet?.sharedSocket;
						if (socketPath && isSocketVmnetDaemonRunning(socketPath)) {
							daemonOk = true;
						} else {
							clack.log.warn("socket_vmnet daemon is not running.");
							const retry = await clack.select({
								message: "What would you like to do?",
								options: [
									{ value: "retry", label: "Check again", hint: "after running: sudo brew services start socket_vmnet" },
									{ value: "skip", label: "Skip shared network", hint: "continue without it" },
								],
							});
							if (clack.isCancel(retry)) { clack.cancel("Cancelled."); process.exit(0); }
							if (retry === "skip") break;
							// Refresh platform detection for retry
							const refreshed = await detectPlatform();
							Object.assign(platform, refreshed);
						}
					}
					if (daemonOk) {
						networks.push("shared");
					}
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
					message: "Add another network?",
					initialValue: false,
				});
				if (clack.isCancel(another)) { clack.cancel("Cancelled."); process.exit(0); }
				addMore = another;
			}
		}
	}

	// ── 6. Provisioning gate ─────────────────────────────────────────────
	// Everything after this point (packages, device-mode, login, license)
	// requires booting the CHR and connecting via REST API.
	let installAllPackages = false;
	let packages: string[] = [];
	let deviceMode: DeviceModeOptions | undefined;
	let user: { name: string; password: string } | undefined;
	let disableAdmin = false;
	let secureLogin: boolean | undefined;
	let license: LicenseOptions | undefined;

	const wantProvision = await clack.confirm({
		message: "Configure the router after boot? (packages, login, device-mode, license)",
		initialValue: true,
	});
	if (clack.isCancel(wantProvision)) { clack.cancel("Cancelled."); process.exit(0); }

	if (wantProvision) {
		// 6a. Extra packages
		const pkgChoice = await clack.select({
			message: "Install extra packages?",
			options: [
				{ value: "none", label: "No extra packages" },
				{ value: "all", label: "All packages", hint: "installs everything available" },
				{ value: "custom", label: "Choose packages" },
			],
			initialValue: "none",
		});
		if (clack.isCancel(pkgChoice)) { clack.cancel("Cancelled."); process.exit(0); }

		if (pkgChoice === "all") {
			installAllPackages = true;
		} else if (pkgChoice === "custom") {
			const pkgOptions = knownPackagesForArch(arch as Arch).map((p) => ({ value: p, label: p }));
			const pkgSelection = await clack.multiselect({
				message: "Select packages (space to toggle, enter to confirm):",
				options: pkgOptions,
				required: false,
			});
			if (clack.isCancel(pkgSelection)) { clack.cancel("Cancelled."); process.exit(0); }
			packages = pkgSelection as string[];
		}

		// 6b. Device mode
		const wantDeviceMode = await clack.confirm({
			message: "Configure device-mode? (needed for containers and some restricted features)",
			initialValue: false,
		});
		if (clack.isCancel(wantDeviceMode)) { clack.cancel("Cancelled."); process.exit(0); }

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

			// All features that are disabled regardless of mode.
			const extraFeatures = modeChoice === "rose"
				? [
					{ value: "traffic-gen", label: "traffic-gen", hint: "/tool traffic-gen" },
					{ value: "routerboard", label: "routerboard", hint: "/system routerboard settings" },
					{ value: "install-any-version", label: "install-any-version", hint: "allow downgrade/sidegrade" },
					{ value: "partitions", label: "partitions", hint: "/partitions support" },
				]
				: [
					{ value: "container", label: "container", hint: "/container — required for running containers" },
					{ value: "traffic-gen", label: "traffic-gen", hint: "/tool traffic-gen" },
					{ value: "routerboard", label: "routerboard", hint: "/system routerboard settings" },
					{ value: "install-any-version", label: "install-any-version", hint: "allow downgrade/sidegrade" },
					{ value: "partitions", label: "partitions", hint: "/partitions support" },
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
		}

		// 6c. User setup
		const userChoice = await clack.select({
			message: "CHR login setup:",
			options: [
				{ value: "managed", label: "quickchr managed login", hint: "auto-generated password, disables admin (recommended)" },
				{ value: "custom", label: "Custom user", hint: "you provide username + password" },
				{ value: "admin", label: "Keep admin with no password", hint: "less secure" },
			],
			initialValue: "managed",
		});
		if (clack.isCancel(userChoice)) { clack.cancel("Cancelled."); process.exit(0); }

		if (userChoice === "custom") {
			const userName = await clack.text({
				message: "Username:",
				validate: (v) => { if (!v.trim()) return "Required"; },
			});
			if (clack.isCancel(userName)) { clack.cancel("Cancelled."); process.exit(0); }

			const userPass = await clack.password({ message: "Password:" });
			if (clack.isCancel(userPass)) { clack.cancel("Cancelled."); process.exit(0); }

			user = { name: userName, password: userPass };
			disableAdmin = true;
		} else if (userChoice === "managed") {
			disableAdmin = true;
		} else {
			// "admin" — keep admin with no password
			secureLogin = false;
		}

		// 6d. License
		const wantLicense = await clack.confirm({
			message: "Apply a CHR trial license? (unlocks speed above 1 Mbps)",
			initialValue: false,
		});
		if (clack.isCancel(wantLicense)) { clack.cancel("Cancelled."); process.exit(0); }

		if (wantLicense) {
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
		bootDiskFormat,
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

	const pkgSummary = installAllPackages ? "all packages" : packages.length > 0 ? `pkgs: ${packages.join(", ")}` : "";
	const netSummary = networks.map((n) => typeof n === "string" ? n : n.type).join(", ");

	// Build a readable multi-line summary for the confirmation prompt
	const summaryParts = [`${version ?? channel} / ${arch}`];
	if (netSummary) summaryParts.push(`networks: ${netSummary}`);
	if (pkgSummary) summaryParts.push(pkgSummary);
	if (deviceMode) {
		const features = deviceMode.enable?.length ? ` +${deviceMode.enable.join(",")}` : "";
		summaryParts.push(`device-mode: ${deviceMode.mode}${features}`);
	}
	if (license) summaryParts.push(`license: ${license.level}`);
	if (user) summaryParts.push(`login: ${user.name}`);

	const confirm = await clack.confirm({
		message: `Start CHR? (${summaryParts.join(" · ")})`,
	});
	if (clack.isCancel(confirm) || !confirm) { clack.cancel("Cancelled."); process.exit(0); }

	// Pre-warm image cache BEFORE starting any spinner so that download progress
	// prints cleanly without interleaving with spinner escape codes.
	const { resolveVersion } = await import("../lib/versions.ts");
	const { ensureCachedImage } = await import("../lib/images.ts");
	const resolvedVersion = opts.version ?? await resolveVersion(opts.channel ?? "stable");
	opts.version = resolvedVersion; // pin so QuickCHR.start doesn't resolve again

	// Route pre-warm messages through clack so they render inside the prompt flow
	// (prevents "Using cached image:" from appearing as raw text outside the │ lines).
	const prewarmLogger = {
		status: (msg: string) => clack.log.step(msg.trim()),
		debug: () => {},
		warn: (msg: string) => clack.log.warn(msg),
	};

	try {
		await ensureCachedImage(resolvedVersion, arch as Arch, undefined, prewarmLogger);
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
		let cachePrewarmed = false;
		opts.onProgress = (msg: string) => {
			if (cachePrewarmed && msg.startsWith("Using cached image:")) return;
			spinner.message(msg);
		};
		cachePrewarmed = true;
		const instance = await QuickCHR.start(opts);
		spinner.stop(`${bold(instance.name)} started`);

		const { hasUserModeNetwork } = await import("../lib/network.ts");
		const userMode = hasUserModeNetwork(instance.state.networks);

		const details = [
			`Version: ${instance.state.version} (${instance.state.arch})`,
		];

		// Credentials — show username/password so user can actually log in
		const creds = instance.state.user;
		const loginUser = creds?.name ?? "admin";
		const loginPass = creds?.password && creds.password !== "(stored in secrets)" ? creds.password : "";

		if (userMode) {
			const authPrefix = loginPass ? `${loginUser}:${loginPass}@` : `${loginUser}@`;
			details.push(
				`Ports:   ${formatPorts(instance.state.ports)}`,
				`REST:    http://${authPrefix}127.0.0.1:${instance.ports.http}`,
				`SSH:     ssh ${loginUser}@127.0.0.1 -p ${instance.sshPort}`,
				`WinBox:  127.0.0.1:${instance.ports.winbox}`,
			);
		} else {
			details.push("Network: shared/bridged — VM has a DHCP address (no localhost port forwarding)");
			details.push("Tip:     Check IP via RouterOS console: /ip/dhcp-client/print");
		}

		if (creds?.name) {
			details.push("");
			details.push(`Login:   ${creds.name} / ${loginPass || "(no password)"}`);
			details.push(`Run:     quickchr exec ${instance.name} /system/resource/print`);
		}

		clack.note(details.join("\n"), "Instance details");

		// Offer to install shell completions if not already installed
		const { detectCurrentShell, shellBinary, completionStatusFor, installCompletions } = await import("../lib/completions.ts");
		const shellInfo = detectCurrentShell();
		const binary = shellBinary(shellInfo);
		if (shellInfo.supported) {
			const compStatus = completionStatusFor(binary as import("../lib/completions.ts").SupportedShell);
			if (!compStatus.installed) {
				const wantCompletions = await clack.confirm({
					message: `Install shell completions? (adds Tab completion for quickchr commands and machine names)`,
					initialValue: true,
				});
				if (!clack.isCancel(wantCompletions) && wantCompletions) {
					const result = installCompletions(binary as import("../lib/completions.ts").SupportedShell);
					clack.log.success(`Installed ${binary} completions: ${result.file}`);
					if (result.rcLine && result.rcFile) {
						clack.log.info(`Added to ${result.rcFile}: ${result.rcLine}`);
					}
					clack.log.info("Restart your shell or open a new terminal to activate.");
				}
			}
		}

		clack.outro("Done!");
	} catch (e: unknown) {
		spinner.stop("Failed", 1);
		if (e instanceof Error) {
			clack.log.error(e.message);
		}
		process.exit(1);
	}
}
