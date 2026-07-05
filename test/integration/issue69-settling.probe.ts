import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { arch as osArch, cpus, freemem, homedir, platform as osPlatform, release, totalmem } from "node:os";
import { join } from "node:path";
import { accelTimeoutFactor, detectAccel, findQemuBinary, getQemuVersion, isCrossArchEmulation } from "../../src/lib/platform.ts";
import { createUser } from "../../src/lib/provision.ts";
import { restGet } from "../../src/lib/rest.ts";
import type { Arch, ChrInstance } from "../../src/lib/types.ts";
import { imageTarget } from "./image-target.ts";

/**
 * Issue #69 investigation probe.
 *
 * This file intentionally uses `.probe.ts` instead of `.test.ts` so the normal
 * integration sweep does not run it. Dispatch it by name with integration.yml:
 *
 *   gh workflow run integration.yml --ref <branch> \
 *     -f platforms=linux-arm64 -f test-filter=issue69-settling.probe.ts \
 *     -f run-examples=false
 */

const SKIP = !process.env.QUICKCHR_INTEGRATION;
const OUTPUT_PATH = process.env.QUICKCHR_ISSUE69_OUT ??
	join(homedir(), `issue69-settling-${new Date().toISOString().replace(/[:.]/g, "-")}.ndjson`);

interface ErrorInfo {
	name: string;
	message: string;
	code?: string;
	errno?: number;
	syscall?: string;
}

interface RestProbeResult {
	label: string;
	path: string;
	authUser: string;
	attempt: number;
	ok: boolean;
	durationMs: number;
	status?: number;
	bodyPreview?: string;
	error?: ErrorInfo;
}

type ProbeRecord = Record<string, unknown>;

function emit(record: ProbeRecord): void {
	const line = JSON.stringify({ ts: new Date().toISOString(), ...record });
	console.log(`[issue69] ${line}`);
	appendFileSync(OUTPUT_PATH, line + "\n");
}

function errorInfo(error: unknown): ErrorInfo {
	const maybe = error as {
		name?: unknown;
		message?: unknown;
		code?: unknown;
		errno?: unknown;
		syscall?: unknown;
	};

	return {
		name: typeof maybe.name === "string" ? maybe.name : "Error",
		message: typeof maybe.message === "string" ? maybe.message : String(error),
		code: typeof maybe.code === "string" ? maybe.code : undefined,
		errno: typeof maybe.errno === "number" ? maybe.errno : undefined,
		syscall: typeof maybe.syscall === "string" ? maybe.syscall : undefined,
	};
}

function preview(text: string, max = 600): string {
	return text.length <= max ? text : `${text.slice(0, max)}...[truncated ${text.length - max} bytes]`;
}

function basicAuth(user: string, password: string): string {
	return `Basic ${btoa(`${user}:${password}`)}`;
}

function targetArch(): Arch {
	const raw = process.env.QUICKCHR_ISSUE69_ARCH?.trim().toLowerCase();
	if (raw === "arm64" || raw === "aarch64") return "arm64";
	if (raw === "x86" || raw === "x64" || raw === "amd64" || raw === "x86_64") return "x86";
	return process.arch === "arm64" ? "arm64" : "x86";
}

function iterationCount(): number {
	const raw = Number.parseInt(process.env.QUICKCHR_ISSUE69_ITERATIONS ?? "", 10);
	if (Number.isFinite(raw) && raw > 0) return raw;
	return process.env.CI ? 8 : 5;
}

function memoryMiB(bytes: number): number {
	return Math.round(bytes / 1024 / 1024);
}

function qemuVersion(arch: Arch): string | null {
	const binary = findQemuBinary(arch);
	return binary ? (getQemuVersion(binary) ?? "unknown") : null;
}

