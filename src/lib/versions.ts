/**
 * RouterOS version resolution and download URL generation.
 */

import type { Arch, Channel } from "./types.ts";
import { CHANNELS, QuickCHRError } from "./types.ts";
import {
	fetchResilient,
	isConnectionFailure,
	isProxyConfiguredFor,
	isProxyRefusal,
	PROXY_ALLOWLIST_HINT,
	proxyRefusalHint,
} from "./net.ts";

const UPGRADE_BASE = "https://upgrade.mikrotik.com/routeros/NEWESTa7";
const DOWNLOAD_BASE = "https://download.mikrotik.com/routeros";
export const MIN_PROVISION_VERSION = "7.20.8";
export const PROVISIONING_FEATURE_LABEL = "post-boot provisioning";
export const PROVISIONING_FEATURE_SUMMARY = "packages, login/user changes, license, and device-mode";
export const PROVISIONING_BOOT_ONLY_SUMMARY = "Boot-only features such as disks, networks, and other QEMU-local setup remain available on older 7.x releases.";

export interface RouterOsCompatibilityRow {
	feature: string;
	minimumVersion: string;
	notes: string;
}

export const ROUTEROS_COMPATIBILITY_MATRIX: RouterOsCompatibilityRow[] = [
	{
		feature: "Boot / start / stop",
		minimumVersion: "any RouterOS 7.x",
		notes: "Boot-only path. QEMU-local only; no RouterOS mutations required.",
	},
	{
		feature: "Disk resize / extra disks / disk inspection",
		minimumVersion: "any RouterOS 7.x",
		notes: "Host-side qemu-img features. Requires qemu-img, not RouterOS provisioning support.",
	},
	{
		feature: "Network attachment / port mappings",
		minimumVersion: "any RouterOS 7.x",
		notes: "QEMU networking setup before or during boot.",
	},
	{
		feature: "Boot / start / stop on RouterOS 6",
		minimumVersion: "6.x (x86 only)",
		notes: "Best-effort boot-only target for v6→v7 migration testing (#182). CLI only; readiness is a native-API login; no provisioning, no REST operations.",
	},
	{
		feature: "Managed login, custom user, disable-admin",
		minimumVersion: MIN_PROVISION_VERSION,
		notes: "Mutates RouterOS after boot; handled as quickchr provisioning.",
	},
	{
		feature: "Package install / install-all-packages",
		minimumVersion: MIN_PROVISION_VERSION,
		notes: "Uploads packages and reboots after boot-time provisioning starts.",
	},
	{
		feature: "License apply / renew",
		minimumVersion: MIN_PROVISION_VERSION,
		notes: "RouterOS license workflow varies by version; quickchr validates this path on the baseline and newer.",
	},
	{
		feature: "Device-mode changes",
		minimumVersion: MIN_PROVISION_VERSION,
		notes: "Explicitly unsupported below the baseline even if older RouterOS builds expose some attributes.",
	},
];

export function provisioningSupportSummary(minimumVersion = MIN_PROVISION_VERSION): string {
	return `quickchr validates ${PROVISIONING_FEATURE_LABEL} on RouterOS ${minimumVersion}+ only; older 7.x remains boot-only.`;
}

export function provisioningSupportHint(minimumVersion = MIN_PROVISION_VERSION): string {
	return `Use --channel long-term or --version ${minimumVersion}+ for ${PROVISIONING_FEATURE_SUMMARY}, or keep the older version without provisioning options.`;
}

/** Attempts for a connection-class failure while resolving a channel version. */
export const VERSION_RESOLVE_MAX_ATTEMPTS = 3;

/** Backoff base: attempt N waits N × this before N+1. Mirrors `downloadToFile`. */
const VERSION_RESOLVE_RETRY_MS = 2000;

export interface ResolveVersionOptions {
	/** Attempts for connection-class failures. Defaults to {@link VERSION_RESOLVE_MAX_ATTEMPTS}. */
	maxAttempts?: number;
	/**
	 * Override the backoff base. A test lever, like `downloadToFile`'s `stallMs`:
	 * the real backoff spends 6 s of wall clock exhausting the default attempts.
	 * Production callers should not set it.
	 */
	retryDelayMs?: number;
}

/** A whole count of at least 1, or `fallback` for anything that isn't one. */
function positiveInt(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(1, Math.floor(value));
}

/** A finite, non-negative delay in ms, or `fallback` for anything that isn't one. */
function nonNegativeMs(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(0, value);
}

/**
 * Fetch the latest version for a given channel from MikroTik's upgrade server.
 *
 * Retried on a connection-class failure only — a transient refusal at
 * `upgrade.mikrotik.com` used to fail a whole `quickchr start`, since this sits
 * on the critical path of `start()`, the wizard and the CLI while only the
 * download path had a retry policy (#121). An HTTP answer is the server's verdict
 * and stays terminal on the first attempt: a 404 for a bad channel must fail fast.
 */
