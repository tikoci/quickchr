import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scpOptions } from "../../src/lib/quickchr.ts";
import { saveInstanceCredentials, STORED_IN_SECRETS_PASSWORD } from "../../src/lib/credentials.ts";
import type { MachineState } from "../../src/lib/types.ts";

/**
 * Which key SCP offers (#229). RouterOS refuses password login for a user with a key,
 * so the managed `quickchr` user needs its key — but only that user: with
 * `IdentitiesOnly=yes`, attaching it to anyone else hides their own keys.
 */

const TEST_DIR = join(import.meta.dir, ".tmp-scp-options");
const NAME = "scp-options";
const origEnv = { dataDir: process.env.QUICKCHR_DATA_DIR, home: process.env.HOME };

function seedState(overrides: Partial<MachineState> = {}): MachineState {
	const dir = join(TEST_DIR, "machines", NAME);
	mkdirSync(join(dir, "ssh"), { recursive: true });
	const keyPath = join(dir, "ssh", "id_ed25519");
	writeFileSync(keyPath, "PRIVATE KEY");
	return {
		name: NAME,
		version: "7.25",
		arch: "x86",
		cpu: 1,
		mem: 512,
		networks: [{ specifier: "user", id: "net0" }],
		ports: {},
		packages: [],
		user: { name: "quickchr", password: "GeneratedPass1" },
		secureLogin: true,
		managedSshKey: { privateKeyPath: keyPath, algorithm: "ed25519", batchVerified: true },
		portBase: 9100,
		excludePorts: [],
		extraPorts: [],
		createdAt: new Date().toISOString(),
		status: "running",
		machineDir: dir,
		...overrides,
	};
}

beforeEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.QUICKCHR_DATA_DIR = TEST_DIR;
	// Keep the real credential store out of it (secrets.ts resolves HOME at call time).
	process.env.HOME = join(TEST_DIR, "home");
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	if (origEnv.dataDir !== undefined) process.env.QUICKCHR_DATA_DIR = origEnv.dataDir;
	else delete process.env.QUICKCHR_DATA_DIR;
	if (origEnv.home !== undefined) process.env.HOME = origEnv.home;
	else delete process.env.HOME;
});

describe("scpOptions (#229)", () => {
	test("the managed user gets its key and an empty ssh_config", async () => {
		const state = seedState();
		const opts = await scpOptions(state, 9102);
		expect(opts).toMatchObject({ sshPort: 9102, user: "quickchr", password: "GeneratedPass1" });
		expect(opts.identityFile).toBe(state.managedSshKey?.privateKeyPath);
		expect(opts.sshConfigFile).toBeDefined();
		expect(readFileSync(opts.sshConfigFile as string, "utf8")).toBe("");
	});

	test("stored credentials for another user do not get the managed key", async () => {
		const state = seedState({ user: { name: "quickchr", password: STORED_IN_SECRETS_PASSWORD } });
		saveInstanceCredentials(NAME, "ops", "OpsPass1");
		const opts = await scpOptions(state, 9102);
		expect(opts.user).toBe("ops");
		expect(opts.identityFile).toBeUndefined();
		expect(opts.sshConfigFile).toBeUndefined();
	});

	test("a missing key file falls back to the password alone", async () => {
		const state = seedState();
		rmSync(state.managedSshKey?.privateKeyPath as string);
		const opts = await scpOptions(state, 9102);
		expect(opts.identityFile).toBeUndefined();
		expect(opts.user).toBe("quickchr");
	});

	test("a machine without a managed key is unchanged: factory admin, no key", async () => {
		const opts = await scpOptions(seedState({ user: undefined, managedSshKey: undefined, secureLogin: undefined }), 9102);
		expect(opts).toEqual({ sshPort: 9102, user: "admin", password: "" });
	});
});