async function platformMeta(arch: Arch): Promise<Record<string, unknown>> {
	const accel = await detectAccel(arch);
	const crossArch = isCrossArchEmulation(arch);
	const hostCpus = cpus();
	return {
		process: {
			platform: process.platform,
			arch: process.arch,
			bun: Bun.version,
			ci: Boolean(process.env.CI),
			githubRunId: process.env.GITHUB_RUN_ID ?? null,
			githubJob: process.env.GITHUB_JOB ?? null,
		},
		os: {
			platform: osPlatform(),
			arch: osArch(),
			release: release(),
			cpuCount: hostCpus.length,
			cpuModel: hostCpus[0]?.model ?? "unknown",
			totalMemMiB: memoryMiB(totalmem()),
			freeMemMiB: memoryMiB(freemem()),
		},
		target: {
			routeros: process.env.QUICKCHR_TEST_TARGET?.trim() || "stable",
			imageTarget: imageTarget(),
			arch,
			accel,
			crossArch,
			timeoutFactor: accelTimeoutFactor(accel, crossArch),
		},
		qemu: {
			x86: qemuVersion("x86"),
			arm64: qemuVersion("arm64"),
		},
	};
}

async function cleanupMachine(name: string): Promise<void> {
	const { QuickCHR } = await import("../../src/lib/quickchr.ts");
	const existing = QuickCHR.get(name);
	if (!existing) return;
	try { await existing.stop(); } catch { /* ignore */ }
	try { await existing.remove(); } catch { /* ignore */ }
}

function tcpProbe(port: number, timeoutMs = 1000): Promise<Record<string, unknown>> {
	return new Promise((resolve) => {
		const started = Date.now();
		const socket = createConnection({ host: "127.0.0.1", port });
		let done = false;

		function finish(result: Record<string, unknown>): void {
			if (done) return;
			done = true;
			clearTimeout(timer);
			socket.destroy();
			resolve({ ...result, durationMs: Date.now() - started });
		}

		const timer = setTimeout(() => finish({ state: "timeout" }), timeoutMs);
		socket.once("connect", () => finish({ state: "connect" }));
		socket.once("error", (error) => finish({ state: "error", error: errorInfo(error) }));
	});
}

function startTcpProbeLoop(
	iteration: number,
	ports: Record<string, number>,
	intervalMs: number,
): { stop: () => Promise<void> } {
	let stopped = false;
	const loop = (async () => {
		while (!stopped) {
			const sampleStarted = Date.now();
			const entries = await Promise.all(
				Object.entries(ports).map(async ([name, port]) => [name, await tcpProbe(port)] as const),
			);
			emit({
				phase: "tcp-probe",
				iteration,
				elapsedMs: Date.now() - sampleStarted,
				ports: Object.fromEntries(entries),
			});

			const sleepMs = intervalMs - (Date.now() - sampleStarted);
			if (sleepMs > 0) await Bun.sleep(sleepMs);
		}
	})();

	return {
		async stop(): Promise<void> {
			stopped = true;
			await loop;
		},
	};
}

async function restProbe(
	baseUrl: string,
	auth: string,
	label: string,
	path: string,
	authUser: string,
	attempt: number,
): Promise<RestProbeResult> {
	const started = Date.now();
	try {
		const response = await restGet(`${baseUrl}/${path}`, auth, 10_000);
		const ok = response.status >= 200 && response.status < 300;
		return {
			label,
			path,
			authUser,
			attempt,
			ok,
			durationMs: Date.now() - started,
			status: response.status,
			bodyPreview: preview(response.body),
		};
	} catch (error) {
		return {
			label,
			path,
			authUser,
			attempt,
			ok: false,
			durationMs: Date.now() - started,
			error: errorInfo(error),
		};
	}
}

function isProblem(result: RestProbeResult): boolean {
	return !result.ok || result.status == null || result.status < 200 || result.status >= 300 || result.error != null;
}

function firstAttemptHasProblem(results: RestProbeResult[]): boolean {
	const first = results[0];
	return first == null || isProblem(first);
}

