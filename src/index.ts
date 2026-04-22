/**
 * @module @tikoci/quickchr
 *
 * CLI and library to download, launch, and manage MikroTik CHR virtual machines via QEMU.
 *
 * ## Quick start
 * ```ts
 * import { QuickCHR } from "@tikoci/quickchr";
 *
 * const chr = await QuickCHR.start({ channel: "stable" });
 * const info = await chr.rest("/system/resource");
 * console.log(info);
 * await chr.remove();
 * ```
 *
 * ## Key exports
 * - {@link QuickCHR} — Main class with static methods: `start()`, `add()`, `list()`, `get()`, `doctor()`
 * - {@link ChrInstance} — Runtime handle returned by `start()`: `stop()`, `remove()`, `rest()`, `exec()`, `upload()`, `download()`, `snapshot`, etc.
 * - {@link StartOptions} — All options for creating/starting a CHR instance
 * - {@link QuickCHRError} — Typed errors with codes like `MISSING_QEMU`, `TIMEOUT`, `EXEC_FAILED`
 *
 * @packageDocumentation
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
	NetworkConfig,
	NetworkMode,
	NetworkSpecifier,
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
	SnapshotInfo,
	StartOptions,
} from "./lib/types.ts";

export { QuickCHRError } from "./lib/types.ts";
export type { ErrorCode, HostInterface } from "./lib/types.ts";

// Interface detection
export { detectPhysicalInterfaces, resolveInterfaceAlias } from "./lib/platform.ts";

// Disk utilities
export { getDiskInfo, createQcow2Disk, listSnapshots, parseSnapshotList, formatSnapshotTable, formatDiskSize } from "./lib/disk.ts";
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

// Logging
export { createLogger } from "./lib/log.ts";
export type { ProgressLogger } from "./lib/log.ts";
