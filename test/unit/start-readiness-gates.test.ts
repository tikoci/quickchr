import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupAfterBootFailure, QuickCHR } from "../../src/lib/quickchr.ts";
import { loadMachine, saveMachine } from "../../src/lib/state.ts";
import { isProvisioningWindowOpen } from "../../src/lib/provisioning-window.ts";
import {
	assertProvisioningSupportedVersion,
	assertRestAvailable,
	assertRouterOs6Arch,
	isRouterOs6,
} from "../../src/lib/versions.ts";
import { QuickCHRError, type MachineState } from "../../src/lib/types.ts";
import type { BootFailureReport } from "../../src/lib/diagnostics.ts";

/**
 * The refusals around `start()`'s readiness path: `wait: false` (#159), RouterOS 6 as a
 * boot-only target (#182), and a first-boot timeout on an `add()`-created machine
 * resetting instead of deleting it (#182, carried over from #187).
 *
 * Every refusal here is asserted to happen **before any I/O** — no QEMU, no download.
 * The data dir is empty and nothing is cached, so a refusal that came late would
 * surface as MISSING_QEMU or a download attempt instead of the code under test.
 */

const TEST_DIR = join(import.meta.dir, ".tmp-start-readiness-gates");
const origEnv = {
	dataDir: process.env.QUICKCHR_DATA_DIR,
	home: process.env.HOME,
	preserve: process.env.QUICKCHR_PRESERVE_ON_FAILURE,
};

beforeEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.QUICKCHR_DATA_DIR = TEST_DIR;
	process.env.HOME = join(TEST_DIR, "home");
	delete process.env.QUICKCHR_PRESERVE_ON_FAILURE;
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	for (const [key, value] of [
		["QUICKCHR_DATA_DIR", origEnv.dataDir],
		["HOME", origEnv.home],
		["QUICKCHR_PRESERVE_ON_FAILURE", origEnv.preserve],
	] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

async function codeOf(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
	try {
		await promise;
	} catch (e) {
		if (e instanceof QuickCHRError) return { code: e.code, message: e.message };
		throw e;
	}
	throw new Error("expected a QuickCHRError, got a resolved promise");
}

function machineDir(name: string): string {
	return join(TEST_DIR, "machines", name);
}

/** What `add()` writes: never booted, window open. */
function addedRecord(name: string, version: string, extra: Partial<MachineState> = {}): MachineState {
	return {
		name,
		version,
		arch: "x86",
		cpu: 1,
		mem: 512,
		networks: [{ specifier: "user", id: "net0" }],
		ports: {},
		packages: [],
		portBase: 9100,
		excludePorts: [],
		extraPorts: [],
		createdAt: "2026-10-21T00:00:00.000Z",
		status: "stopped",
		machineDir: machineDir(name),
		...extra,
	};
}

function seed(state: MachineState): void {
	mkdirSync(state.machineDir, { recursive: true });
	writeFileSync(join(state.machineDir, "disk.img"), "guest-disk");
	saveMachine(state);
}

/** No machine dir, and no cached image: the refusal ran before any download. */
function nothingCreated(): boolean {
	return !existsSync(join(TEST_DIR, "machines")) && !existsSync(join(TEST_DIR, "cache"));
}

describe("RouterOS 6 version helpers", () => {
	test("isRouterOs6 matches 6.x only", () => {
		expect(isRouterOs6("6.49.23")).toBe(true);
		expect(isRouterOs6("6.43")).toBe(true);
		expect(isRouterOs6("7.6")).toBe(false);
		expect(isRouterOs6("7.24.5")).toBe(false);
		expect(isRouterOs6("16.1")).toBe(false);
	});

	test("provisioning on 6.x is refused as boot-only, not as 'older 7.x'", () => {
		expect(() => assertProvisioningSupportedVersion("6.49.23", "install extra packages")).toThrow(/RouterOS 6 is a best-effort boot-only target/);
		try {
			assertProvisioningSupportedVersion("6.49.23", "install extra packages");
		} catch (e) {
			expect((e as QuickCHRError).code).toBe("PROVISIONING_VERSION_UNSUPPORTED");
			expect((e as QuickCHRError).message).not.toContain("older 7.x");
		}
		// Older 7.x keeps its own message.
		expect(() => assertProvisioningSupportedVersion("7.12.2", "install extra packages")).toThrow(/older 7\.x remains boot-only/);
	});

	test("REST operations on 6.x say 'RouterOS 6: not available' and name the native API", () => {
		expect(() => assertRestAvailable({ name: "lab6", version: "6.49.23" }, "exec")).toThrow(
			/^RouterOS 6: not available — exec uses the REST API.*--quickchr lab6 .*--via native-api --no-validate/,
		);
		expect(() => assertRestAvailable({ name: "lab7", version: "7.24.5" }, "exec")).not.toThrow();
	});

	test("arm64 is refused on 6.x — MikroTik publishes x86 only", () => {
		expect(() => assertRouterOs6Arch("6.49.23", "arm64")).toThrow(/x86 only/);
		expect(() => assertRouterOs6Arch("6.49.23", "x86")).not.toThrow();
		expect(() => assertRouterOs6Arch("7.24.5", "arm64")).not.toThrow();
	});
});

describe("RouterOS 6 refusals happen before download (#182)", () => {
	const v6 = { version: "6.49.23", arch: "x86" as const, name: "lab6" };
	const cases: Array<[string, Record<string, unknown>]> = [
		["add-package", { packages: ["container"] }],
		["install-all-packages", { installAllPackages: true }],
		["add-user", { user: { name: "ops", password: "x" } }],
		["disable-admin", { disableAdmin: true }],
		["secure-login", { secureLogin: true }],
		["device-mode", { deviceMode: { mode: "rose" } }],
		["license", { license: { level: "p1", account: "a", password: "b" } }],
	];

	for (const [label, extra] of cases) {
		test(`start() refuses --${label} on 6.x`, async () => {
			const result = await codeOf(QuickCHR.start({ ...v6, ...extra }));
			expect(result.code).toBe("PROVISIONING_VERSION_UNSUPPORTED");
			expect(result.message).toContain("boot-only");
			expect(nothingCreated()).toBe(true);
		});

		test(`add() refuses --${label} on 6.x`, async () => {
			const result = await codeOf(QuickCHR.add({ ...v6, ...extra }));
			expect(result.code).toBe("PROVISIONING_VERSION_UNSUPPORTED");
			expect(nothingCreated()).toBe(true);
		});
	}

	test("start() and add() refuse arm64 on 6.x", async () => {
		expect((await codeOf(QuickCHR.start({ ...v6, arch: "arm64" }))).code).toBe("INVALID_ARCH");
		expect((await codeOf(QuickCHR.add({ ...v6, arch: "arm64" }))).code).toBe("INVALID_ARCH");
		expect(nothingCreated()).toBe(true);
	});

	test("existing machines use their recorded architecture rather than creation defaults", async () => {
		seed(addedRecord("lab6", "6.49.23", { status: "running", pid: process.pid }));
		const instance = await QuickCHR.start({ name: "lab6", version: "6.49.23", arch: "arm64" });
		expect(instance.state.arch).toBe("x86");
	});

	test("starting an existing machine by name never resolves a channel over the network", async () => {
		// enbeep hit this: `quickchr start <name>` fetched upgrade.mikrotik.com for
		// the stable channel before loading the machine, and hung when it was slow.
		seed(addedRecord("lab7", "7.25", { status: "running", pid: process.pid }));
		const originalFetch = globalThis.fetch;
		let fetches = 0;
		globalThis.fetch = Object.assign(
			async () => {
				fetches++;
				throw new Error("network blocked in this test");
			},
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;
		try {
			const instance = await QuickCHR.start({ name: "lab7" });
			expect(instance.state.version).toBe("7.25");
			const viaChannel = await QuickCHR.start({ name: "lab7", channel: "testing" });
			expect(viaChannel.state.version).toBe("7.25");
		} finally {
			globalThis.fetch = originalFetch;
		}
		expect(fetches).toBe(0);
	});

	test("an existing 6.x machine given provisioning options is refused before it boots", async () => {
		seed(addedRecord("lab6", "6.49.23"));
		const result = await codeOf(QuickCHR.start({ name: "lab6", packages: ["container"] }));
		expect(result.code).toBe("PROVISIONING_VERSION_UNSUPPORTED");
		const after = loadMachine("lab6") as MachineState;
		expect(after.lastStartedAt).toBeUndefined();
		expect(after.pid).toBeUndefined();
	});

	test("a booted 6.x machine is refused on version, not sent to `quickchr clean` by the window check", async () => {
		seed(addedRecord("lab6", "6.49.23", { lastStartedAt: "2026-10-21T00:01:00.000Z" }));
		const result = await codeOf(QuickCHR.start({ name: "lab6", user: { name: "ops", password: "pw" } }));
		expect(result.code).toBe("PROVISIONING_VERSION_UNSUPPORTED");
		expect(result.message).not.toContain("quickchr clean");
	});

	test("a 6.x instance refuses rest() and REST exec(), and its descriptor has no rest-api", async () => {
		seed(addedRecord("lab6", "6.49.23", { status: "running", pid: process.pid, ports: { http: { name: "http", host: 9100, guest: 80, proto: "tcp" }, api: { name: "api", host: 9103, guest: 8728, proto: "tcp" } } }));
		const instance = QuickCHR.get("lab6");
		if (!instance) throw new Error("seeded machine did not load");
		expect((await codeOf(instance.rest("/system/resource"))).code).toBe("REST_UNAVAILABLE");
		expect((await codeOf(instance.exec("/system/resource/print"))).code).toBe("REST_UNAVAILABLE");
		expect((await codeOf(instance.exec("/system/resource/print", { via: "rest" }))).code).toBe("REST_UNAVAILABLE");
		const descriptor = await instance.descriptor();
		expect(descriptor.services["rest-api"]?.available).toBe(false);
		expect(descriptor.services["native-api"]?.available).toBe(true);
	});

	test("the post-boot set routes refuse 6.x", async () => {
		seed(addedRecord("lab6", "6.49.23", { status: "running", pid: process.pid, lastStartedAt: "2026-10-21T00:01:00.000Z" }));
		const instance = QuickCHR.get("lab6");
		if (!instance) throw new Error("seeded machine did not load");
		expect((await codeOf(instance.setDeviceMode({ mode: "rose" }))).code).toBe("PROVISIONING_VERSION_UNSUPPORTED");
		expect((await codeOf(instance.license({ level: "p1", account: "a", password: "b" }))).code).toBe("PROVISIONING_VERSION_UNSUPPORTED");
		expect((await codeOf(instance.installPackage("container"))).code).toBe("PROVISIONING_VERSION_UNSUPPORTED");
	});
});

describe("wait: false (#159)", () => {
	test("refused with provisioning, before download", async () => {
		const result = await codeOf(QuickCHR.start({ version: "7.24.5", arch: "x86", name: "nw", wait: false, packages: ["container"] }));
		expect(result.code).toBe("INVALID_ARGUMENT");
		expect(result.message).toContain("--no-wait");
		expect(result.message).toContain("install extra packages");
		expect(nothingCreated()).toBe(true);
	});

	test("foreground/no-wait is refused before version validation or channel resolution", async () => {
		for (const version of [undefined, "not-a-version"]) {
			const result = await codeOf(QuickCHR.start({ version, name: "nw", wait: false, background: false }));
			expect(result.code).toBe("INVALID_ARGUMENT");
			expect(result.message).toContain("--fg");
		}
		expect(nothingCreated()).toBe(true);
	});

	test("refused with background: false", async () => {
		const result = await codeOf(QuickCHR.start({ version: "7.24.5", arch: "x86", name: "nw", wait: false, background: false }));
		expect(result.code).toBe("INVALID_ARGUMENT");
		expect(result.message).toContain("--fg");
		expect(nothingCreated()).toBe(true);
	});

	test("refused on a first boot that has provisioning add() recorded, which the caller did not retype", async () => {
		seed(addedRecord("nw", "7.24.5", { installAllPackages: true }));
		const result = await codeOf(QuickCHR.start({ name: "nw", wait: false }));
		expect(result.code).toBe("INVALID_ARGUMENT");
		expect(result.message).toContain(`machine "nw" has first-boot provisioning recorded by 'add'`);
		expect(isProvisioningWindowOpen(loadMachine("nw") as MachineState)).toBe(true);
	});
});

describe("cleanupAfterBootFailure — first-boot timeout (#182)", () => {
	const failure = (preserved: boolean): BootFailureReport => ({ summary: "", reportPath: null, preserved });

	/** An add()-created machine whose first boot launched and then timed out. */
	function seedTimedOutFirstBoot(): { restore: MachineState } {
		const restore = addedRecord("tb", "7.24.5", { packages: ["container"], secureLogin: true });
		seed({ ...restore, lastStartedAt: "2026-10-21T00:01:00.000Z", status: "stopped" });
		writeFileSync(join(restore.machineDir, "disk.img"), "guest-wrote-during-stalled-boot");
		const cacheDir = join(TEST_DIR, "cache");
		mkdirSync(cacheDir, { recursive: true });
		writeFileSync(join(cacheDir, "chr-7.24.5.img"), "fresh-factory-image");
		return { restore };
	}

	test("an add()-created machine is reset, not removed — the retry is `start` again", async () => {
		const { restore } = seedTimedOutFirstBoot();
		const instance = QuickCHR.get("tb");
		if (!instance) throw new Error("seeded machine did not load");
		const message = await cleanupAfterBootFailure(instance, "tb", failure(false), { kind: "reset-first-boot", restore });

		const after = loadMachine("tb") as MachineState;
		expect(after).toBeDefined();
		expect(isProvisioningWindowOpen(after)).toBe(true);
		expect(after.packages).toEqual(["container"]);
		expect(after.secureLogin).toBe(true);
		expect(readFileSync(join(restore.machineDir, "disk.img"), "utf-8")).toBe("fresh-factory-image");
		expect(message).toContain("reset to its never-booted state");
		expect(message).toContain("quickchr start tb");
		expect(message).toContain("QUICKCHR_PRESERVE_ON_FAILURE=1");
	});

	test("without a restore record the machine is removed, and the message names the preserve knob", async () => {
		seedTimedOutFirstBoot();
		const instance = QuickCHR.get("tb");
		if (!instance) throw new Error("seeded machine did not load");
		const message = await cleanupAfterBootFailure(instance, "tb", failure(false), { kind: "remove-new" });
		expect(loadMachine("tb")).toBeUndefined();
		expect(message).toContain("cleaned up automatically");
		expect(message).toContain("QUICKCHR_PRESERVE_ON_FAILURE=1");
	});

	test("preserved means untouched, and the message offers the reset for an add() machine", async () => {
		const { restore } = seedTimedOutFirstBoot();
		const instance = QuickCHR.get("tb");
		if (!instance) throw new Error("seeded machine did not load");
		const message = await cleanupAfterBootFailure(instance, "tb", failure(true), { kind: "reset-first-boot", restore });
		expect(readFileSync(join(restore.machineDir, "disk.img"), "utf-8")).toBe("guest-wrote-during-stalled-boot");
		expect((loadMachine("tb") as MachineState).lastStartedAt).toBeDefined();
		expect(message).toContain("quickchr clean tb");
		expect(message).toContain("quickchr remove tb");
	});
});

describe("boot-timeout launch routing (#189)", () => {
	for (const kind of ["new", "first", "configured", "legacy"]) {
		for (const preserve of [false, true]) {
			test(`${kind}, preserve override ${preserve}`, async () => {
				const proc = Bun.spawn([process.execPath, join(import.meta.dir, "helpers/boot-timeout-worker.ts"), kind, preserve ? "preserve" : "default"], {
					env: { ...process.env, QUICKCHR_PRESERVE_ON_FAILURE: preserve ? "1" : undefined },
					stdout: "pipe", stderr: "pipe",
				});
				const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
				expect({ exit, output: stdout + stderr }).toEqual({ exit: 0, output: "" });
			});
		}
	}
});

describe("continue BOOT_TIMEOUT keeps the machine stopped and preserved (#214)", () => {
	test("a resumed guest that never reaches REST is stopped, not removed", async () => {
		// Explicit env: Bun.spawn without it does not see runtime process.env
		// mutations (verified 1.4.4), so the worker would use the real data dir.
		const proc = Bun.spawn([process.execPath, join(import.meta.dir, "helpers/continue-timeout-worker.ts")], {
			env: { ...process.env },
			stdout: "pipe", stderr: "pipe",
		});
		const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		expect({ exit, output: stdout + stderr }).toEqual({ exit: 0, output: "" });
	});
});

describe("continue reuses the frozen launch's recorded accelerator (#214)", () => {
	test("a recorded lastAccel wins over fresh detection", async () => {
		// Explicit env, same as above: without it the worker lands in the
		// real data dir and collides with other runs on its monitor socket.
		const proc = Bun.spawn([process.execPath, join(import.meta.dir, "helpers/continue-accel-worker.ts")], {
			env: { ...process.env },
			stdout: "pipe", stderr: "pipe",
		});
		const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		expect({ exit, output: stdout + stderr }).toEqual({ exit: 0, output: "" });
	});
});
