/**
 * The provisioning window: when quickchr may run provisioning against a guest,
 * and what happens to an option that arrives after it has closed (#176).
 *
 * Provisioning expects the guest to hold RouterOS' default configuration — it
 * creates the first account, flips device-mode, installs packages onto a factory
 * image. Once the guest has booted, quickchr no longer knows what is in it, so the
 * window closes and a provisioning option can no longer be honoured blindly.
 *
 * What it must never do is accept the option and drop it. Until #176 every
 * provisioning option handed to `start()` on a machine past its first boot was
 * parsed, accepted and discarded — no warning, no error, normal boot time, and the
 * only way to find out was to read the value back. This module is the refusal:
 * an option either applies, is already satisfied, or is rejected by name with the
 * route that would work.
 */

import { getInstanceCredentials } from "./credentials.ts";
import {
	formatDeviceModeFlags,
	formatDeviceModeSelection,
	mergeDeviceModeOptions,
	type ResolvedDeviceModeOptions,
	resolveDeviceModeOptions,
	shouldApplyDeviceMode,
} from "./device-mode.ts";
import {
	type DeviceModeOptions,
	type LicenseInput,
	type MachineState,
	type ProvisioningStep,
	QuickCHRError,
} from "./types.ts";

/** The provisioning options `start()` accepts, in one shape. */
export interface ProvisioningRequest {
	installAllPackages?: boolean;
	packages?: string[];
	deviceMode?: DeviceModeOptions;
	user?: { name: string; password: string };
	disableAdmin?: boolean;
	license?: LicenseInput;
	secureLogin?: boolean;
}

/**
 * Is the guest still in the state provisioning expects?
 *
 * Deliberately **not** `!state.lastStartedAt`. That field is stamped immediately
 * after `spawnQemu`, before the guest is known to have booted and before
 * provisioning runs, so it answers "has QEMU been launched" — a different question
 * that happens to have the same answer most of the time. `clean()` is where the two
 * come apart: it replaces the disk with the factory image, so the guest genuinely is
 * fresh again, and gating on `lastStartedAt` left such a machine unable to be
 * provisioned ever again. `clean()` now clears both fields, and this reads both:
 * `provisioning` is the positive record, `lastStartedAt` the conservative fallback
 * for a guest that booted at least once and may hold configuration quickchr did not
 * put there — including machines created before `provisioning` existed.
 */
export function isProvisioningWindowOpen(state: MachineState): boolean {
	return !state.provisioning && !state.lastStartedAt;
}

/** One provisioning option that was asked for on a machine past its first boot. */
export interface ProvisioningAsk {
	step: ProvisioningStep;
	/** What was asked for, as the refusal should name it. */
	description: string;
	/** True when machine state already records this exact value, making it a no-op. */
	satisfied: boolean;
}

/** Normalized device-mode selection, order-independent, for comparing two requests. */
function deviceModeKey(options?: DeviceModeOptions): string {
	const resolved = resolveDeviceModeOptions(options);
	if (!shouldApplyDeviceMode(resolved)) return "";
	const features = Object.entries(resolved.features)
		.map(([name, value]) => `${name}=${value}`)
		.sort()
		.join(" ");
	return `mode=${resolved.mode ?? ""} ${features}`.trim();
}

function licenseLevelOf(license: LicenseInput): string {
	return (typeof license === "string" ? license : license.level) ?? "p1";
}

/** Did the request's password actually reach the guest? The persisted `state.user`
 *  carries a placeholder, never the password, so the comparison goes to the secret
 *  store. An unreadable store answers "no": a name match alone would let a password
 *  *change* pass as a no-op and be dropped in silence, which is the whole bug. */
function userCredentialMatches(state: MachineState, user: { name: string; password: string }): boolean {
	if (state.user?.name !== user.name) return false;
	try {
		const stored = getInstanceCredentials(state.name);
		return stored?.user === user.name && stored.password === user.password;
	} catch {
		return false;
	}
}

/**
 * Which provisioning steps this request actually asks for, and which of them already
 * landed on the current guest.
 *
 * **Satisfaction requires the step in `provisioning.steps`, not just a matching value
 * in `machine.json`.** Most of those fields — `installAllPackages`, `packages`,
 * `deviceMode`, `secureLogin` — are *desired config*, written at `add()` before
 * anything ran. Comparing against them alone would call a first boot that threw
 * half-way through "already applied" and drop the retry in silence, which is exactly
 * the failure this module exists to prevent. The step record is the only evidence that
 * a step ran, so it gates every row.
 *
 * Even then this is a claim about what quickchr applied, not about what is in the
 * guest — quickchr cannot read the guest without booting it, which is the thing being
 * decided. It exists so a caller that passes the same options on every start (the
 * shape a script naturally takes) is not punished for asking for what it already got.
 */