async function restProbeWithImmediateResetRetry(
	iteration: number,
	baseUrl: string,
	auth: string,
	label: string,
	path: string,
	authUser: string,
): Promise<RestProbeResult[]> {
	const first = await restProbe(baseUrl, auth, label, path, authUser, 1);
	emit({ phase: "rest-probe", iteration, ...first });
	const results = [first];

	if (first.error?.code === "ECONNRESET") {
		const retry = await restProbe(baseUrl, auth, label, path, authUser, 2);
		emit({ phase: "rest-probe", iteration, retryReason: "immediate-after-ECONNRESET", ...retry });
		results.push(retry);
	}

	return results;
}

async function collectConsoleDiagnostics(iteration: number, instance: ChrInstance): Promise<void> {
	const commands = [
		["system-resource", "/system/resource/print"],
		["ip-service", "/ip/service/print detail without-paging"],
		["users", "/user/print detail without-paging"],
		["interfaces", "/interface/print detail without-paging"],
		["files", "/file/print detail without-paging"],
		["log", "/log/print detail without-paging"],
	] as const;

	for (const [label, command] of commands) {
		const started = Date.now();
		try {
			const result = await instance.exec(command, {
				via: "console",
				user: "admin",
				password: "",
				timeout: 45_000,
			});
			emit({
				phase: "console-diagnostic",
				iteration,
				label,
				durationMs: Date.now() - started,
				output: preview(result.output, 12_000),
			});
		} catch (error) {
			emit({
				phase: "console-diagnostic",
				iteration,
				label,
				durationMs: Date.now() - started,
				error: errorInfo(error),
			});
		}
	}
}

function instanceMeta(instance: ChrInstance): Record<string, unknown> {
	return {
		name: instance.name,
		version: instance.state.version,
		arch: instance.state.arch,
		cpu: instance.state.cpu,
		mem: instance.state.mem,
		lastAccel: instance.state.lastAccel ?? null,
		lastBootMs: instance.state.lastBootMs ?? null,
		portBase: instance.portBase,
		ports: {
			http: instance.ports.http,
			api: instance.ports.api,
			ssh: instance.ports.ssh,
			winbox: instance.ports.winbox,
		},
		machineDir: instance.state.machineDir,
	};
}

function collectMachineFileDiagnostics(iteration: number, instance: ChrInstance): void {
	const files = [
		["machine-json", join(instance.state.machineDir, "machine.json")],
		["qemu-log", join(instance.state.machineDir, "qemu.log")],
	] as const;

	for (const [label, path] of files) {
		try {
			if (!existsSync(path)) continue;
			const contents = readFileSync(path, "utf-8");
			emit({
				phase: "machine-file",
				iteration,
				label,
				path,
				sizeBytes: contents.length,
				tail: preview(contents.slice(-12_000), 12_000),
			});
		} catch (error) {
			emit({ phase: "machine-file", iteration, label, path, error: errorInfo(error) });
		}
	}
}

async function collectQemuLoad(iteration: number, instance: ChrInstance, moment: string): Promise<void> {
	const started = Date.now();
	try {
		const load = await instance.queryLoad();
		emit({
			phase: "qemu-load",
			iteration,
			moment,
			durationMs: Date.now() - started,
			load,
		});
	} catch (error) {
		emit({
			phase: "qemu-load",
			iteration,
			moment,
			durationMs: Date.now() - started,
			error: errorInfo(error),
		});
	}
}

