import { mock } from "bun:test";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { MachineState } from "../../../src/lib/types.ts";

/**
 * install-package worker — drives `installPackage()` against a mock guest.
 *
 * Module mocks (`packages.ts`) cannot live in the test process alongside the
 * other unit tests, so each scenario runs here, in a subprocess, and reports a
 * single JSON line on stdout. Invoked as:
 *
 *   bun install-package-worker.ts <scenario> <dataDir>
 *
 * Scenarios: `rejected-401`/`rejected-400` (the guest refuses the reboot),
 * `unknown-name` (nothing to install), `applied` (a clean install), and
 * `desired-unapplied` (a clean install on a machine whose add-time `ups` never
 * ran — `packages` set, the step not recorded).
 *
 * The mock guest answers REST on 127.0.0.1 (an ephemeral port, or a closed one
 * for `unknown-name`); SCP and the package download are mocked out. In the
 * install scenarios it reboots: the reboot POST drops, REST stays down long
 * enough for down-detection, then answers again. The machine
 * resolves non-admin credentials (`lab:lab-pass-1` with `disableAdmin`), so the
 * captured SCP arguments pin the credential fix as well as the reboot handling.
 */

const scenario = process.argv[2];
const dataDir = process.argv[3];
if (!scenario || !dataDir) throw new Error("usage: install-package-worker.ts <scenario> <dataDir>");
process.env.QUICKCHR_DATA_DIR = dataDir;
process.env.HOME = dataDir;

const extractDir = join(dataDir, "extract");
mkdirSync(extractDir, { recursive: true });
writeFileSync(join(extractDir, "container-7.24.4-x86.npk"), "fake npk");

const uploadCalls: Array<{ paths: string[]; sshPort: number; user: string; password: string }> = [];
const realPackages = await import("../../../src/lib/packages.ts");
mock.module("../../../src/lib/packages.ts", () => ({
	...realPackages,
	downloadPackages: async () => extractDir,
	uploadPackages: async (packagePaths: string[], scp: { sshPort: number; user: string; password: string }) => {
		uploadCalls.push({ paths: packagePaths, sshPort: scp.sshPort, user: scp.user, password: scp.password });
	},
}));

let server: ReturnType<typeof createServer> | undefined;
let httpPort: number;
if (scenario === "unknown-name") {
	// No guest at all: take an ephemeral port and close it, so the address is
	// (barring a race) connection-refused.
	const probe = createServer();
	await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
	httpPort = (probe.address() as AddressInfo).port;
	await new Promise<void>((resolve, reject) => probe.close((e) => (e ? reject(e) : resolve())));
} else {
	const rebootStatus = scenario === "rejected-401" ? 401 : 400;
	const reboots = scenario === "applied" || scenario === "desired-unapplied";
	let downUntil = 0;
	const guest = createServer((req, res) => {
		if (Date.now() < downUntil) {
			res.destroy();
		} else if (req.method === "POST" && req.url === "/rest/system/reboot" && reboots) {
			downUntil = Date.now() + 2500;
			res.destroy();
		} else if (req.method === "GET" && req.url === "/rest/system/resource") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ "board-name": "CHR", version: "7.24.4" }));
		} else if (req.method === "POST" && req.url === "/rest/system/reboot") {
			res.writeHead(rebootStatus, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ detail: "rejected by mock guest" }));
		} else {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end("{}");
		}
	});
	server = guest;
	await new Promise<void>((resolve) => guest.listen(0, "127.0.0.1", resolve));
	httpPort = (guest.address() as AddressInfo).port;
}

const name = "install-package-worker";
const machineDir = join(dataDir, "machines", name);
mkdirSync(machineDir, { recursive: true });
const state: MachineState = {
	name,
	version: "7.24.4",
	arch: "x86",
	cpu: 1,
	mem: 512,
	networks: [{ specifier: "user", id: "net0" }],
	ports: {
		http: { name: "http", host: httpPort, guest: 80, proto: "tcp" },
		ssh: { name: "ssh", host: 19202, guest: 22, proto: "tcp" },
	},
	packages: scenario === "desired-unapplied" ? ["ups"] : [],
	portBase: httpPort,
	excludePorts: [],
	extraPorts: [],
	createdAt: "2026-01-01T00:00:00.000Z",
	lastStartedAt: "2026-01-01T00:01:00.000Z",
	status: "running",
	// The worker's own pid, so `isMachineRunning` answers yes without QEMU.
	pid: process.pid,
	machineDir,
	user: { name: "lab", password: "lab-pass-1" },
	disableAdmin: true,
};
writeFileSync(join(machineDir, "machine.json"), `${JSON.stringify(state, null, "\t")}\n`);

const { QuickCHR } = await import("../../../src/lib/quickchr.ts");
const instance = QuickCHR.get(name);
if (!instance) throw new Error("seeded machine did not load");

const report: Record<string, unknown> = { scenario };
const started = Date.now();
try {
	const requested = scenario === "unknown-name" ? ["bogus"] : ["container"];
	report.returned = await instance.installPackage(requested);
} catch (error) {
	report.code = (error as { code?: string }).code ?? null;
	report.message = error instanceof Error ? error.message : String(error);
} finally {
	report.elapsedMs = Date.now() - started;
	const persisted = existsSync(join(machineDir, "machine.json"))
		? JSON.parse(readFileSync(join(machineDir, "machine.json"), "utf-8")) as MachineState
		: null;
	report.persistedPackages = persisted?.packages ?? null;
	report.persistedSteps = persisted?.provisioning?.steps ?? null;
	report.uploadCalls = uploadCalls;
	if (server) {
		const guest = server;
		await new Promise<void>((resolve) => guest.close(() => resolve()));
	}
	console.log(JSON.stringify(report));
}
