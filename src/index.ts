/**
 * @tikoci/quickchr — CHR QEMU Manager CLI & Library
 *
 * Public API barrel export.
 */

// Main class
export { QuickCHR } from "./lib/quickchr.ts";

// Types
export type {
	Arch,
	Channel,
	ChrInstance,
	ChrPorts,
	DeviceModeOptions,
	DoctorCheck,
	DoctorResult,
	EfiFirmwarePaths,
	ExecOptions,
	ExecResult,
	ExecTransport,
	LicenseLevel,
	LicenseOptions,
	MachineConfig,
	MachineState,
	NetworkMode,
	PackageManager,
	PlatformInfo,
	PortMapping,
	ServiceName,
	StartOptions,
} from "./lib/types.ts";

export { QuickCHRError } from "./lib/types.ts";
export type { ErrorCode } from "./lib/types.ts";

// Auth utilities
export { resolveAuth } from "./lib/auth.ts";
export type { ResolvedAuth } from "./lib/auth.ts";

// Exec utilities
export { restExecute } from "./lib/exec.ts";

// License utilities
export { renewLicense, getLicenseInfo } from "./lib/license.ts";
export type { LicenseInfo } from "./lib/license.ts";

// Credential utilities (OS keychain)
export { getStoredCredentials, saveCredentials, deleteCredentials, credentialStorageLabel } from "./lib/credentials.ts";
export type { MikrotikCredentials } from "./lib/credentials.ts";

// Package utilities
export { downloadPackages, listAvailablePackages, downloadAndListPackages, installPackages, installAllPackages } from "./lib/packages.ts";