async function runIteration(iteration: number, arch: Arch): Promise<number> {
	const { QuickCHR } = await import("../../src/lib/quickchr.ts");
	const machineName = `issue69-${process.pid}-${iteration}`;
	const username = `issue69-${iteration}`;
	const password = `issue69-password-${Date.now()}-${iteration}`;
	let instance: ChrInstance | undefined;
	let observedProblems = 0;

	emit({ phase: "iteration-start", iteration, machineName, username });

	try {
		await cleanupMachine(machineName);
		const startStarted = Date.now();
		try {
			instance = await QuickCHR.start({
				...imageTarget(),
				arch,
				background: true,
				name: machineName,
				secureLogin: false,
				onProgress: (message) => emit({ phase: "quickchr-progress", iteration, message }),
			});
		} catch (error) {
			emit({
				phase: "started",
				iteration,
				ok: false,
				durationMs: Date.now() - startStarted,
				error: errorInfo(error),
			});
			throw error;
		}
		emit({
			phase: "started",
			iteration,
			ok: true,
			durationMs: Date.now() - startStarted,
			instance: instanceMeta(instance),
		});

		await collectQemuLoad(iteration, instance, "before-create-user");

		const tcpLoop = startTcpProbeLoop(
			iteration,
			{
				http: instance.ports.http,
				api: instance.ports.api,
				ssh: instance.ports.ssh,
				winbox: instance.ports.winbox,
			},
			250,
		);

		try {
			const createStarted = Date.now();
			try {
				await createUser(instance.ports.http, username, password);
				emit({ phase: "create-user", iteration, ok: true, durationMs: Date.now() - createStarted });
			} catch (error) {
				observedProblems++;
				emit({
					phase: "create-user",
					iteration,
					ok: false,
					durationMs: Date.now() - createStarted,
					error: errorInfo(error),
				});
			}

			const baseUrl = `http://127.0.0.1:${instance.ports.http}/rest`;
			const newUserAuth = basicAuth(username, password);
			const adminAuth = basicAuth("admin", "");

			const firstNewUserResults = await restProbeWithImmediateResetRetry(
				iteration,
				baseUrl,
				newUserAuth,
				"new-user-resource",
				"system/resource",
				username,
			);
			if (firstAttemptHasProblem(firstNewUserResults)) observedProblems++;

			const newUserListResults = await restProbeWithImmediateResetRetry(
				iteration,
				baseUrl,
				newUserAuth,
				"new-user-user-list",
				"user",
				username,
			);
			if (firstAttemptHasProblem(newUserListResults)) observedProblems++;

			const adminResults = await restProbeWithImmediateResetRetry(
				iteration,
				baseUrl,
				adminAuth,
				"admin-resource",
				"system/resource",
				"admin",
			);
			if (firstAttemptHasProblem(adminResults)) observedProblems++;

			await Bun.sleep(5_000);
			const settledResults = await restProbeWithImmediateResetRetry(
				iteration,
				baseUrl,
				newUserAuth,
				"new-user-resource-after-5s",
				"system/resource",
				username,
			);
			if (firstAttemptHasProblem(settledResults)) observedProblems++;
		} finally {
			await tcpLoop.stop();
		}

		await collectQemuLoad(iteration, instance, "after-rest-probes");
		await collectConsoleDiagnostics(iteration, instance);
		collectMachineFileDiagnostics(iteration, instance);
	} finally {
		if (instance) {
			try { await instance.stop(); } catch { /* ignore */ }
		}
		await cleanupMachine(machineName);
	}

	emit({ phase: "iteration-end", iteration, observedProblems });
	return observedProblems;
}

describe.skipIf(SKIP)("issue #69 first-new-credential settling probe", () => {
	test("records first new-user REST behavior after createUser()", async () => {
		const arch = targetArch();
		const iterations = iterationCount();
		emit({
			phase: "probe-start",
			outputPath: OUTPUT_PATH,
			iterations,
			meta: await platformMeta(arch),
		});

		let observedProblems = 0;
		for (let iteration = 1; iteration <= iterations; iteration++) {
			try {
				observedProblems += await runIteration(iteration, arch);
			} catch (error) {
				observedProblems++;
				emit({ phase: "iteration-error", iteration, error: errorInfo(error) });
			}
		}

		emit({ phase: "probe-end", iterations, observedProblems });
		expect(observedProblems, `issue #69 probe details: ${OUTPUT_PATH}`).toBe(0);
	}, 5_400_000);
});
