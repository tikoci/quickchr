import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { licenseFromStartFlags, parseFlags } from "../../src/cli/index.ts";
import { getStoredCredentials } from "../../src/lib/credentials.ts";
import { QuickCHR } from "../../src/lib/quickchr.ts";
import { saveMachine } from "../../src/lib/state.ts";
import type { ChrInstance, MachineState } from "../../src/lib/types.ts";

/**
 * The OS keychain (`Bun.secrets`: macOS Keychain, libsecret, Windows Credential
 * Manager) is the *last* fallback for MikroTik.com credentials, and a read can raise an
 * authorization or unlock dialog that hangs an agent or CI caller. The guarantee these
 * tests hold: explicit credentials (flags / LicenseOptions) or both MIKROTIK_WEB_* env
 * vars never reach it, and a lookup that does reach it happens once per start, not once
 * before the boot and again at the license step (#261).
 *
 * Every `Bun.secrets.get` call is recorded and answered with null, so a test can never
 * read — or block on — the developer's real keychain.
 */

const HAS_BUN_SECRETS = typeof Bun !== "undefined" && Bun.secrets != null;
const TEST_DIR = join(import.meta.dir, ".tmp-license-keychain");
const saved = {
	QUICKCHR_DATA_DIR: process.env.QUICKCHR_DATA_DIR,
	HOME: process.env.HOME,
	MIKROTIK_WEB_ACCOUNT: process.env.MIKROTIK_WEB_ACCOUNT,
	MIKROTIK_WEB_PASSWORD: process.env.MIKROTIK_WEB_PASSWORD,
};

let keychainReads: string[] = [];
let spy: ReturnType<typeof spyOn> | null = null;

beforeEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.QUICKCHR_DATA_DIR = TEST_DIR;
	process.env.HOME = join(TEST_DIR, "home");
	delete process.env.MIKROTIK_WEB_ACCOUNT;
	delete process.env.MIKROTIK_WEB_PASSWORD;
	keychainReads = [];
	if (HAS_BUN_SECRETS) {
		spy = spyOn(Bun.secrets, "get").mockImplementation(async (opts: { service: string; name: string }) => {
			keychainReads.push(`${opts.service}/${opts.name}`);
			return null;
		});
	}
});

afterEach(() => {
	spy?.mockRestore();
	spy = null;
	rmSync(TEST_DIR, { recursive: true, force: true });
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function setEnvPair(): void {
	process.env.MIKROTIK_WEB_ACCOUNT = "env@example.com";
	process.env.MIKROTIK_WEB_PASSWORD = "env-pw";
}

describe.skipIf(!HAS_BUN_SECRETS)("MikroTik.com credentials never reach the keychain when flags or env supply them", () => {
	test("getStoredCredentials: both env vars answer without a keychain read", async () => {
		setEnvPair();
		expect(await getStoredCredentials()).toEqual({ account: "env@example.com", password: "env-pw" });
		expect(keychainReads).toEqual([]);
	});

	test("getStoredCredentials: a single env var is not a pair, so the keychain is the fallback", async () => {
		// The boundary, stated: half an env pair does not short-circuit.
		process.env.MIKROTIK_WEB_ACCOUNT = "env@example.com";
		expect(await getStoredCredentials()).toBeNull();
		expect(keychainReads.length).toBeGreaterThan(0);
	});

	test("start's flags read env for a missing half, never the keychain", () => {
		process.env.MIKROTIK_WEB_PASSWORD = "env-pw";
		expect(licenseFromStartFlags(parseFlags(["--license-level", "p10", "--license-account", "a@example.com"]).flags))
			.toEqual({ account: "a@example.com", password: "env-pw", level: "p10" });
		expect(() => licenseFromStartFlags(parseFlags(["--license-password", "pw"]).flags)).toThrow(/MIKROTIK_WEB_ACCOUNT/);
		expect(keychainReads).toEqual([]);
	});

	describe("the license provisioning step", () => {
		let server: Server | null = null;
		afterEach(() => {
			server?.close();
			server = null;
		});

		async function licenseServer(): Promise<number> {
			let level = "free";
			return new Promise((resolve) => {
				server = createServer((req, res) => {
					res.writeHead(200, { "Content-Type": "application/json" });
					if (req.url?.includes("/renew")) {
						level = "p1";
						res.end(JSON.stringify([{ ".section": "0", status: "connecting" }, { ".section": "1", status: "done" }]));
						return;
					}
					res.end(JSON.stringify({ level, "system-id": "TEST" }));
				});
				server.listen(0, "127.0.0.1", () => {
					const address = server?.address();
					resolve(typeof address === "object" && address ? address.port : 0);
				});
			});
		}

		function state(port: number): MachineState {
			return {
				name: "keychain-provision",
				version: "7.24.5",
				arch: "x86",
				cpu: 1,
				mem: 512,
				networks: [],
				ports: { http: { name: "http", host: port, guest: 80, proto: "tcp" } },
				packages: [],
				portBase: port,
				excludePorts: [],
				extraPorts: [],
				createdAt: "2026-01-01T00:00:00.000Z",
				status: "running",
				machineDir: join(TEST_DIR, "machines", "keychain-provision"),
			};
		}

		test("explicit credentials: no keychain read", async () => {
			const port = await licenseServer();
			await QuickCHR._provisionInstance({} as ChrInstance, state(port), {
				license: { account: "a@example.com", password: "pw", level: "p1" },
			}, {} as never);
			expect(keychainReads).toEqual([]);
		}, 30_000);

		test("a level alone with both env vars set: no keychain read", async () => {
			setEnvPair();
			const port = await licenseServer();
			await QuickCHR._provisionInstance({} as ChrInstance, state(port), { license: "p1" }, {} as never);
			expect(keychainReads).toEqual([]);
		}, 30_000);
	});

	test("a start that must use the keychain reads it once, before any boot", async () => {
		// add-recorded intent, no flags, no env: the pre-boot resolution is the only
		// lookup (one read per field), and its refusal comes before QEMU is touched.
		saveMachine({
			name: "keychain-once",
			version: "7.24.5",
			arch: "x86",
			cpu: 1,
			mem: 512,
			networks: [{ specifier: "user", id: "net0" }],
			ports: {},
			packages: [],
			portBase: 9130,
			excludePorts: [],
			extraPorts: [],
			createdAt: "2026-01-01T00:00:00.000Z",
			status: "stopped",
			machineDir: join(TEST_DIR, "machines", "keychain-once"),
			license: "p10",
		});
		await expect(QuickCHR.start({ name: "keychain-once" })).rejects.toMatchObject({ code: "PROCESS_FAILED" });
		expect(keychainReads).toEqual(["com.quickchr.mikrotik-web/account", "com.quickchr.mikrotik-web/password"]);
	});
});
