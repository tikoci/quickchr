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
	DoctorCheck,
	DoctorResult,
	EfiFirmwarePaths,
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
