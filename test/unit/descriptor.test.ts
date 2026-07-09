import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import packageJson from "../../package.json";
import { QuickCHR } from "../../src/lib/quickchr.ts";
import type { MachineState } from "../../src/lib/types.ts";
import { QUICKCHR_DESCRIPTOR_VERSION } from "../../src/lib/types.ts";

const TEST_DIR = join(import.meta.dir, ".tmp-descriptor-test");
const originalDataDir = process.env.QUICKCHR_DATA_DIR;

function baseState(name: string, overrides: Partial<MachineState> = {}): MachineState {
	const machineDir = join(TEST_DIR, "machines", name);
	return {
		name,
		version: "7.22.1",
		arch: "x86",
		cpu: 1,
		mem: 512,
		networks: [{ specifier: "user", id: "net0" }],
		ports: {
			http: { name: "http", host: 19100, guest: 80, proto: "tcp" },
			https: { name: "https", host: 19101, guest: 443, proto: "tcp" },
			ssh: { name: "ssh", host: 19102, guest: 22, proto: "tcp" },
			api: { name: "api", host: 19103, guest: 8728, proto: "tcp" },
			"api-ssl": { name: "api-ssl", host: 19104, guest: 8729, proto: "tcp" },
			winbox: { name: "winbox", host: 19105, guest: 8291, proto: "tcp" },
		},
		packages: [],
		user: { name: "quickchr", password: "secret" },
		secureLogin: true,
		portBase: 19100,
		excludePorts: [],
		extraPorts: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		lastStartedAt: "2026-01-01T00:01:00.000Z",
		status: "running",
		pid: process.pid,
		machineDir,
		...overrides,
	};
}

function writeMachine(state: MachineState): void {
	mkdirSync(state.machineDir, { recursive: true });
	writeFileSync(join(state.machineDir, "machine.json"), JSON.stringify(state, null, "\t") + "\n");
}

beforeEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.QUICKCHR_DATA_DIR = TEST_DIR;
});