export function classifyProvisioningRequest(
	state: MachineState,
	request: ProvisioningRequest,
): ProvisioningAsk[] {
	const asks: ProvisioningAsk[] = [];
	const applied = new Set(state.provisioning?.steps ?? []);

	if (request.installAllPackages) {
		asks.push({
			step: "packages",
			description: "--install-all-packages",
			satisfied: applied.has("packages") && state.installAllPackages === true,
		});
	} else if (request.packages?.length) {
		const installed = new Set(state.packages ?? []);
		asks.push({
			step: "packages",
			description: `packages ${request.packages.join(", ")}`,
			satisfied: applied.has("packages") && request.packages.every((pkg) => installed.has(pkg)),
		});
	}

	const requestedDeviceMode = deviceModeKey(request.deviceMode);
	if (requestedDeviceMode) {
		asks.push({
			step: "deviceMode",
			description: `device-mode (${formatDeviceModeSelection(resolveDeviceModeOptions(request.deviceMode))})`,
			satisfied: applied.has("deviceMode") && deviceModeKey(state.deviceMode) === requestedDeviceMode,
		});
	}

	if (request.license) {
		const level = licenseLevelOf(request.license);
		asks.push({
			step: "license",
			description: `license (${level})`,
			satisfied: applied.has("license") && state.licenseLevel === level,
		});
	}

	if (request.user) {
		asks.push({
			step: "user",
			description: `user "${request.user.name}"`,
			satisfied: applied.has("user") && userCredentialMatches(state, request.user),
		});
	}

	if (request.disableAdmin) {
		asks.push({
			step: "disableAdmin",
			description: "--disable-admin",
			satisfied: applied.has("disableAdmin") && state.disableAdmin === true,
		});
	}

	if (request.secureLogin === true) {
		asks.push({
			step: "secureLogin",
			description: "managed login (--secure-login)",
			satisfied: applied.has("secureLogin") && state.secureLogin === true,
		});
	}

	return asks;
}

/**
 * The device-mode record to persist after a post-boot apply.
 *
 * Cumulative, because the guest is: a device-mode update moves only the settings it
 * names, so replacing the record with the request alone would leave `machine.json`
 * claiming an earlier feature had never been asked for while the guest still had it.
 *
 * **But it only carries forward what actually ran.** `state.deviceMode` is desired
 * config, written at `add()` before anything happens. A first boot that threw before
 * the device-mode step leaves that intent sitting in state having never reached the
 * guest — and folding it in here, then stamping `deviceMode` as applied, would make a
 * later `start` treat settings the guest never received as already satisfied and drop
 * them in silence. That is this module's own bug wearing a new hat, so it gets this
 * module's own rule: the step record is the only evidence that a step ran.
 */
export function appliedDeviceModeRecord(
	state: MachineState,
	applied: ResolvedDeviceModeOptions,
): DeviceModeOptions {
	const priorRan = state.provisioning?.steps.includes("deviceMode") ?? false;
	return mergeDeviceModeOptions(priorRan ? state.deviceMode : undefined, applied);
}

/** True when any step in this request would change something. */
export function hasProvisioningRequest(request: ProvisioningRequest): boolean {
	return !!(
		request.installAllPackages ||
		(request.packages?.length ?? 0) > 0 ||
		shouldApplyDeviceMode(resolveDeviceModeOptions(request.deviceMode)) ||
		request.license ||
		request.user ||
		request.disableAdmin ||
		request.secureLogin === true
	);
}

/** Where a step can still be applied once the window has closed. Every step has a
 *  route — `clean()` resets the disk and reopens the window for all of them — but
 *  the cheaper one is named first where it exists.
 *
 *  The `clean()` route says **repeat the original command**, not "start it again".
 *  A refused request is never persisted, and `clean()` clears `user` and
 *  `disableAdmin` because they are guest state, so a plain start after the reset
 *  would quietly drop exactly the options that were just refused. (`packages`,
 *  `deviceMode` and `secureLogin` are retained intent and would come back on their
 *  own — repeating the command is simply correct for all of them.)
 *
 *  It also takes the request, not just the step, because the route depends on what
 *  was asked for: `installPackage()` takes package names and cannot express
 *  `--install-all-packages`, so that one goes through `clean()` as well. */
function postBootRoute(ask: ProvisioningAsk, request: ProvisioningRequest, name: string): string {
	const replay = `quickchr clean ${name} (resets the disk), then repeat the original start command`;
	switch (ask.step) {
		case "license":
			return `quickchr set ${name} --license`;
		case "deviceMode":
			// Spelled out with the requested flags, because the route only helps if it
			// can be run as printed — and `set` takes the same flag names `start` does.
			return `quickchr set ${name} ${formatDeviceModeFlags(resolveDeviceModeOptions(request.deviceMode))} (power-cycles the machine)`;
		case "packages":
			// installPackage() has no install-all form — availablePackages() would have
			// to be enumerated first — so the honest route for that request is a reset.
			if (request.installAllPackages) return replay;
			return `instance.installPackage(${JSON.stringify(request.packages ?? [])}) from the library (no CLI route yet — tikoci/quickchr#24)`;
		default:
			return replay;
	}
}

/**
 * Refuse a provisioning option that arrived after the window closed.
 *
 * Returns the asks that are already satisfied, so the caller can say so rather than
 * staying silent about them; throws `PROVISIONING_WINDOW_CLOSED` naming every ask
 * that is not.
 */
export function assertProvisioningWindow(
	state: MachineState,
	request: ProvisioningRequest,
): ProvisioningAsk[] {
	if (isProvisioningWindowOpen(state)) return [];

	const asks = classifyProvisioningRequest(state, request);
	const pending = asks.filter((ask) => !ask.satisfied);
	if (pending.length === 0) return asks;

	const lines = pending.map(
		(ask) => `  ${ask.description} — apply it with: ${postBootRoute(ask, request, state.name)}`,
	);
	const satisfied = asks.filter((ask) => ask.satisfied);
	if (satisfied.length > 0) {
		lines.push(`  (already applied, unchanged: ${satisfied.map((a) => a.description).join("; ")})`);
	}

	throw new QuickCHRError(
		"PROVISIONING_WINDOW_CLOSED",
		`Machine "${state.name}" has already booted, so provisioning cannot run against it — ` +
		"the guest may no longer hold the default configuration provisioning expects.\n" +
		lines.join("\n") +
		`\nTo provision from scratch: quickchr clean ${state.name} resets the disk to the factory ` +
		"image and reopens the provisioning window — then repeat the command above, since a " +
		"refused request is not remembered.",
	);
}
