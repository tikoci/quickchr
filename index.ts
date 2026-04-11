/**
 * @tikoci/quickchr — CHR QEMU Manager CLI & Library
 *
 * Public API barrel export.
 */

// Main class
export { QuickCHR } from "./src/lib/quickchr.ts";

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
} from "./src/lib/types.ts";

export { QuickCHRError } from "./src/lib/types.ts";
export type { ErrorCode } from "./src/lib/types.ts";

// MikroTik web account credential resolution (env vars → Bun.secrets → null).
// Exported so consumers can apply licenses via chr.license() without
// re-implementing the credential resolution chain.
export { getStoredCredentials } from "./src/lib/credentials.ts";
export type { MikrotikCredentials } from "./src/lib/credentials.ts";