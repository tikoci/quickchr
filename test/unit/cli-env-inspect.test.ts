import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { saveInstanceCredentials, STORED_IN_SECRETS_PASSWORD } from "../../src/lib/credentials.ts";
import type { MachineState } from "../../src/lib/types.ts";

const TEST_DIR = join(import.meta.dir, ".tmp-cli-env-inspect-test");
const CLI = join(import.meta.dir, "../../src/cli/index.ts");
const originalHome = process.env.HOME;

function machineState(name: string, status: MachineState["status"]): MachineState {
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
		user: { name: "api-user", password: "secret" },
		secureLogin: true,
		portBase: 19100,
		excludePorts: [],
		extraPorts: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		lastStartedAt: status === "running" ? "2026-01-01T00:01:00.000Z" : undefined,
		status,
		pid: status === "running" ? process.pid : undefined,
		machineDir,
	};
}

function writeMachine(state: MachineState): void {
	mkdirSync(state.machineDir, { recursive: true });
	writeFileSync(join(state.machineDir, "machine.json"), JSON.stringify(state, null, "\t") + "\n");
}

async function runQuickchr(args: string[]) {
	const proc = Bun.spawn(["bun", CLI, ...args], {
		env: {
			...process.env,
			QUICKCHR_DATA_DIR: TEST_DIR,
			NO_COLOR: "1",
			QUICKCHR_NO_PROMPT: "1",
			HOME: TEST_DIR,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

beforeEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.HOME = TEST_DIR;
});

afterEach(() => {
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("CLI env/inspect descriptors", () => {
	test("inspect --json prints the v1 descriptor via the CLI binary", async () => {
		writeMachine(machineState("router", "running"));

		const result = await runQuickchr(["inspect", "router", "--json"]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		const descriptor = JSON.parse(result.stdout);
		expect(descriptor).toMatchObject({
			descriptorVersion: 1,
			name: "router",
			status: "running",
			version: "7.22.1",
			arch: "x86",
			services: {
				// Plain-first (#95): stock-CHR TLS services are not dialable, so the
				// descriptor advertises the plain forwards.
				"rest-api": { available: true, tls: false, port: 19100 },
				"native-api": { available: true, tls: false, port: 19103 },
				ssh: { available: true, tls: false, port: 19102 },
			},
		});
		expect(descriptor.quickchr).toHaveProperty("packageVersion");
		expect(descriptor.services["rest-api"].auth.basic).toBe("api-user:secret");
		expect(descriptor.services["rest-api"].auth.header).toMatch(/^Basic /);
		expect(descriptor.customForwards).toEqual([{ name: "winbox", transport: "tcp", host: "127.0.0.1", hostPort: 19105, guestPort: 8291 }]);
		expect(descriptor.lastStartedAt).toBe("2026-01-01T00:01:00.000Z");
	});

	test("env prints subprocess environment for a running machine (decoupled from descriptor())", async () => {
		writeMachine(machineState("router", "running"));

		const result = await runQuickchr(["env", "router"]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("QUICKCHR_NAME=router\n");
		expect(result.stdout).toContain("QUICKCHR_REST_BASE=http://127.0.0.1:19100/rest\n");
		expect(result.stdout).toContain("BASICAUTH=api-user:secret\n");
	});

	test("descriptor resolves persisted secret placeholders from instance credentials", async () => {
		const state = machineState("router", "running");
		state.user = { name: "api-user", password: STORED_IN_SECRETS_PASSWORD };
		writeMachine(state);
		saveInstanceCredentials("router", "api-user", "from-store");

		const result = await runQuickchr(["inspect", "router", "--json"]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		const descriptor = JSON.parse(result.stdout);
		expect(descriptor.services["rest-api"].auth).toMatchObject({
			username: "api-user",
			password: "from-store",
			basic: "api-user:from-store",
		});
	});

	test("inspect refuses stopped machines with a clean error", async () => {
		writeMachine(machineState("stopped-router", "stopped"));

		const result = await runQuickchr(["inspect", "stopped-router", "--json"]);

		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("Error [MACHINE_STOPPED]");
		expect(result.stderr).toContain("must be running");
		expect(result.stderr).toContain("current status: stopped");
	});

	test("env also refuses stopped machines (subprocessEnv() has no guard of its own)", async () => {
		writeMachine(machineState("stopped-router", "stopped"));

		const result = await runQuickchr(["env", "stopped-router"]);

		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("Error [MACHINE_STOPPED]");
		expect(result.stderr).toContain("must be running");
	});
});