export async function resolveVersion(
	channel: Channel,
	opts: ResolveVersionOptions = {},
): Promise<string> {
	const url = `${UPGRADE_BASE}.${channel}`;
	// Parsed once, up front: the verdicts below name this host, and a parse
	// throwing inside a handler would mask the failure it reports.
	const hostname = new URL(url).hostname;
	// Sanitized, not just clamped: these are public options, and `Math.max(1, NaN)`
	// is NaN — the loop would never run, and the failure would read "all NaN
	// attempts: undefined" instead of doing anything.
	const maxAttempts = positiveInt(opts.maxAttempts, VERSION_RESOLVE_MAX_ATTEMPTS);
	const retryDelayMs = nonNegativeMs(opts.retryDelayMs, VERSION_RESOLVE_RETRY_MS);
	let lastError: unknown;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		let text: string;
		try {
			const response = await fetchResilient(url);
			if (!response.ok) {
				// A 403 through a configured proxy is the special case: on the
				// pinned Bun a proxy CONNECT refusal always throws, so the 403 came
				// from the origin through the tunnel — but on older Bun it can be
				// the proxy's own refusal, so the verdict hedges and keeps the
				// allowlist fix (#210). With no proxy configured a 403 is the
				// origin's verdict, like any other status.
				if (response.status === 403 && isProxyConfiguredFor(url)) {
					throw new QuickCHRError(
						"DOWNLOAD_FAILED",
						`Failed to fetch version for channel "${channel}": HTTP 403 via the egress proxy — the origin refused the request, or on Bun older than 1.4.4 the proxy refused CONNECT for ${hostname}`,
						PROXY_ALLOWLIST_HINT,
					);
				}
				// An HTTP answer is the server's verdict. Thrown as a QuickCHRError so
				// the catch below can tell it from a transport failure and let it out.
				throw new QuickCHRError(
					"DOWNLOAD_FAILED",
					`Failed to fetch version for channel "${channel}": HTTP ${response.status}`,
				);
			}
			// Inside the try: the body can fail *after* the headers arrive (a reset
			// mid-response), which is a transport failure like any other and must be
			// retried rather than escaping the loop unwrapped.
			text = await response.text();
		} catch (err) {
			// Only "could not reach the host at all" is retried. An HTTP verdict, an
			// abort (the caller gave up) or a real bug surfaces immediately.
			if (err instanceof QuickCHRError) throw err;
			// A proxy policy refusal is terminal, not retriable: no retry can clear
			// it — allowlist changes do not even apply to a running session — so
			// map it to a DOWNLOAD_FAILED that names the refused host (#210).
			// A 407 names the credentials fix; a proxy 5xx is not a refusal at
			// all and falls through to the connection-failure policy below.
			if (isProxyRefusal(err)) {
				throw new QuickCHRError(
					"DOWNLOAD_FAILED",
					`Failed to fetch version for channel "${channel}": the egress proxy refused ${hostname} (${err instanceof Error ? err.message : String(err)})`,
					proxyRefusalHint(err),
				);
			}
			if (!isConnectionFailure(err)) throw err;
			lastError = err;
			if (attempt < maxAttempts) await Bun.sleep(attempt * retryDelayMs);
			continue;
		}

		// Parsing is terminal: the server answered, and answering with something
		// unparseable is not a condition another attempt can improve.
		// Response format: "7.22.1 1774276515" (version + unix timestamp)
		const version = text.trim().split(/\s+/)[0]?.trim();
		if (!version || !isValidVersion(version)) {
			throw new QuickCHRError(
				"INVALID_VERSION",
				`Unexpected version format for channel "${channel}": "${text.trim()}"`,
			);
		}

		return version;
	}

	// Says "1 attempt" rather than "all 1 attempts" — these land in CI logs.
	const tries = maxAttempts === 1 ? "1 attempt" : `all ${maxAttempts} attempts`;
	throw new QuickCHRError(
		"DOWNLOAD_FAILED",
		`Failed to fetch version for channel "${channel}" on ${tries}: ` +
			`${lastError instanceof Error ? lastError.message : String(lastError)}`,
		`Check network access to ${hostname}, or pass an explicit --version to skip channel resolution.`,
	);
}

/** Fetch latest versions for all channels in parallel. */
export async function resolveAllVersions(
	opts: ResolveVersionOptions = {},
): Promise<Record<Channel, string>> {
	const results = await Promise.all(
		CHANNELS.map(async (ch) => [ch, await resolveVersion(ch, opts)] as const),
	);
	return Object.fromEntries(results) as Record<Channel, string>;
}