afterEach(() => {
	if (originalDataDir === undefined) {
		delete process.env.QUICKCHR_DATA_DIR;
	} else {
		process.env.QUICKCHR_DATA_DIR = originalDataDir;
	}
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("descriptor() — v1 shape", () => {
	test("descriptorVersion + quickchr.packageVersion present, no apiVersion", async () => {
		writeMachine(baseState("router"));
		const instance = QuickCHR.get("router");
		expect(instance).not.toBeNull();
		const descriptor = await instance?.descriptor();
		expect(descriptor?.descriptorVersion).toBe(QUICKCHR_DESCRIPTOR_VERSION);
		expect(descriptor?.quickchr).toEqual({ packageVersion: packageJson.version });
		expect(descriptor).not.toHaveProperty("apiVersion");
		expect(descriptor?.status).toBe("running");
	});

	test("survives an injected unknown field (additive-only forward-compat)", async () => {
		writeMachine(baseState("router"));
		const descriptor = await QuickCHR.get("router")?.descriptor();
		const roundTripped = JSON.parse(JSON.stringify({ ...descriptor, futureField: "centrs-can-ignore-this" }));
		expect(roundTripped.futureField).toBe("centrs-can-ignore-this");
		expect(roundTripped.descriptorVersion).toBe(QUICKCHR_DESCRIPTOR_VERSION);
		expect(roundTripped.services["rest-api"].available).toBe(true);
	});

	test("rest-api and native-api prefer the secure port and report tls correctly", async () => {
		writeMachine(baseState("router"));
		const descriptor = await QuickCHR.get("router")?.descriptor();
		const restApi = descriptor?.services["rest-api"];
		const nativeApi = descriptor?.services["native-api"];
		expect(restApi?.available).toBe(true);
		if (restApi?.available) {
			expect(restApi.tls).toBe(true);
			expect(restApi.port).toBe(19101);
			expect(restApi.transport).toBe("tcp");
			expect(restApi.url).toBe("https://127.0.0.1:19101/rest");
			expect(restApi.auth?.username).toBe("quickchr");
		}
		expect(nativeApi?.available).toBe(true);
		if (nativeApi?.available) {
			expect(nativeApi.tls).toBe(true);
			expect(nativeApi.port).toBe(19104);
			expect(nativeApi.url).toBe("tls://127.0.0.1:19104");
		}
	});

	test("ssh service reports host/port/transport with tls:false", async () => {
		writeMachine(baseState("router"));
		const descriptor = await QuickCHR.get("router")?.descriptor();
		const ssh = descriptor?.services.ssh;
		expect(ssh?.available).toBe(true);
		if (ssh?.available) {
			expect(ssh.tls).toBe(false);
			expect(ssh.port).toBe(19102);
			expect(ssh.host).toBe("127.0.0.1");
		}
	});

	test("http excluded, https kept: rest-api falls back to the secure port (excludePorts fix)", async () => {
		const state = baseState("router");
		delete (state.ports as Record<string, unknown>).http;
		state.excludePorts = ["http"];
		writeMachine(state);
		const descriptor = await QuickCHR.get("router")?.descriptor();
		const restApi = descriptor?.services["rest-api"];
		expect(restApi?.available).toBe(true);
		if (restApi?.available) {
			expect(restApi.tls).toBe(true);
			expect(restApi.port).toBe(19101);
		}
	});

	test("both rest-api ports excluded: available:false with a stable reason", async () => {
		const state = baseState("router");
		delete (state.ports as Record<string, unknown>).http;
		delete (state.ports as Record<string, unknown>).https;
		state.excludePorts = ["http", "https"];
		writeMachine(state);
		const descriptor = await QuickCHR.get("router")?.descriptor();
		const restApi = descriptor?.services["rest-api"];
		expect(restApi?.available).toBe(false);
		if (!restApi?.available) {
			expect(restApi?.unavailableReason).toBe("no forwarded port for rest-api");
		}
	});

	test("disableAdmin with no provisioned user: rest-api/native-api available:false", async () => {
		const state = baseState("router", { disableAdmin: true, user: undefined });
		writeMachine(state);
		const descriptor = await QuickCHR.get("router")?.descriptor();
		const restApi = descriptor?.services["rest-api"];
		const nativeApi = descriptor?.services["native-api"];
		expect(restApi?.available).toBe(false);
		if (!restApi?.available) expect(restApi?.unavailableReason).toBe("admin disabled, no user provisioned");
		expect(nativeApi?.available).toBe(false);
		// SSH availability is about the forwarded port, not credentials — the port
		// still exists, so ssh itself stays available even though passwordAvailable
		// should now be false.
		const ssh = descriptor?.services.ssh;
		expect(ssh?.available).toBe(true);
		if (ssh?.available) expect(ssh.auth.passwordAvailable).toBe(false);
	});

	test("disableAdmin with a provisioned user: rest-api/native-api stay available", async () => {
		const state = baseState("router", { disableAdmin: true, user: { name: "quickchr", password: "secret" } });
		writeMachine(state);
		const descriptor = await QuickCHR.get("router")?.descriptor();
		expect(descriptor?.services["rest-api"].available).toBe(true);
		expect(descriptor?.services["native-api"].available).toBe(true);
	});

	test("ssh: verified managed key advertises private-key batch auth", async () => {
		const state = baseState("router", {
			managedSshKey: {
				privateKeyPath: "/tmp/fake/id_ed25519",
				algorithm: "ed25519",
				batchVerified: true,
				verifiedAt: "2026-01-01T00:02:00.000Z",
			},
		});
		writeMachine(state);
		const descriptor = await QuickCHR.get("router")?.descriptor();
		const ssh = descriptor?.services.ssh;
		expect(ssh?.available).toBe(true);
		if (ssh?.available) {
			expect(ssh.auth.batchModes).toEqual(["private-key"]);
			expect(ssh.auth.privateKeyPath).toBe("/tmp/fake/id_ed25519");
			expect(ssh.auth.modes).toContain("private-key");
			expect(ssh.auth.username).toBe("quickchr");
		}
	});

	test("ssh: unverified managed key never advertises batch private-key auth", async () => {
		const state = baseState("router", {
			managedSshKey: {
				privateKeyPath: "/tmp/fake/id_ed25519",
				algorithm: "ed25519",
				batchVerified: false,
			},
		});
		writeMachine(state);
		const descriptor = await QuickCHR.get("router")?.descriptor();
		const ssh = descriptor?.services.ssh;
		expect(ssh?.available).toBe(true);
		if (ssh?.available) {
			expect(ssh.auth.batchModes).toEqual([]);
			expect(ssh.auth.privateKeyPath).toBeUndefined();
			expect(ssh.auth.modes).toContain("password");
		}
	});

	test("ssh: absent managed key (e.g. --no-secure-login) reports no batch modes", async () => {
		const state = baseState("router", { managedSshKey: undefined });
		writeMachine(state);
		const descriptor = await QuickCHR.get("router")?.descriptor();
		const ssh = descriptor?.services.ssh;
		expect(ssh?.available).toBe(true);
		if (ssh?.available) {
			expect(ssh.auth.batchModes).toEqual([]);
			expect(ssh.auth.privateKeyPath).toBeUndefined();
			expect(ssh.auth.modes).not.toContain("private-key");
		}
	});

	test("ssh port excluded: available:false", async () => {
		const state = baseState("router");
		delete (state.ports as Record<string, unknown>).ssh;
		state.excludePorts = ["ssh"];
		writeMachine(state);
		const descriptor = await QuickCHR.get("router")?.descriptor();
		const ssh = descriptor?.services.ssh;
		expect(ssh?.available).toBe(false);
		if (!ssh?.available) expect(ssh?.unavailableReason).toBe("no forwarded port for ssh");
	});

	test("customForwards lists winbox and extra forwards, omitted when empty", async () => {
		const withExtra = baseState("router");
		withExtra.ports.snmp = { name: "snmp", host: 19110, guest: 161, proto: "udp" };
		writeMachine(withExtra);
		const descriptor = await QuickCHR.get("router")?.descriptor();
		expect(descriptor?.customForwards).toEqual(
			expect.arrayContaining([
				{ name: "winbox", transport: "tcp", host: "127.0.0.1", hostPort: 19105, guestPort: 8291 },
				{ name: "snmp", transport: "udp", host: "127.0.0.1", hostPort: 19110, guestPort: 161 },
			]),
		);
	});

	test("customForwards omitted when only the three canonical services are forwarded", async () => {
		const state = baseState("router");
		delete (state.ports as Record<string, unknown>).winbox;
		state.excludePorts = ["winbox"];
		writeMachine(state);
		const descriptor = await QuickCHR.get("router")?.descriptor();
		expect(descriptor?.customForwards).toBeUndefined();
	});

	test("networks mirrors state.networks[].specifier topology", async () => {
		const state = baseState("router", {
			networks: [
				{ specifier: "user", id: "net0" },
				{ specifier: { type: "bridged", iface: "en0" }, id: "net1" },
			],
		});
		writeMachine(state);
		const descriptor = await QuickCHR.get("router")?.descriptor();
		expect(descriptor?.networks).toEqual([
			{ id: "net0", specifier: "user" },
			{ id: "net1", specifier: { type: "bridged", iface: "en0" } },
		]);
	});

	test("stopped machine still throws MACHINE_STOPPED", async () => {
		writeMachine(baseState("stopped-router", { status: "stopped", pid: undefined, lastStartedAt: undefined }));
		const instance = QuickCHR.get("stopped-router");
		expect(instance).not.toBeNull();
		await expect(instance?.descriptor()).rejects.toMatchObject({ code: "MACHINE_STOPPED" });
	});
});
