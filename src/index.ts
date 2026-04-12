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
	BootDiskFormat,
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
	ChrLoadSample,
	LicenseInput,
	LicenseLevel,
	LicenseOptions,
	MachineConfig,
	MachineState,
	NetworkMode,
	PackageManager,
	PlatformInfo,
	PortMapping,
	QgaCommand,
	QgaExecResult,
	QgaFsFreezeStatus,
	QgaNetworkInterface,
	QgaNetworkIpAddress,
	QgaOsInfo,
	QgaTimezone,
	ServiceName,
	StartOptions,
} from "./lib/types.ts";

export { QuickCHRError } from "./lib/types.ts";
export type { ErrorCode } from "./lib/types.ts";

// Disk utilities
export { getDiskInfo, createQcow2Disk } from "./lib/disk.ts";
export type { DiskInfo } from "./lib/disk.ts";

// Auth utilities
export { resolveAuth } from "./lib/auth.ts";
export type { ResolvedAuth } from "./lib/auth.ts";

// Exec utilities
export { restExecute } from "./lib/exec.ts";

// QGA (QEMU Guest Agent) utilities
export {
	qgaExec,
	qgaProbe,
	qgaSync,
	qgaInfo,
	qgaPing,
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
} from "./lib/qga.ts";
export type { QgaCommandInfo } from "./lib/qga.ts";

// Console exec utilities
export { consoleExec, isConsoleReady, stripAnsi } from "./lib/console.ts";

// Channel utilities
export { isQgaReady } from "./lib/channels.ts";

// License utilities
export { renewLicense, getLicenseInfo } from "./lib/license.ts";
export type { LicenseInfo } from "./lib/license.ts";

// Credential utilities
export { getStoredCredentials, saveCredentials, deleteCredentials, credentialStorageLabel } from "./lib/credentials.ts";
export { getInstanceCredentials, saveInstanceCredentials, deleteInstanceCredentials } from "./lib/credentials.ts";
export type { MikrotikCredentials, InstanceCredentials } from "./lib/credentials.ts";

// Package utilities
export { downloadPackages, listAvailablePackages, downloadAndListPackages, installPackages, installAllPackages } from "./lib/packages.ts";
