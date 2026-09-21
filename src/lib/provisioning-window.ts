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

import {
	formatDeviceModeSelection,
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
 * fresh again, and gating on `lastStartedAt` left such a machine permanently
 * unprovisionable. `clean()` now clears both fields, and this reads both:
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

/**
 * Which provisioning steps this request actually asks for, and which of them state
 * already records.
 *
 * "Satisfied" is a claim about `machine.json`, not about the guest — quickchr cannot
 * read the guest without booting it, which is the thing being decided. It exists so a
 * caller that passes the same options on every start (the shape a script naturally
 * takes) is not punished for asking for what it already got.
 */
export function classifyProvisioningRequest(
	state: MachineState,
	request: ProvisioningRequest,
): ProvisioningAsk[] {
	const asks: ProvisioningAsk[] = [];

	if (request.installAllPackages) {
		asks.push({
			step: "packages",
			description: "--install-all-packages",
			satisfied: state.installAllPackages === true,
		});
	} else if (request.packages?.length) {
		const installed = new Set(state.packages ?? []);
		asks.push({
			step: "packages",
			description: `packages ${request.packages.join(", ")}`,
			satisfied: request.packages.every((pkg) => installed.has(pkg)),
		});
	}

	const requestedDeviceMode = deviceModeKey(request.deviceMode);
	if (requestedDeviceMode) {
		asks.push({
			step: "deviceMode",
			description: `device-mode (${formatDeviceModeSelection(resolveDeviceModeOptions(request.deviceMode))})`,
			satisfied: deviceModeKey(state.deviceMode) === requestedDeviceMode,
		});
	}

	if (request.license) {
		const level = licenseLevelOf(request.license);
		asks.push({
			step: "license",
			description: `license (${level})`,
			satisfied: state.licenseLevel === level,
		});
	}

	if (request.user) {
		asks.push({
			step: "user",
			description: `user "${request.user.name}"`,
			satisfied: state.user?.name === request.user.name,
		});
	}

	if (request.disableAdmin) {
		asks.push({
			step: "disableAdmin",
			description: "--disable-admin",
			satisfied: state.disableAdmin === true,
		});
	}

	if (request.secureLogin === true) {
		asks.push({
			step: "secureLogin",
			description: "managed login (--secure-login)",
			satisfied: state.secureLogin === true,
		});
	}

	return asks;
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
 *  the cheaper one is named first where it exists. */
function postBootRoute(step: ProvisioningStep, name: string): string {
	switch (step) {
		case "license":
			return `quickchr set ${name} --license`;
		case "deviceMode":
			return `instance.setDeviceMode() from the library (no CLI route yet — tikoci/quickchr#176)`;
		case "packages":
			return `instance.installPackage() from the library (no CLI route yet — tikoci/quickchr#24)`;
		default:
			return `quickchr clean ${name} (resets the disk), then start it again`;
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
		(ask) => `  ${ask.description} — apply it with: ${postBootRoute(ask.step, state.name)}`,
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
		`\nTo provision from scratch: quickchr clean ${state.name} (resets the disk to the factory ` +
		"image and reopens the provisioning window), or recreate the machine.",
	);
}
