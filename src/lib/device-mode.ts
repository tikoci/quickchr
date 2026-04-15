/**
 * RouterOS device-mode provisioning helpers.
 */

import type { DeviceModeOptions } from "./types.ts";
import { QuickCHRError } from "./types.ts";
import { restGet, restPost } from "./rest.ts";

export const KNOWN_DEVICE_MODES = ["home", "advanced", "basic", "rose"] as const;

export const KNOWN_DEVICE_MODE_FEATURES = [
	"scheduler",
	"socks",
	"fetch",
	"pptp",
	"l2tp",
	"bandwidth-test",
	"traffic-gen",
	"sniffer",
	"ipsec",
	"romon",
	"proxy",
	"hotspot",
	"smb",
	"email",
	"zerotier",
	"container",
	"install-any-version",
	"partitions",
	"routerboard",
] as const;

const KNOWN_MODE_SET = new Set<string>(KNOWN_DEVICE_MODES);
const KNOWN_FEATURE_SET = new Set<string>(KNOWN_DEVICE_MODE_FEATURES);
const SKIP_VALUES = new Set<string>(["skip", "none", "off", "disabled"]);

type DeviceModeBool = "yes" | "no";

export interface ResolvedDeviceModeOptions {
	skip: boolean;
	mode?: string;
	features: Record<string, DeviceModeBool>;
	warnings: string[];
}

export interface DeviceModeVerification {
	ok: boolean;
	mismatches: string[];
	expected: Record<string, string>;
	actual: Record<string, string>;
}

function norm(value: string): string {
	return value.trim().toLowerCase();
}

function normalizeFeatureList(list: string[] | undefined): string[] {
	if (!list) return [];
	const values = list
		.flatMap((item) => item.split(","))
		.map((item) => norm(item))
		.filter(Boolean);
	return [...new Set(values)];
}

function toYesNo(value: unknown): string {
	if (typeof value === "boolean") return value ? "yes" : "no";
	if (typeof value === "number") return value > 0 ? "yes" : "no";
	const normalized = String(value ?? "").trim().toLowerCase();
	if (["yes", "true", "on", "enabled", "1"].includes(normalized)) return "yes";
	if (["no", "false", "off", "disabled", "0"].includes(normalized)) return "no";
	return normalized;
}

export function resolveDeviceModeOptions(options?: DeviceModeOptions): ResolvedDeviceModeOptions {
	if (!options) {
		return { skip: true, features: {}, warnings: [] };
	}
	const warnings: string[] = [];
	const requestedMode = norm(options.mode ?? "auto");

	if (SKIP_VALUES.has(requestedMode)) {
		if ((options?.enable?.length ?? 0) > 0 || (options?.disable?.length ?? 0) > 0) {
			warnings.push("device-mode=skip ignores --device-mode-enable/disable values");
		}
		return { skip: true, features: {}, warnings };
	}

	let mode = requestedMode;
	if (mode === "enterprise") {
		mode = "advanced";
		warnings.push("device-mode mode 'enterprise' is legacy; using 'advanced'");
	}
	if (mode === "auto") {
		mode = "rose";
	}
	if (!KNOWN_MODE_SET.has(mode)) {
		warnings.push(`unknown device-mode '${mode}' (allowed; RouterOS will validate)`);
	}

	const enable = new Set(normalizeFeatureList(options?.enable));
	const disable = new Set(normalizeFeatureList(options?.disable));

	const conflicting: string[] = [];
	for (const feature of enable) {
		if (disable.has(feature)) {
			conflicting.push(feature);
			warnings.push(`device-mode feature '${feature}' set in both enable and disable; using disable`);
		}
	}
	for (const feature of conflicting) {
		enable.delete(feature);
	}

	const features: Record<string, DeviceModeBool> = {};
	for (const feature of enable) {
		if (!KNOWN_FEATURE_SET.has(feature)) {
			warnings.push(`unknown device-mode feature '${feature}' in enable list (allowed; RouterOS will validate)`);
		}
		features[feature] = "yes";
	}
	for (const feature of disable) {
		if (!KNOWN_FEATURE_SET.has(feature)) {
			warnings.push(`unknown device-mode feature '${feature}' in disable list (allowed; RouterOS will validate)`);
		}
		features[feature] = "no";
	}

	return {
		skip: false,
		mode,
		features,
		warnings,
	};
}

export function shouldApplyDeviceMode(options: ResolvedDeviceModeOptions): boolean {
	return !options.skip && !!(options.mode || Object.keys(options.features).length > 0);
}

