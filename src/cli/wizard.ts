/**
 * Interactive wizard for quickchr — walks user through starting a CHR.
 */

import type { Arch, Channel, LicenseLevel, LicenseOptions, StartOptions } from "../lib/types.ts";
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
		defaultValue: "512",
		validate: (v) => {
			const n = Number(v);
			if (!Number.isInteger(n) || n < 128) return "Minimum 128 MB";
		},
	});
	if (clack.isCancel(mem)) { clack.cancel("Cancelled."); process.exit(0); }

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

	// 7. License — optional trial license via MikroTik.com account.
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

	// 8. Background/foreground
	const background = await clack.select({
		message: "Run mode:",
		options: [
			{ value: true, label: "Background", hint: "returns immediately" },
			{ value: false, label: "Foreground", hint: "serial console on stdio" },
		],
		initialValue: true,
	});
	if (clack.isCancel(background)) { clack.cancel("Cancelled."); process.exit(0); }

	// 9. Confirm
	const opts: StartOptions = {
		version,
		channel,
		arch,
		name: name || undefined,
		cpu: Number(cpu),
		mem: Number(mem),
		packages,
		installAllPackages,
		user,
		disableAdmin,
		license,
		background: background as boolean,
	};

	const pkgSummary = installAllPackages ? "all packages" : packages.length > 0 ? `+${packages.join(",")}` : "";
	const confirm = await clack.confirm({
		message: `Start CHR ${version ?? `(${channel})`} ${arch}${pkgSummary ? ` ${pkgSummary}` : ""}${license ? ` (license: ${license.level})` : ""}?`,
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

		const hasProvisioning = !!(opts.installAllPackages || (opts.packages && opts.packages.length > 0) || opts.user || opts.disableAdmin || opts.license);

		console.log();
		console.log(b("  Foreground mode — QEMU serial console attached"));
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
			console.log(`\n${bold(instance.name)} session ended`);
			console.log(`  Tip: quickchr start ${instance.name}`);
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

		clack.note(
			[
				`Version: ${instance.state.version} (${instance.state.arch})`,
				`Ports:   ${formatPorts(instance.state.ports)}`,
				`REST:    ${instance.restUrl}`,
				`SSH:     ssh admin@127.0.0.1 -p ${instance.sshPort}`,
				`WinBox:  127.0.0.1:${instance.ports.winbox}`,
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