/** Validate a version string matches RouterOS format: MAJOR.MINOR[.PATCH][betaN|rcN] */
export function isValidVersion(version: string): boolean {
	return /^\d+\.\d+(\.\d+)?(beta\d+|rc\d+)?$/.test(version);
}

/**
 * RouterOS pre-release ordering rank. For a given X.Y, a beta is older than an rc,
 * which is older than the final release: beta < rc < release.
 */
const STAGE_RANK = { beta: 0, rc: 1, release: 2 } as const;

interface ParsedVersion {
	major: number;
	minor: number;
	patch: number;
	/** Maturity rank within X.Y: beta=0 < rc=1 < release=2. */
	stage: (typeof STAGE_RANK)[keyof typeof STAGE_RANK];
	/** The N in betaN/rcN (0 for release builds). */
	stageNum: number;
}

/** Parse a RouterOS version into numeric parts plus pre-release stage. */
function parseVersion(version: string): ParsedVersion {
	const match = version.match(/^(\d+)\.(\d+)(?:\.(\d+))?(?:(beta|rc)(\d+))?$/);
	if (!match) {
		throw new QuickCHRError("INVALID_VERSION", `Invalid version: ${version}`);
	}

	const stageName = match[4] as "beta" | "rc" | undefined;
	return {
		major: Number.parseInt(match[1] ?? "0", 10),
		minor: Number.parseInt(match[2] ?? "0", 10),
		patch: Number.parseInt(match[3] ?? "0", 10),
		stage: stageName ? STAGE_RANK[stageName] : STAGE_RANK.release,
		stageNum: match[5] ? Number.parseInt(match[5], 10) : 0,
	};
}

/** Parse a RouterOS version into numeric parts. beta/rc suffixes are ignored. */
export function parseVersionParts(version: string): [number, number, number] {
	const { major, minor, patch } = parseVersion(version);
	return [major, minor, patch];
}

/**
 * Compare two RouterOS versions semantically, including pre-release suffixes:
 * `7.24beta2` < `7.24rc1` < `7.24` < `7.24.1`. Returns <0, 0, or >0.
 */
export function compareRouterOsVersion(left: string, right: string): number {
	const a = parseVersion(left);
	const b = parseVersion(right);

	if (a.major !== b.major) return a.major - b.major;
	if (a.minor !== b.minor) return a.minor - b.minor;
	if (a.patch !== b.patch) return a.patch - b.patch;
	if (a.stage !== b.stage) return a.stage - b.stage;
	return a.stageNum - b.stageNum;
}

/** True if RouterOS version is supported for quickchr provisioning mutations. */
export function isProvisioningSupportedVersion(
	version: string,
	minimumVersion = MIN_PROVISION_VERSION,
): boolean {
	return compareRouterOsVersion(version, minimumVersion) >= 0;
}

/**
 * RouterOS 6 is a best-effort **boot-only** target (#182): quickchr downloads, boots and
 * tracks a 6.x CHR, and does nothing else to it. It exists so a tool driving a v6→v7
 * migration (tikoci/centrs#386) has a disposable 6.x router to test against — it is not
 * RouterOS 6 support. CLI only: the wizard does not offer it.
 *
 * 6.x has no REST API, so readiness is a native-API `/login` (see `readinessProbeFor()`
 * in qemu.ts), every provisioning step is refused, and anything that reads or writes
 * through REST fails with `REST_UNAVAILABLE` rather than timing out.
 */
export function isRouterOs6(version: string): boolean {
	return /^6\./.test(version);
}

export const ROUTEROS6_BOOT_ONLY =
	"RouterOS 6 is a best-effort boot-only target: quickchr downloads, boots and tracks it, and runs no provisioning or REST operations on it.";

/** MikroTik publishes RouterOS 6 CHR images for x86 only — `chr-6.49.23-arm64.img.zip`
 *  is a 404 (checked 2026-10-21). Refused before the download that would say so less
 *  clearly. */
export function assertRouterOs6Arch(version: string, arch: Arch): void {
	if (!isRouterOs6(version) || arch === "x86") return;
	throw new QuickCHRError(
		"INVALID_ARCH",
		`RouterOS ${version} has no ${arch} CHR image — MikroTik publishes RouterOS 6 CHR for x86 only. Pass --arch x86 (arch: "x86").`,
	);
}

/** Refuse an operation that needs REST on a guest that cannot have it. The message
 *  leads with "RouterOS 6: not available" so a caller scanning for the reason finds it
 *  first, and names the transport that does work. */
export function assertRestAvailable(machine: { name: string; version: string }, operation: string): void {
	if (!isRouterOs6(machine.version)) return;
	throw new QuickCHRError(
		"REST_UNAVAILABLE",
		`RouterOS 6: not available — ${operation} uses the REST API, which RouterOS ${machine.version} does not have. ` +
		`${ROUTEROS6_BOOT_ONLY} Reach it over the native API instead, e.g. ` +
		`centrs retrieve --quickchr ${machine.name} /system/resource --via native-api --no-validate ` +
		"(centrs validates against the 7.x command tree, so a 6.x read skips it)",
	);
}