export function formatDeviceModeSelection(options: ResolvedDeviceModeOptions): string {
	if (options.skip) return "skip";
	const parts: string[] = [];
	if (options.mode) parts.push(`mode=${options.mode}`);
	for (const [name, value] of Object.entries(options.features)) {
		parts.push(`${name}=${value}`);
	}
	return parts.join(" ");
}

/** Wait until the device-mode REST endpoint is reachable with default admin auth. */
export async function waitForDeviceModeApi(httpPort: number, timeoutMs: number = 60_000): Promise<void> {
	const auth = `Basic ${btoa("admin:")}`;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const { status } = await restGet(
				`http://127.0.0.1:${httpPort}/rest/system/device-mode`,
				auth,
				3000,
			);

			if (status >= 200 && status < 300) {
				return;
			}

			if (status === 401) {
				throw new QuickCHRError("PROCESS_FAILED", `Device-mode API auth failed: HTTP 401`);
			}
		} catch (error) {
			if (error instanceof QuickCHRError) {
				throw error;
			}
		}

		await Bun.sleep(1000);
	}

	throw new QuickCHRError("BOOT_TIMEOUT", `Device-mode API did not become ready on port ${httpPort}`);
}

/**
 * Fire the device-mode update request without awaiting its response.
 *
 * RouterOS blocks the HTTP connection waiting for power-cycle confirmation (up to 5 minutes).
 * The caller MUST kill the QEMU process while this request is pending to confirm the change.
 * The connection error (ECONNRESET) that results when QEMU exits is expected — suppress it.
 *
 * Uses restPost (node:http + agent:false) to bypass Bun's connection pool.
 * The 300s timeout is a safety limit — the caller is expected to kill QEMU well before then.
 */
export function startDeviceModeUpdate(httpPort: number, options: ResolvedDeviceModeOptions): Promise<{ status: number; body: string }> {
	if (!shouldApplyDeviceMode(options)) {
		return Promise.resolve({ status: 200, body: "" });
	}

	const payload: Record<string, string> = {};
	if (options.mode) payload.mode = options.mode;
	for (const [name, value] of Object.entries(options.features)) {
		payload[name] = value;
	}

	const auth = `Basic ${btoa("admin:")}`;
	return restPost(
		`http://127.0.0.1:${httpPort}/rest/system/device-mode/update`,
		auth,
		payload,
		300_000, // Safety timeout — QEMU kill should resolve this first
	);
}

export async function readDeviceMode(httpPort: number): Promise<Record<string, string>> {
	const auth = `Basic ${btoa("admin:")}`;
	const { status, body } = await restGet(
		`http://127.0.0.1:${httpPort}/rest/system/device-mode`,
		auth,
		30_000,
	);

	if (status < 200 || status >= 300) {
		throw new QuickCHRError(
			"PROCESS_FAILED",
			`Failed to read device-mode: HTTP ${status} - ${body}`,
		);
	}

	let data: unknown;
	try { data = JSON.parse(body); } catch {
		throw new QuickCHRError("PROCESS_FAILED", "Invalid /system/device-mode REST response (not JSON)");
	}

	const record = Array.isArray(data) ? data[0] : data;
	if (!record || typeof record !== "object") {
		throw new QuickCHRError("PROCESS_FAILED", "Invalid /system/device-mode REST response");
	}

	// Guard: /system/resource data instead of device-mode — REST startup race.
	if ("board-name" in (record as Record<string, unknown>) || "architecture-name" in (record as Record<string, unknown>)) {
		throw new QuickCHRError(
			"PROCESS_FAILED",
			"GET /rest/system/device-mode returned system resource data — REST API not fully initialized",
		);
	}

	const normalized: Record<string, string> = {};
	for (const [key, value] of Object.entries(record)) {
		normalized[norm(key)] = toYesNo(value);
	}
	return normalized;
}

export function verifyDeviceMode(
	options: ResolvedDeviceModeOptions,
	actual: Record<string, string>,
): DeviceModeVerification {
	const expected: Record<string, string> = {};
	if (options.mode) {
		expected.mode = norm(options.mode);
	}
	for (const [name, value] of Object.entries(options.features)) {
		expected[norm(name)] = value;
	}

	const mismatches: string[] = [];
	for (const [key, expectedValue] of Object.entries(expected)) {
		const actualValue = actual[key];
		if (!actualValue) {
			mismatches.push(`${key}: expected=${expectedValue}, actual=(missing)`);
			continue;
		}
		const actualNorm = key === "mode" ? norm(actualValue) : toYesNo(actualValue);
		if (actualNorm !== expectedValue) {
			mismatches.push(`${key}: expected=${expectedValue}, actual=${actualNorm}`);
		}
	}

	return {
		ok: mismatches.length === 0,
		mismatches,
		expected,
		actual,
	};
}