/** Guard provisioning operations to reduce version-dependent failure modes. */
export function assertProvisioningSupportedVersion(
	version: string,
	operation: string,
	minimumVersion = MIN_PROVISION_VERSION,
): void {
	if (isRouterOs6(version)) {
		throw new QuickCHRError(
			"PROVISIONING_VERSION_UNSUPPORTED",
			`Cannot ${operation} on RouterOS ${version}. ${ROUTEROS6_BOOT_ONLY}`,
			`Drop the provisioning options to boot ${version} as it ships, or use RouterOS ${minimumVersion}+ for ${PROVISIONING_FEATURE_SUMMARY}.`,
		);
	}
	if (isProvisioningSupportedVersion(version, minimumVersion)) return;

	throw new QuickCHRError(
		"PROVISIONING_VERSION_UNSUPPORTED",
		`Cannot ${operation} on RouterOS ${version}. ${provisioningSupportSummary(minimumVersion)} ${PROVISIONING_BOOT_ONLY_SUMMARY}`,
		provisioningSupportHint(minimumVersion),
	);
}

/** Build the MikroTik download URL for a CHR .img.zip. */
export function chrDownloadUrl(version: string, arch: Arch = "x86"): string {
	const suffix = arch === "arm64" ? "-arm64" : "";
	return `${DOWNLOAD_BASE}/${version}/chr-${version}${suffix}.img.zip`;
}

/** Build the download URL for the all-packages zip. */
export function packagesDownloadUrl(version: string, arch: Arch): string {
	const mtArch = arch === "arm64" ? "arm64" : "x86";
	return `${DOWNLOAD_BASE}/${version}/all_packages-${mtArch}-${version}.zip`;
}

/** Build the expected image filename (without extension). */
export function chrImageBasename(version: string, arch: Arch): string {
	return arch === "arm64" ? `chr-${version}-arm64` : `chr-${version}`;
}

/** Generate a default machine name from version + arch, with incrementing suffix. */
export function generateMachineName(
	version: string,
	arch: Arch,
	existingNames: string[],
): string {
	const base = `${version}-${arch}`;
	let n = 1;
	while (existingNames.includes(`${base}-${n}`)) {
		n++;
	}
	return `${base}-${n}`;
}

// --- Channel recency ---

/** Channels that ship as finished releases vs. moving pre-release builds. */
const RELEASED_CHANNELS: readonly Channel[] = ["stable", "long-term"];

export type ChannelMaturity = "released" | "prerelease";

/** Classify a channel as a finished release line or a pre-release line. */
export function channelMaturity(channel: Channel): ChannelMaturity {
	return RELEASED_CHANNELS.includes(channel) ? "released" : "prerelease";
}

export interface ChannelStatus {
	channel: Channel;
	/** Resolved version for the channel, e.g. "7.24beta2". */
	version: string;
	maturity: ChannelMaturity;
	/** True if this channel's version is at or ahead of the current stable release. */
	aheadOfStable: boolean;
}

/**
 * Classify each channel by current recency (pure — no network).
 * `aheadOfStable` is always measured against the `stable` version in `versions`.
 */
export function classifyChannels(versions: Record<Channel, string>): ChannelStatus[] {
	const stableVersion = versions.stable;
	return CHANNELS.map((channel) => ({
		channel,
		version: versions[channel],
		maturity: channelMaturity(channel),
		aheadOfStable: compareRouterOsVersion(versions[channel], stableVersion) >= 0,
	}));
}

/**
 * Select the channels currently worth booting (pure — no network): every released
 * channel unconditionally, plus any pre-release channel at or ahead of the reference
 * channel's version (default reference: `stable`). This answers "what's worth booting,"
 * never "what must pass" — gate policy stays with the consumer.
 */
export function selectActiveChannels(
	versions: Record<Channel, string>,
	opts: { aheadOf?: Channel } = {},
): Channel[] {
	const referenceVersion = versions[opts.aheadOf ?? "stable"];
	return CHANNELS.filter((channel) => {
		if (channelMaturity(channel) === "released") return true;
		return compareRouterOsVersion(versions[channel], referenceVersion) >= 0;
	});
}

/** Fetch all channel versions and classify each by current recency. */
export async function resolveChannelStatuses(): Promise<ChannelStatus[]> {
	return classifyChannels(await resolveAllVersions());
}

/** Fetch all channel versions and return the channels currently worth booting. */
export async function resolveActiveChannels(opts: { aheadOf?: Channel } = {}): Promise<Channel[]> {
	return selectActiveChannels(await resolveAllVersions(), opts);
}
